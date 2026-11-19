#!/usr/bin/env node
/**
 * 桥接服务主入口：HTTP 服务、路由、静态站点、token 注入、SSE、写任务串行队列。
 *
 * 硬性约束：
 *   - 只监听回环（默认 127.0.0.1:8792）；Host 头校验防 DNS rebinding（07 §3）。
 *   - 统一 envelope `{schemaVersion:1,generatedAt,ok,data?,error?}`（05 §2）。
 *   - `/api/doctor` 与 `/api/logs` 默认 `text/plain`（非 envelope）。
 *   - `--read-only` / `--demo` 在**桥接层**拦截写操作（05 §8）。
 *   - 零依赖，只用 node: 内置模块。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { BridgeError, createCli } from './cli.mjs';
import { createGateway, parseCliJson } from './gateway.mjs';
import {
  ACTION_PROVIDER_WHITELIST,
  SCHEMA_VERSION,
  toAccountGroup,
  toGatewayKey,
  toGatewayStatus,
  toGatewayUsage,
  toProviderStatus,
  toQuotaRow,
  toTask,
  toUsageStats,
} from './normalize.mjs';
import { createDemo } from './demo.mjs';
import { createSseHub, openSse } from './sse.mjs';
import { sanitize, sanitizeBounded } from './redact.mjs';

const VERSION = '1.0.0';
const DEFAULT_PORT = 8792;
const DEFAULT_HOST = '127.0.0.1';
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = 8785;
const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const MAX_BODY_BYTES = 64 * 1024;
const DEV_VITE_PORT = 5173;
// 体检：端口探测并发上限与超时（05 §3.10）。
const HEALTH_PROBE_TIMEOUT_MS = 1500;
const HEALTH_PROBE_CONCURRENCY = 4;
// 真实试打比端口探测慢得多，但仍要有界，避免前端一直转圈。
const CHAT_PROBE_TIMEOUT_MS = 20000;
// `/api/env` 的网关可达性只做廉价探测，不拖慢页面首屏。
const GATEWAY_HEALTH_TIMEOUT_MS = 300;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, '..');

const ACTION_NAMES = [
  'Start',
  'Stop',
  'StopKeepOpenCode',
  'Restart',
  'OnlyEnable',
  'Disable',
  'EnableAll',
  'DisableAll',
  'Sync',
  'SwitchAccountPreview',
  'SwitchAccount',
  'EnableAllAccounts',
  'Login',
  'AddAccount',
  'Probe',
  'RefreshModels',
  'RefreshQuota',
];

// 交互式动作不由桥接代执行 stdin（07 §10）。
const MANUAL_ACTIONS = new Set(['Login', 'AddAccount']);
// 交互式动作不等待用户完成，故没有"只读确认"阶段；其余 Action 结束后都要重新查询确认。
const NO_REFRESH_ACTIONS = new Set(['Login', 'AddAccount']);

const USAGE_RANGES = new Set(['24h', '7d', '30d', 'all']);

// ---------------------------------------------------------------- 启动配置

export function parseArgs(argv) {
  const out = { port: null, host: null, routerRoot: null, node: null, demo: false, readOnly: false, dev: false, help: false };
  const take = (i) => argv[i];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : null;
    const value = () => (inline !== null ? inline : take(++i));
    switch (key) {
      case '--router-root':
        out.routerRoot = value();
        break;
      case '--node':
        out.node = value();
        break;
      case '--port':
        out.port = Number(value());
        break;
      case '--host':
        out.host = value();
        break;
      case '--demo':
        out.demo = true;
        break;
      case '--read-only':
      case '--readonly':
        out.readOnly = true;
        break;
      case '--dev':
        out.dev = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        break;
    }
  }
  return out;
}

function hasRouterMjs(dir) {
  try {
    return fs.statSync(path.join(dir, 'router.mjs')).isFile();
  } catch {
    return false;
  }
}

/** 发现优先级：显式参数 > 环境变量 > 当前目录含 router.mjs > 父目录含 router.mjs。 */
export function discoverRoot({ explicit, env, cwd }) {
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  if (env.ROUTER_ROOT) candidates.push(path.resolve(env.ROUTER_ROOT));
  const bases = [cwd, path.dirname(cwd), FRONTEND_ROOT, path.dirname(FRONTEND_ROOT)];
  for (const base of bases) candidates.push(base);
  for (const candidate of candidates) {
    if (candidate && hasRouterMjs(candidate)) return candidate;
  }
  return null;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

function normalizeHostname(raw) {
  let host = String(raw ?? '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host.slice(1);
  }
  const colon = host.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  return host;
}

function isLoopbackHostname(raw) {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(raw));
}

function isLoopbackRemote(addr) {
  const s = String(addr ?? '').toLowerCase();
  if (!s) return false;
  const bare = s.startsWith('::ffff:') ? s.slice(7) : s;
  return bare === '127.0.0.1' || bare === '::1' || bare === '0:0:0:0:0:0:0:1' || bare.startsWith('127.');
}

export function resolveConfig(opts, env = process.env, cwd = process.cwd()) {
  const host = opts.host ?? DEFAULT_HOST;
  if (!isLoopbackHostname(host)) {
    throw new Error(`拒绝监听非回环地址 ${host}：桥接只允许 127.0.0.1 / localhost / ::1`);
  }
  const port = Number.isFinite(opts.port) ? opts.port : Number(env.ROUTER_PANEL_PORT) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`端口非法：${opts.port ?? env.ROUTER_PANEL_PORT}`);

  const demo = Boolean(opts.demo);
  const root = demo ? null : discoverRoot({ explicit: opts.routerRoot, env, cwd });
  const nodeBin = opts.node || env.ROUTER_NODE || 'node';

  return {
    host,
    bindHost: isLoopbackHostname(host) ? (normalizeHostname(host) === '::1' ? '::1' : '127.0.0.1') : DEFAULT_HOST,
    port,
    demo,
    readOnly: Boolean(opts.readOnly),
    dev: Boolean(opts.dev),
    root,
    nodeBin,
    opencode: env.ROUTER_OPENCODE || '',
    gateway: { host: GATEWAY_HOST, port: GATEWAY_PORT },
    cwd,
  };
}

// ---------------------------------------------------------------- envelope 帮助函数

function generatedAt() {
  return new Date().toISOString();
}

function setBaseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendEnvelope(res, httpStatus, payload) {
  const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt: generatedAt(), ...payload });
  res.writeHead(httpStatus, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendOk(res, data, httpStatus = 200) {
  sendEnvelope(res, httpStatus, { ok: true, data });
}

export function sendError(res, httpStatus, code, message, extra = {}) {
  const error = { code, message, retryable: Boolean(extra.retryable) };
  if (extra.provider) error.provider = extra.provider;
  sendEnvelope(res, httpStatus, { ok: false, error });
}

function sendText(res, httpStatus, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(httpStatus, { 'Content-Type': contentType });
  res.end(text);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (buf) => {
      size += buf.length;
      if (size > limit) {
        reject(new BridgeError('BAD_REQUEST', `请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BridgeError('BAD_REQUEST', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function acceptsJson(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('application/json') && !accept.includes('text/plain');
}

// ---------------------------------------------------------------- CLI 单飞 / 微缓存

function createCache() {
  const inflight = new Map();
  const memo = new Map();
  return function cached(key, ttlMs, fn) {
    const now = Date.now();
    const hit = memo.get(key);
    if (hit && now - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve()
      .then(fn)
      .then((value) => {
        memo.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  };
}

function checkSchemaVersion(parsed, label) {
  const v = Number(parsed?.schemaVersion);
  if (Number.isFinite(v) && v > SCHEMA_VERSION) {
    throw new BridgeError('UNSUPPORTED_VERSION', `${label}：schemaVersion ${v} 高于已支持的 ${SCHEMA_VERSION}，请升级面板`);
  }
}

// ---------------------------------------------------------------- 写任务队列

function createActionRunner({ config, cli, gateway, demo, getProviders, emit }) {
  const tasks = new Map();
  const dedupe = new Map();
  const queue = [];
  let running = null;
  let counter = 0;

  function newId() {
    counter += 1;
    return `act_${crypto.randomBytes(4).toString('hex')}${counter.toString(16)}`;
  }

  function validate(body) {
    const action = String(body?.action ?? '');
    if (!ACTION_NAMES.includes(action)) {
      throw new BridgeError('NOT_FOUND', `未知 Action：${action || '(空)'}`);
    }
    const idsRaw = body?.providerIds;
    const providerIds = Array.isArray(idsRaw) ? idsRaw.map((x) => String(x)) : [];
    for (const id of providerIds) {
      if (!ACTION_PROVIDER_WHITELIST.has(id)) {
        throw new BridgeError('NOT_FOUND', `未知 provider：${id}`, { provider: id });
      }
    }
    let accountKey = null;
    if (body?.accountKey !== undefined && body?.accountKey !== null && body?.accountKey !== '') {
      accountKey = String(body.accountKey);
      if (accountKey.length > 128 || /[\u0000-\u001f]/.test(accountKey)) {
        throw new BridgeError('BAD_REQUEST', 'accountKey 非法');
      }
    }
    const needsOne = new Set(['Start', 'Stop', 'StopKeepOpenCode', 'Restart', 'SwitchAccount', 'SwitchAccountPreview', 'EnableAllAccounts', 'Probe']);
    if (needsOne.has(action) && providerIds.length === 0) {
      throw new BridgeError('BAD_REQUEST', `${action} 需要至少一个 provider`);
    }
    const needsMany = new Set(['OnlyEnable', 'Disable']);
    if (needsMany.has(action) && providerIds.length === 0) {
      throw new BridgeError('BAD_REQUEST', `${action} 需要 provider 列表`);
    }
    if ((action === 'SwitchAccount' || action === 'SwitchAccountPreview') && providerIds.length !== 1) {
      throw new BridgeError('BAD_REQUEST', `${action} 只作用于一个 provider`);
    }
    if ((action === 'SwitchAccount' || action === 'SwitchAccountPreview') && !accountKey) {
      throw new BridgeError('BAD_REQUEST', `${action} 需要 accountKey`);
    }
    return { action, providerIds, accountKey, dryRun: body?.dryRun === true };
  }

  function buildInvocation({ action, providerIds, accountKey }) {
    const one = providerIds[0];
    const map = {
      Start: { program: 'router', args: ['up', one, '--no-login'] },
      Stop: { program: 'router', args: ['down', one] },
      StopKeepOpenCode: { program: 'router', args: ['down', one, '--keep-oc'] },
      Restart: { program: 'router', args: ['restart', one, '--no-login'] },
      OnlyEnable: { program: 'router', args: ['on', ...providerIds, '--no-login'] },
      Disable: { program: 'router', args: ['off', ...providerIds] },
      EnableAll: { program: 'router', args: ['all', '--no-login'] },
      DisableAll: { program: 'router', args: ['none'] },
      Sync: { program: 'router', args: ['sync'] },
      SwitchAccountPreview: { program: 'router', args: ['account', one, accountKey, '--dry-run', '--json'] },
      SwitchAccount: { program: 'router', args: ['account', one, accountKey, '--json'] },
      EnableAllAccounts: { program: 'router', args: ['account', one, '--all', '--json'] },
      Probe: { program: 'health', args: providerIds.length ? providerIds : [] },
      RefreshQuota: { program: 'router', args: ['gateway', 'refresh-quota'] },
    };
    if (action === 'RefreshModels') return { program: 'gateway', args: [] };
    if (action === 'Login' || action === 'AddAccount') return { program: 'manual', args: [one] };
    const inv = map[action];
    if (!inv) throw new BridgeError('BAD_REQUEST', `未映射的 Action：${action}`);
    return inv;
  }

  function publicTask(task) {
    return toTask(task);
  }

  function touch(task) {
    emit('task.updated', publicTask(task));
  }

  function finishTask(task, { status, exitCode }) {
    task.status = status;
    task.exitCode = exitCode ?? null;
    task.finishedAt = new Date().toISOString();
    task.child = null;
    emit('task.updated', publicTask(task));
    emit('task.finished', publicTask(task));
    releaseDedupe(task);

    if (status === 'succeeded' && !NO_REFRESH_ACTIONS.has(task.action) && config.demo === false) {
      task.refreshStatus = 'pending';
      emit('refresh.pending', { actionId: task.actionId, action: task.action });
      getProviders()
        .then(() => {
          task.refreshStatus = 'confirmed';
          emit('refresh.confirmed', { actionId: task.actionId, changed: ['providers', 'accounts'] });
          touch(task);
        })
        .catch((err) => {
          task.refreshStatus = 'failed';
          emit('refresh.failed', { actionId: task.actionId, error: err?.code ?? 'BACKEND_UNAVAILABLE' });
          touch(task);
        })
        .finally(() => {
          running = null;
          process.nextTick(drain);
        });
      return;
    }

    if (status === 'succeeded') task.refreshStatus = 'notRequired';
    running = null;
    process.nextTick(drain);
  }

  function releaseDedupe(task) {
    if (task.dedupeKey && dedupe.get(task.dedupeKey) === task.actionId) dedupe.delete(task.dedupeKey);
  }

  function appendOutput(task, stream, chunk) {
    const clean = sanitizeBounded(chunk, { maxLines: MAX_LINES, maxBytes: 256 * 1024, fromTail: true }).text;
    const next = `${task[stream]}${clean}`;
    const bounded = sanitizeBounded(next, { maxLines: MAX_LINES, maxBytes: 256 * 1024, fromTail: true });
    task[stream] = bounded.text;
    if (bounded.truncated) task.truncated = true;
    task.seq += 1;
    emit('task.output', { actionId: task.actionId, stream, seq: task.seq, chunk: clean });
    const now = Date.now();
    if (now - task.lastTouch > 250) {
      task.lastTouch = now;
      touch(task);
    }
  }

  function startTask(task) {
    if (MANUAL_ACTIONS.has(task.action)) {
      task.status = 'running';
      emit('task.started', publicTask(task));
      const id = task.providerIds[0] ?? '';
      const cmd = task.action === 'Login' ? `node router.mjs login ${id}` : `node router.mjs account add ${id}`;
      appendOutput(task, 'stdout', `交互式动作由用户在原生终端完成，面板只等待。\n请在终端执行：${cmd}\n`);
      task.refreshStatus = 'notRequired';
      finishTask(task, { status: 'succeeded', exitCode: 0 });
      return;
    }

    if (task.action === 'RefreshModels') {
      task.status = 'running';
      emit('task.started', publicTask(task));
      gateway
        .refreshModels()
        .then((data) => {
          appendOutput(task, 'stdout', `已清空网关模型缓存（${Array.isArray(data?.models) ? data.models.length : 0} 家）\n`);
          finishTask(task, { status: 'succeeded', exitCode: 0 });
        })
        .catch((err) => {
          appendOutput(task, 'stderr', `${err?.message ?? err}\n`);
          finishTask(task, { status: 'failed', exitCode: 1 });
        });
      return;
    }

    const inv = task.invocation;
    const argv =
      inv.program === 'health'
        ? [cli.healthScript, ...inv.args]
        : [cli.routerMjs, ...inv.args];
    let child;
    try {
      child = cli.spawnRaw(cli.nodeBin, argv);
    } catch (err) {
      appendOutput(task, 'stderr', `无法启动子进程：${err.message}\n`);
      finishTask(task, { status: 'failed', exitCode: null });
      return;
    }
    task.child = child;
    task.status = 'running';
    emit('task.started', publicTask(task));
    child.stdout?.on('data', (buf) => appendOutput(task, 'stdout', buf.toString('utf8')));
    child.stderr?.on('data', (buf) => appendOutput(task, 'stderr', buf.toString('utf8')));
    child.on('error', (err) => {
      appendOutput(task, 'stderr', `子进程错误：${err.message}\n`);
      finishTask(task, { status: 'failed', exitCode: null });
    });
    child.on('close', (code) => {
      finishTask(task, { status: code === 0 ? 'succeeded' : 'failed', exitCode: code });
    });
  }

  function drain() {
    if (running) return;
    const next = queue.shift();
    if (!next) return;
    running = next;
    startTask(next);
  }

  function create(body) {
    const spec = validate(body);
    const dedupeKey = `${spec.action}|${spec.providerIds.join(',')}|${spec.accountKey ?? ''}`;
    const existingId = dedupe.get(dedupeKey);
    if (existingId) {
      const existing = tasks.get(existingId);
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        return publicTask(existing);
      }
    }
    const task = {
      actionId: newId(),
      action: spec.action,
      providerIds: spec.providerIds,
      accountKey: spec.accountKey,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      status: 'queued',
      stdout: '',
      stderr: '',
      truncated: false,
      refreshStatus: 'pending',
      // 内部
      seq: 0,
      lastTouch: 0,
      child: null,
      dedupeKey,
      invocation: buildInvocation(spec),
    };
    tasks.set(task.actionId, task);
    dedupe.set(dedupeKey, task.actionId);
    queue.push(task);
    emit('task.updated', publicTask(task));
    process.nextTick(drain);
    return publicTask(task);
  }

  function get(id) {
    const task = tasks.get(id);
    return task ? publicTask(task) : null;
  }

  return { create, get, size: () => tasks.size };
}

// ---------------------------------------------------------------- 面板

export function createPanel(config) {
  const demo = config.demo ? createDemo() : null;
  const cli = createCli({
    root: config.root ?? FRONTEND_ROOT,
    nodeBin: config.nodeBin,
    // demo 下不去探测真实 opencode.exe（保持"不读真实文件"）；反正不会真的 spawn。
    opencode: config.demo ? 'opencode' : config.opencode || undefined,
  });
  const gateway = createGateway({ cli, host: config.gateway.host, port: config.gateway.port });
  const cached = createCache();

  const actionHub = createSseHub();
  const eventHub = createSseHub();
  const emit = (event, data) => {
    actionHub.broadcast(event, data);
    eventHub.broadcast(event, data);
  };

  const token = config.dev ? '' : crypto.randomBytes(32).toString('hex');
  const tokenBuf = token ? Buffer.from(token) : null;

  const startAt = Date.now();

  // ------- 网关密钥（只读公开字段）

  /** 文件路径按 mtime 缓存，避免每次请求都 stat + 解析。 */
  const keyCache = new Map();

  function gatewayKeysFile() {
    if (!config.root) return null;
    const dataDir = process.env.ROUTER_GATEWAY_DATA
      ? path.resolve(process.env.ROUTER_GATEWAY_DATA)
      : path.join(config.root, 'gateway', 'data');
    return path.join(dataDir, 'keys.json');
  }

  /** 读 `gateway/data/keys.json`；文件不存在/损坏/无 keys[] → 空数组，绝不 500。 */
  function readGatewayKeys() {
    const file = gatewayKeysFile();
    if (!file) return [];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      keyCache.delete(file);
      return [];
    }
    if (!stat.isFile()) return [];
    const hit = keyCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.keys;
    let rows = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 只有带 hash 的条目才是合法密钥（与 gateway/keys.mjs 的 loadKeyDb 一致）。
      rows = Array.isArray(parsed?.keys) ? parsed.keys.filter((k) => k && typeof k.hash === 'string') : [];
    } catch {
      rows = [];
    }
    const keys = rows.map(toGatewayKey);
    keyCache.set(file, { mtimeMs: stat.mtimeMs, keys });
    return keys;
  }

  async function getGatewayKeys() {
    if (demo) return demo.gatewayKeys();
    return readGatewayKeys();
  }

  // ------- 体检辅助

  /** 网关可达性：true / false；异常或超时 → null（未知，不谎称离线）。 */
  async function probeGatewayReachable() {
    try {
      const res = await fetch(`http://${config.gateway.host}:${config.gateway.port}/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(GATEWAY_HEALTH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return null;
    }
  }

  /** `/v1/models` 的三种常见形状：{data:[]} / {models:[]} / []。 */
  function extractModelIds(json) {
    if (!json) return [];
    const arr = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return arr.map((m) => (typeof m === 'string' ? m : m && typeof m === 'object' ? m.id : null)).filter((id) => typeof id === 'string' && id);
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const size = Math.max(1, Math.min(limit, items.length || 1));
    const workers = Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /** 探测 `http://127.0.0.1:<port>/v1/models`；任何 HTTP 响应都算可达（401/403 是服务在线）。 */
  async function probeProviderModels(provider) {
    const port = Number(provider.port);
    if (!Number.isInteger(port) || port <= 0) {
      return { reachable: false, httpStatus: 0, ids: [], error: '端口未知' };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { reachable: true, httpStatus: res.status, ids: extractModelIds(json), error: null };
    } catch (err) {
      const raw = err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR' ? 'timeout' : err?.code || err?.message || 'connect failed';
      return { reachable: false, httpStatus: 0, ids: [], error: sanitize(String(raw)).slice(0, 160) };
    }
  }

  /** 显式真实试打（`probe=1` 才会调用）：绝不把失败升级成 500。 */
  async function probeChatCompletion(provider, model) {
    const port = Number(provider.port);
    const startedAt = Date.now();
    if (!Number.isInteger(port) || port <= 0) {
      return { attempted: false, ok: false, model, durationMs: 0, kind: 'unknown', detail: '端口未知' };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 32,
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'Say only: ok' },
          ],
        }),
        signal: AbortSignal.timeout(CHAT_PROBE_TIMEOUT_MS),
      });
      const durationMs = Date.now() - startedAt;
      if (res.ok) return { attempted: true, ok: true, model, durationMs, kind: 'success', detail: '' };
      const kind =
        res.status === 429
          ? 'rate_limited'
          : res.status === 401 || res.status === 403
            ? 'auth_failed'
            : res.status >= 500
              ? 'upstream_error'
              : res.status >= 400
                ? 'invalid_response'
                : 'unknown';
      // 只留状态码：响应正文绝不出现在契约里（05 §9.2）。
      return { attempted: true, ok: false, model, durationMs, kind, detail: `HTTP ${res.status}` };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const timedOut = err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR';
      return {
        attempted: true,
        ok: false,
        model,
        durationMs,
        kind: timedOut ? 'timeout' : 'unknown',
        detail: timedOut ? '真实试打超时' : sanitize(String(err?.code ?? err?.message ?? 'probe failed')).slice(0, 160),
      };
    }
  }

  function isHealthIssue(row) {
    if (!row.reachable) return true;
    // 401/403 是"服务在线但列表需鉴权"，不是故障；其它 4xx/5xx 算需处理。
    if (row.httpStatus >= 400 && row.httpStatus !== 401 && row.httpStatus !== 403) return true;
    // 排队/429 是并发上限，不是故障；不得因此把 provider 判成离线。
    if (row.probe && !row.probe.ok && row.probe.kind !== 'rate_limited') return true;
    return false;
  }

  /** 人类可读说明；结构化字段只从探测结果推导，绝不反向解析文本。 */
  function buildHealthText(rows, issues) {
    const lines = ['AI 路由体检（结构化）', '─'.repeat(62)];
    for (const row of rows) {
      const mark = isHealthIssue(row) ? '✗' : '✓';
      const detail = row.reachable
        ? typeof row.models === 'number'
          ? `${row.models} 个模型`
          : '模型数未知'
        : `不可达 (${row.error ?? 'connect failed'})`;
      lines.push(`${mark} ${row.title}  ${row.url || '（端口未知）'}  ${detail}`);
      if (row.probe?.attempted) {
        lines.push(`   试打 ${row.probe.model || '(无模型)'} → ${row.probe.ok ? '成功' : row.probe.kind} ${row.probe.durationMs}ms`);
      }
    }
    lines.push('─'.repeat(62), issues === 0 ? '全部通过' : `${issues} 项需要处理`);
    return lines.join('\n');
  }

  function toHealthProviderRow(provider, landed, chatProbe) {
    const port = Number(provider.port);
    const knownPort = Number.isInteger(port) && port > 0;
    return {
      id: provider.id,
      title: provider.title,
      url: knownPort ? `http://127.0.0.1:${port}/v1` : '',
      reachable: landed.reachable,
      httpStatus: landed.httpStatus,
      // 探测到的模型数优先；401/403 拿不到列表时回落到 list --json 的已知数。
      models: landed.ids.length ? landed.ids.length : provider.models,
      auth: {
        state: provider.auth?.state ?? 'unknown',
        expiresAt: provider.auth?.expiresAt ?? null,
        label: provider.auth?.label ?? '',
      },
      probe: chatProbe,
      error: landed.error,
    };
  }

  // ------- 只读数据源

  async function getProviders() {
    if (demo) return demo.providers();
    return cached('providers', 1500, async () => {
      const r = await cli.runRouter(['list', '--json'], { timeoutMs: 15000 });
      const parsed = parseCliJson(r, 'provider 状态');
      checkSchemaVersion(parsed, 'provider 状态');
      const rows = Array.isArray(parsed?.providers) ? parsed.providers : [];
      return rows.map(toProviderStatus);
    });
  }

  async function getAccounts(provider) {
    if (demo) return demo.accounts(provider);
    return cached(`accounts:${provider ?? 'all'}`, 30000, async () => {
      const args = provider ? ['account', provider, '--json'] : ['account', '--json'];
      const r = await cli.runRouter(args, { timeoutMs: 20000 });
      const parsed = parseCliJson(r, '账号');
      checkSchemaVersion(parsed, '账号');
      if (provider) {
        return parsed?.provider ? [toAccountGroup(parsed.provider)] : [];
      }
      const groups = Array.isArray(parsed?.providers) ? parsed.providers : [];
      return groups.map(toAccountGroup);
    });
  }

  async function getAccountCheck(provider) {
    if (demo) return demo.accountCheck(provider);
    return cached(`accountcheck:${provider ?? 'all'}`, 15000, async () => {
      const args = provider ? ['account', 'check', provider, '--json'] : ['account', 'check', '--json'];
      const r = await cli.runRouter(args, { timeoutMs: 30000 });
      // account check 退出码 1 = 有需处理账号，不是后端失败。
      const parsed = parseCliJson(r, '账号体检');
      checkSchemaVersion(parsed, '账号体检');
      const groups = Array.isArray(parsed?.providers) ? parsed.providers : Array.isArray(parsed?.groups) ? parsed.groups : [];
      return groups.map((g) => {
        // account check 的每条同时带全部 accounts 与有问题的 issues；只报问题账号（05 §3.5）。
        const src = Array.isArray(g?.issues) ? { ...g, accounts: g.issues } : g;
        return toAccountGroup(src);
      });
    });
  }

  async function getQuota(provider) {
    if (demo) {
      const d = demo.quota(provider);
      return { ...d, providers: d.providers.map(toQuotaRow) };
    }
    return cached(`quota:${provider ?? 'all'}`, 60000, async () => {
      let fetchedAt = null;
      let rows = [];
      let source = 'gateway-balance';
      let gatewayError = null;

      try {
        const balance = await gateway.balance();
        fetchedAt = balance.fetchedAt;
        rows = balance.providers;
      } catch (err) {
        gatewayError = err;
        // §10 回退：网关 balance 不可用时走 CLI（`gateway balance --json`）。
        try {
          const r = await cli.runRouter(['gateway', 'balance', '--json'], { timeoutMs: 20000 });
          const parsed = parseCliJson(r, '额度');
          rows = Array.isArray(parsed) ? parsed.map(toQuotaRow) : [];
          source = 'cli-fallback';
          fetchedAt = new Date().toISOString();
        } catch {
          throw gatewayError;
        }
      }

      return {
        fetchedAt: typeof fetchedAt === 'string' && fetchedAt ? fetchedAt : new Date().toISOString(),
        source,
        stale: false,
        providers: provider ? rows.filter((r) => r.provider === provider) : rows,
      };
    });
  }

  async function getLogs(provider, lines) {
    if (demo) return demo.logs(provider, lines);
    const r = await cli.runRouter(['logs', provider, String(lines)], { timeoutMs: 10000 });
    if (r.spawnError) {
      if (r.spawnError instanceof BridgeError) throw r.spawnError;
      throw new BridgeError('BACKEND_UNAVAILABLE', `无法运行 router.mjs：${r.spawnError.message}`, { retryable: true });
    }
    if (r.timedOut) throw new BridgeError('TIMEOUT', '日志查询超时', { retryable: true });
    if (!r.stdout.trim() && r.code !== 0) {
      throw new BridgeError('BACKEND_UNAVAILABLE', `日志命令返回退出码 ${r.code}`, { retryable: true });
    }
    return sanitizeBoundedInfo(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`);
  }

  function sanitizeBoundedInfo(text) {
    const bounded = sanitizeBounded(text, { maxLines: MAX_LINES, maxBytes: 256 * 1024 });
    return { text: bounded.text, lines: bounded.lines, truncated: bounded.truncated };
  }

  async function getDoctor() {
    if (demo) return demo.doctor();
    const r = await cli.runRouter(['doctor'], { timeoutMs: 30000 });
    if (r.spawnError) {
      if (r.spawnError instanceof BridgeError) throw r.spawnError;
      throw new BridgeError('BACKEND_UNAVAILABLE', `无法运行 router.mjs：${r.spawnError.message}`, { retryable: true });
    }
    const bounded = sanitizeBounded(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, { maxLines: MAX_LINES, maxBytes: 256 * 1024 });
    return { text: bounded.text, exitCode: r.code ?? 1, truncated: bounded.truncated };
  }

  /**
   * 结构化体检（05 §3.10）：对 `list --json` 的每家探测 `/v1/models`，
   * `probe=1` 时额外做一次真实对话试打。**不解析**任何人类文本。
   */
  async function getHealthCheck(provider, probe) {
    if (demo) return demo.healthCheck(provider, probe);
    const providers = await getProviders();
    const targets = provider ? providers.filter((p) => p.id === provider) : providers;

    const landed = await mapLimit(targets, HEALTH_PROBE_CONCURRENCY, (p) => probeProviderModels(p));
    let chats = new Array(targets.length).fill(null);
    if (probe) {
      chats = await mapLimit(targets, 2, async (p, i) => {
        const ids = landed[i]?.ids ?? [];
        if (!landed[i]?.reachable || !ids.length) return null;
        return probeChatCompletion(p, ids[0]);
      });
    }

    const rows = targets.map((p, i) => toHealthProviderRow(p, landed[i], chats[i]));
    const issues = rows.filter(isHealthIssue).length;
    return {
      structured: true,
      exitCode: issues ? 1 : 0,
      issues,
      ok: issues === 0,
      truncated: false,
      providers: rows,
      text: buildHealthText(rows, issues),
      probeRequested: Boolean(probe),
    };
  }

  function rangeToMs(range) {
    const now = Date.now();
    switch (range) {
      case '24h':
        return { from: now - 86400000, to: now };
      case '30d':
        return { from: now - 30 * 86400000, to: now };
      case 'all':
        return { from: 0, to: now };
      case '7d':
      default:
        return { from: now - 7 * 86400000, to: now };
    }
  }

  async function getUsage(range) {
    const { from, to } = rangeToMs(range);
    if (demo) return demo.usage(range, from, to);
    const r = await cli.runOpencode([
      'api',
      'experimental.session.stats',
      '--param',
      `from=${from}`,
      '--param',
      `to=${to}`,
      '--param',
      'tools=summary',
    ]);
    if (r.spawnError) {
      throw new BridgeError('BACKEND_UNAVAILABLE', 'OpenCode CLI 不可用（features.openCodeCli=false）', { retryable: true });
    }
    if (r.timedOut) throw new BridgeError('TIMEOUT', 'OpenCode 用量查询超时', { retryable: true });
    const text = r.stdout.trim();
    if (!text) throw new BridgeError('BACKEND_UNAVAILABLE', `OpenCode 用量查询无输出（退出码 ${r.code}）`, { retryable: true });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BridgeError('CONTRACT_INVALID', 'OpenCode 用量输出不是合法 JSON');
    }
    const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
    return toUsageStats(data, { range, from, to });
  }

  const actions = createActionRunner({ config, cli, gateway, demo, getProviders, emit });

  // ------- 事件流：provider 状态

  let eventTimer = null;
  async function pushProviderSnapshot() {
    if (!eventHub.size) return;
    try {
      const providers = await getProviders();
      eventHub.broadcast('providers.changed', { providers });
    } catch (err) {
      eventHub.broadcast('reset', { reason: err?.code ?? 'BACKEND_UNAVAILABLE' });
    }
  }
  function ensureEventLoop() {
    if (eventTimer) return;
    eventTimer = setInterval(() => void pushProviderSnapshot(), 5000);
    if (typeof eventTimer.unref === 'function') eventTimer.unref();
  }

  // ------- HTTP

  async function handleHealth(res) {
    let gatewayReachable = false;
    if (demo) gatewayReachable = false;
    else {
      const gw = await gateway.health();
      gatewayReachable = Boolean(gw);
    }
    sendOk(res, {
      bridge: { ok: true, version: VERSION, uptimeSec: Math.round((Date.now() - startAt) / 1000), port: config.port },
      gateway: { reachable: gatewayReachable, host: config.gateway.host, port: config.gateway.port, version: gatewayReachable ? VERSION : null },
      root: { ok: Boolean(config.root), hasRouterMjs: Boolean(config.root) },
      mode: { demo: config.demo, readOnly: config.readOnly },
    });
  }

  async function handleEnv(res) {
    // 真实模式做一次 ~300ms 的真实探测；异常/超时 → null（未知），不谎称 false。
    const reachable = demo ? false : await probeGatewayReachable();
    const env = demo
      ? demo.env()
      : {
          mode: 'real',
          readOnly: config.readOnly,
          root: config.root ? path.basename(config.root) : '',
          nodeVersion: `v${process.versions.node}`,
          platform: process.platform,
          panelVersion: VERSION,
          gateway: { url: `http://${config.gateway.host}:${config.gateway.port}`, reachable },
        };
    // 附带 05 §3.2 的补充字段（additive）。
    sendOk(res, {
      ...env,
      gateway: {
        ...(env.gateway ?? {}),
        url: `http://${config.gateway.host}:${config.gateway.port}`,
        reachable,
      },
      node: { version: `v${process.versions.node}`, platform: process.platform, arch: process.arch },
      bridge: { version: VERSION, pid: process.pid, port: config.port },
      router: { rootOk: Boolean(config.root), nodeBin: path.basename(config.nodeBin) },
      features: { sse: true, demo: config.demo, readOnly: config.readOnly, openCodeCli: Boolean(config.demo) || cli.hasOpencode() },
    });
  }

  async function handleAccounts(req, res, url) {
    const provider = url.searchParams.get('provider') || null;
    if (provider && !ACTION_PROVIDER_WHITELIST.has(provider)) {
      throw new BridgeError('NOT_FOUND', `未知 provider：${provider}`, { provider });
    }
    sendOk(res, await getAccounts(provider));
  }

  async function handleQuota(req, res, url) {
    const provider = url.searchParams.get('provider') || null;
    if (provider && !ACTION_PROVIDER_WHITELIST.has(provider)) {
      throw new BridgeError('NOT_FOUND', `未知 provider：${provider}`, { provider });
    }
    sendOk(res, await getQuota(provider));
  }

  async function handleLogs(req, res, url) {
    const provider = url.searchParams.get('provider') || '';
    if (!provider || !ACTION_PROVIDER_WHITELIST.has(provider)) {
      throw new BridgeError('BAD_REQUEST', '需要合法的 provider 查询参数');
    }
    const requested = clampInt(url.searchParams.get('lines'), DEFAULT_LINES, 1, MAX_LINES);
    const result = await getLogs(provider, requested);
    const receivedAt = generatedAt();
    res.setHeader('x-logs-provider', provider);
    res.setHeader('x-logs-lines-requested', String(requested));
    res.setHeader('x-logs-lines-returned', String(result.lines));
    res.setHeader('x-logs-truncated', String(result.truncated));
    res.setHeader('x-logs-received-at', receivedAt);
    if (acceptsJson(req)) {
      sendOk(res, {
        provider,
        lines: { requested, returned: result.lines, truncated: result.truncated },
        text: result.text,
        truncated: result.truncated,
        receivedAt,
      });
      return;
    }
    sendText(res, 200, result.text);
  }

  async function handleDoctor(req, res) {
    const doc = await getDoctor();
    const receivedAt = generatedAt();
    if (acceptsJson(req)) {
      sendOk(res, { exitCode: doc.exitCode, issues: doc.exitCode === 0 ? 0 : 1, truncated: doc.truncated, receivedAt, text: doc.text });
      return;
    }
    sendText(res, 200, doc.text);
  }

  async function handleHealthCheck(req, res, url) {
    const provider = url.searchParams.get('provider') || null;
    if (provider && !ACTION_PROVIDER_WHITELIST.has(provider)) {
      throw new BridgeError('NOT_FOUND', `未知 provider：${provider}`, { provider });
    }
    const probe = ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get('probe') ?? '').toLowerCase());
    const payload = await getHealthCheck(provider, probe);
    // 前端契约要求 issues 是数字（文本模式下无法确知，用退出码粗推断，不解析文本）。
    sendOk(res, {
      ...payload,
      issues: typeof payload.issues === 'number' ? payload.issues : payload.exitCode ? 1 : 0,
    });
  }

  async function handleUsage(req, res, url) {
    const range = url.searchParams.get('range') || '7d';
    if (!USAGE_RANGES.has(range)) throw new BridgeError('BAD_REQUEST', `range 只能是 ${[...USAGE_RANGES].join(' / ')}`);
    sendOk(res, await getUsage(range));
  }

  function clampInt(raw, fallback, min, max) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }

  // ------- SSE 处理

  function handleLogStream(req, res, url) {
    const provider = url.searchParams.get('provider') || '';
    if (!provider || !ACTION_PROVIDER_WHITELIST.has(provider)) {
      sendError(res, 400, 'BAD_REQUEST', '需要合法的 provider 查询参数');
      return;
    }
    const client = openSse(req, res);
    let seq = 0;
    let prev = [];
    let closed = false;
    client.onClose(() => {
      closed = true;
    });

    const sendLine = (line) => {
      if (!line.trim()) return;
      seq += 1;
      client.send('log', { line, provider, seq, chunk: `${line}\n`, truncated: false });
    };

    if (demo) {
      const initial = demo.logs(provider, 20).text.split('\n');
      for (const line of initial) sendLine(line);
      const timer = setInterval(() => {
        if (closed) return;
        sendLine(demo.logLine(provider));
      }, 1000);
      if (typeof timer.unref === 'function') timer.unref();
      client.onClose(() => clearInterval(timer));
      return;
    }

    const tick = async () => {
      if (closed) return;
      try {
        const result = await getLogs(provider, MAX_LINES);
        const lines = result.text.split('\n');
        let start = 0;
        const maxOverlap = Math.min(prev.length, lines.length);
        for (let k = maxOverlap; k > 0; k -= 1) {
          if (prev.slice(prev.length - k).join('\n') === lines.slice(0, k).join('\n')) {
            start = k;
            break;
          }
        }
        prev = lines;
        const fresh = lines.slice(start);
        for (const line of fresh.slice(-200)) sendLine(line);
      } catch {
        client.send('reset', { reason: 'LOG_UNAVAILABLE' });
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    if (typeof timer.unref === 'function') timer.unref();
    client.onClose(() => clearInterval(timer));
  }

  function handleEvents(req, res) {
    const client = openSse(req, res);
    eventHub.add(client);
    ensureEventLoop();
    void getProviders()
      .then((providers) => client.send('providers.changed', { providers }))
      .catch(() => client.send('reset', {}));
  }

  function handleActionsStream(req, res) {
    const client = openSse(req, res);
    actionHub.add(client);
  }

  // ------- 写端点

  async function handleActionsPost(req, res) {
    if (config.demo) {
      sendError(res, 403, 'DEMO_FORBIDDEN', '演示模式不允许写操作', { retryable: false });
      return;
    }
    if (config.readOnly) {
      sendError(res, 403, 'READ_ONLY', '当前为只读模式，写操作已被桥接层拦截', { retryable: false });
      return;
    }
    const body = await readBody(req);
    const task = actions.create(body);
    sendOk(res, { actionId: task.actionId });
  }

  async function handleGatewayModelsRefresh(req, res) {
    if (config.demo) {
      sendError(res, 403, 'DEMO_FORBIDDEN', '演示模式不允许写操作', { retryable: false });
      return;
    }
    if (config.readOnly) {
      sendError(res, 403, 'READ_ONLY', '当前为只读模式，写操作已被桥接层拦截', { retryable: false });
      return;
    }
    const data = await gateway.refreshModels();
    sendOk(res, { ok: true, models: Array.isArray(data?.models) ? data.models : [] });
  }

  async function handleGatewayCombosPost(req, res) {
    if (config.demo) {
      sendError(res, 403, 'DEMO_FORBIDDEN', '演示模式不允许写操作', { retryable: false });
      return;
    }
    if (config.readOnly) {
      sendError(res, 403, 'READ_ONLY', '当前为只读模式，写操作已被桥接层拦截', { retryable: false });
      return;
    }
    const body = await readBody(req);
    const result = await gateway.comboCommand({
      op: String(body?.op ?? ''),
      name: body?.name,
      models: body?.models,
      strategy: body?.strategy,
    });
    sendOk(res, result);
  }

  // ------- 主分发

  async function handleApi(req, res, url, rest) {
    const method = req.method ?? 'GET';
    const write = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

    if (write && req.headers.origin && !isLoopbackHostname(safeHostname(req.headers.origin))) {
      sendError(res, 403, 'FORBIDDEN', '写请求必须同源', { retryable: false });
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const noBody = method === 'HEAD';
      switch (rest) {
        case '/health':
          await handleHealth(res);
          break;
        case '/env':
          await handleEnv(res);
          break;
        case '/providers':
          sendOk(res, await getProviders());
          break;
        case '/accounts':
          await handleAccounts(req, res, url);
          break;
        case '/accounts/check':
          sendOk(res, await getAccountCheck(url.searchParams.get('provider') || null));
          break;
        case '/quota':
          await handleQuota(req, res, url);
          break;
        case '/logs':
          await handleLogs(req, res, url);
          break;
        case '/logs/stream':
          handleLogStream(req, res, url);
          return;
        case '/doctor':
          await handleDoctor(req, res);
          break;
        case '/health-check':
          await handleHealthCheck(req, res, url);
          break;
        case '/usage':
          await handleUsage(req, res, url);
          break;
        case '/events':
          handleEvents(req, res);
          return;
        case '/actions/stream':
          handleActionsStream(req, res);
          return;
        case '/gateway/status':
          sendOk(res, demo ? toGatewayStatus(demo.gatewayStatus()) : await gateway.status());
          break;
        case '/gateway/usage': {
          const days = clampInt(url.searchParams.get('days'), 7, 1, 90);
          sendOk(res, demo ? toGatewayUsage(demo.gatewayUsage(), days) : await gateway.usage(days));
          break;
        }
        case '/gateway/balance': {
          const bal = demo ? demo.balance() : await gateway.balance();
          sendOk(res, { fetchedAt: bal.fetchedAt, providers: bal.providers.map(toQuotaRow) });
          break;
        }
        case '/gateway/combos':
          sendOk(res, demo ? demo.gatewayCombos() : await gateway.combos());
          break;
        case '/gateway/free':
          sendOk(res, demo ? demo.gatewayFree() : await gateway.free());
          break;
        case '/gateway/local-answers':
          sendOk(res, demo ? demo.gatewayLocalAnswers() : await gateway.localAnswers());
          break;
        case '/gateway/keys':
          // 只出公开字段（id/name/prefix/…），绝不返回 hash。
          // 形状对齐 05 §3.18 / 前端 KeysPage：{ supported, keys[] }。
          sendOk(res, { supported: true, keys: await getGatewayKeys() });
          break;
        default:
          if (rest.startsWith('/actions/')) {
            const id = rest.slice('/actions/'.length);
            const task = actions.get(id);
            if (!task) throw new BridgeError('NOT_FOUND', `未知任务：${id}`);
            sendOk(res, task);
            break;
          }
          throw new BridgeError('NOT_FOUND', `未知端点：GET ${rest}`);
      }
      if (noBody && !res.writableEnded) res.end();
      return;
    }

    if (method === 'POST') {
      switch (rest) {
        case '/actions':
          await handleActionsPost(req, res);
          return;
        case '/gateway/models/refresh':
          await handleGatewayModelsRefresh(req, res);
          return;
        case '/gateway/combos':
          await handleGatewayCombosPost(req, res);
          return;
        default:
          throw new BridgeError('NOT_FOUND', `未知端点：POST ${rest}`);
      }
    }

    throw new BridgeError('NOT_FOUND', `不支持的方法：${method} ${rest}`);
  }

  function safeHostname(value) {
    try {
      return new URL(value).hostname;
    } catch {
      return '';
    }
  }

  function tokenOk(req) {
    // --dev 与 --demo 免 token：demo 不触达任何真实能力（不 spawn、不读文件），
    // 且全部是匿名数据，回环 + Host 校验已足够；真实模式一律要求 x-panel-token。
    if (config.dev || config.demo) return true;
    if (!tokenBuf) return false;
    const provided = req.headers['x-panel-token'];
    if (typeof provided !== 'string' || !provided) return false;
    const buf = Buffer.from(provided);
    if (buf.length !== tokenBuf.length) return false;
    return crypto.timingSafeEqual(buf, tokenBuf);
  }

  function hostHeaderOk(hostHeader) {
    if (!hostHeader) return true;
    return isLoopbackHostname(hostHeader);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || DEFAULT_HOST}`);
    const pathname = decodeURIComponent(url.pathname);

    setBaseHeaders(res);

    if (!isLoopbackRemote(req.socket.remoteAddress)) {
      sendText(res, 403, '仅允许回环来源');
      return;
    }
    if (!hostHeaderOk(req.headers.host)) {
      sendText(res, 421, 'Host 头不是本机回环地址');
      return;
    }
    if (req.headers.origin && req.headers.origin !== 'null' && !isLoopbackHostname(safeHostname(req.headers.origin))) {
      sendText(res, 403, 'Origin 不是同源');
      return;
    }

    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (isApi) {
      if (!tokenOk(req)) {
        sendError(res, 401, 'UNAUTHORIZED', '缺少或错误的 x-panel-token', { retryable: false });
        return;
      }
      const rest = (pathname.slice(4).replace(/\/+$/, '') || '/').replace(/\/+$/, '') || '/';
      try {
        await handleApi(req, res, url, rest);
      } catch (err) {
        const be = err instanceof BridgeError ? err : new BridgeError('ACTION_FAILED', err?.message ?? '内部错误');
        sendError(res, be.http, be.code, be.message, { provider: be.provider, retryable: be.retryable });
      }
      return;
    }

    serveStatic(req, res, pathname);
  }

  // ------- 静态站点

  const distDir = path.join(FRONTEND_ROOT, 'dist');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };

  function applyHtmlHeaders(res) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
  }

  function injectToken(html) {
    if (!token) return html;
    const meta = /(<meta\s+name=["']panel-token["']\s+content=["'])[^"']*(["'])/i;
    if (meta.test(html)) return html.replace(meta, `$1${token}$2`);
    return html.replace(/<\/head>/i, `<meta name="panel-token" content="${token}" />\n</head>`);
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, '方法不允许');
      return;
    }

    const safePath = pathname === '/' ? '/index.html' : pathname;
    const target = path.join(distDir, path.normalize(safePath).replace(/^([/\\])+/, ''));
    if (!target.startsWith(distDir)) {
      sendText(res, 403, '路径非法');
      return;
    }

    const sendHtml = (html) => {
      applyHtmlHeaders(res);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(req.method === 'HEAD' ? undefined : injectToken(html));
    };

    try {
      const stat = fs.statSync(target);
      if (stat.isFile()) {
        const ext = path.extname(target).toLowerCase();
        if (ext === '.html') {
          sendHtml(fs.readFileSync(target, 'utf8'));
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(target).pipe(res);
        return;
      }
    } catch {
      /* SPA 回退 */
    }

    const indexPath = path.join(distDir, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      sendHtml(html);
    } catch {
      sendText(
        res,
        200,
        'Router 面板桥接服务已就绪，但未找到 dist/index.html。\n请先执行 npm run build，或使用 npm run dev（Vite 会自行托管页面）。\n',
      );
    }
  }

  return { handle, getProviders, token, config, actions, gateway, cli, demo };
}

// ---------------------------------------------------------------- 启动

export function startServer(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printUsage();
    return null;
  }
  const config = resolveConfig(opts, env);
  const panel = createPanel(config);
  const server = http.createServer((req, res) => {
    Promise.resolve(panel.handle(req, res)).catch((err) => {
      try {
        sendError(res, 500, 'ACTION_FAILED', err?.message ?? '内部错误');
      } catch {
        /* 响应已结束 */
      }
    });
  });

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`[bridge] 端口 ${config.port} 已被占用，请用 --port 或 ROUTER_PANEL_PORT 指定其它端口。`);
    } else {
      console.error(`[bridge] 启动失败：${err?.message ?? err}`);
    }
    process.exit(1);
  });

  server.listen(config.port, config.bindHost, () => {
    const url = `http://${config.host}:${config.port}`;
    const mode = [config.demo ? 'demo' : 'local', config.readOnly ? 'read-only' : null].filter(Boolean).join(' + ');
    console.log('[bridge] Router 面板桥接服务已启动');
    console.log(`[bridge]   监听        ${url}  （仅回环）`);
    console.log(`[bridge]   工作范围    ${mode}`);
    console.log(`[bridge]   router root ${config.root ?? '（demo：不访问真实文件）'}`);
    console.log(`[bridge]   node        ${config.nodeBin}`);
    console.log(`[bridge]   网关        http://${config.gateway.host}:${config.gateway.port}`);
    console.log(`[bridge]   认证        ${config.dev ? 'dev：回环免 token' : '一次性 x-panel-token 已注入 index.html（不落盘、不写日志）'}`);
    if (!config.demo && !config.root) {
      console.warn('[bridge] 警告：未发现 router.mjs。请传 --router-root 或设置 ROUTER_ROOT，否则只读源会返回 BACKEND_UNAVAILABLE。');
    }
  });

  const shutdown = () => {
    console.log('\n[bridge] 正在退出…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, panel, config };
}

function printUsage() {
  console.log(`Router 面板桥接服务

用法：node server/index.mjs [选项]

  --router-root <PATH>   router 仓库根（含 router.mjs）
  --node <PROGRAM>       Node 可执行名/路径（默认 node）
  --port <N>             监听端口（默认 8792）
  --host <ADDR>          监听地址，仅允许回环（默认 127.0.0.1）
  --demo                 匿名演示数据，不 spawn、不读真实文件
  --read-only            桥接层拦截全部写操作
  --dev                  开发模式：回环免 token

环境变量：ROUTER_ROOT、ROUTER_OPENCODE、ROUTER_PANEL_PORT`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) startServer();
