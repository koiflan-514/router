#!/usr/bin/env node
/**
 * dumate-proxy.js — 把百度搭子（DuMate）桌面端的订阅额度暴露成本机 OpenAI 兼容端点。
 *
 * DuMate 桌面端自己就是 opencode 套壳：它在启动时随机分配一个 main-server 端口，
 * 并把模型目录写进 `qianfan_desk_xdg/<user>/config/opencode/opencode.json`。
 * main-server 上的 `POST /api/qianfanproxy/v1/chat/completions` **不需要鉴权**——
 * 鉴权在桌面端进程内部完成。这个代理做四件事：
 *
 *   1. 每次请求前自动发现 main-server 的当前端口（每次启动都变）；
 *   2. 从桌面端落盘的 opencode 配置里读模型目录，过滤内部模型；
 *   3. 把 opencode/pi 的 OpenAI 请求原样转发，流式与工具调用直接透传；
 *   4. 用 main-server 的 `/api/dumate/points/quota_overview` 暴露积分余额。
 *
 * 端点：
 *   GET  /health             进程、上游端口、登录态、模型数（不输出 token/key）
 *   GET  /v1/models          模型清单；?refresh=1 跳过缓存
 *   GET  /v1/quota           积分余额（opencode provider-credits 插件用）
 *   GET  /v1/credits         同上（别名）
 *   POST /v1/chat/completions 对话，流式/非流式/工具调用原样透传
 *   *    /v1/*               其余 OpenAI 兼容路径原样透传
 *
 * 零依赖，只用 node: 内建模块；不写任何凭证文件。
 *
 * 用法：
 *   node dumate-proxy.js                  # 127.0.0.1:8795
 *   node dumate-proxy.js --port 8795
 *   DUMATE_MAIN_PORT=52730 node dumate-proxy.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');

// 本地限流：与网关共用 limits.json 的档位（见 integrations/limits/limiter.js）。
// 客户端可以绕过网关直连 :8795，所以反代自己也必须挡住「并行打上游」。
let createLimiterFor = null;
let LimiterBusy = null;
try {
  ({ createLimiterFor, LimiterBusy } = require('../limits/limiter.js'));
} catch {}

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const STARTED_AT = Date.now();

const DEFAULT_PORT = 8795;
const CACHE_TTL_MS = Number(process.env.DUMATE_CACHE_MS || 60_000);
const SHORT_TIMEOUT_MS = Number(process.env.DUMATE_SHORT_TIMEOUT_MS || 15_000);
// DuMate 桌面端允许长任务；代理不能比客户端先掐断。
const CHAT_TIMEOUT_MS = Number(process.env.DUMATE_CHAT_TIMEOUT_MS || 1_200_000);
const MAX_BODY_BYTES = Number(process.env.DUMATE_MAX_BODY || 64 * 1024 * 1024);
// main-server 的端口只在启动时写进日志；缓存几秒，避免每个请求都读 512KB 日志。
const PORT_CACHE_MS = 5_000;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PORT = Number(argValue('--port') || process.env.DUMATE_PORT || process.env.PORT || DEFAULT_PORT);
const HOST = String(process.env.DUMATE_HOST || '127.0.0.1');

/** 桌面端的 Electron userData 目录。 */
function appDataRoot() {
  const explicit = String(process.env.DUMATE_APP_DATA || '').trim();
  if (explicit) return explicit;
  if (WIN) {
    const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(roaming, 'qianfan-desktop-app');
  }
  return path.join(HOME, '.config', 'qianfan-desktop-app');
}

const APP_DATA = appDataRoot();
const ELECTRON_LOG = path.join(APP_DATA, 'log', 'electron.log');
const MAIN_LOG = path.join(APP_DATA, 'log', 'desktop-main', 'Main.log');
const AUTH_FILE = path.join(APP_DATA, 'auth.json');
const XDG_ROOT = path.join(APP_DATA, 'qianfan_desk_xdg');

/** 本地限流器；`DUMATE_LIMITS=off` 可临时关掉（调试用，别长期关）。 */
const LIMITER =
  createLimiterFor && String(process.env.DUMATE_LIMITS || '').toLowerCase() !== 'off'
    ? createLimiterFor('dumate')
    : null;

// ---------------------------------------------------------------- 小工具

function log(...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}]`, ...args);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 读文件末尾 N 字节：日志可能很大，但唯一有用的端口都在最后几条里。 */
function readTail(file, maxBytes) {
  return readSlice(file, maxBytes, 'tail');
}

/** 读文件开头 N 字节：桌面端启动时写的端口/key 在日志前部，日志增长后仍在那里。 */
function readHead(file, maxBytes) {
  return readSlice(file, maxBytes, 'head');
}

function readSlice(file, maxBytes, where) {
  let fd;
  try {
    const st = fs.statSync(file);
    const start = where === 'head' ? 0 : Math.max(0, st.size - maxBytes);
    const len = Math.min(maxBytes, st.size - start);
    if (len <= 0) return '';
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

// 日志窗口：electron.log 会随每次前端请求增长（实测一天就能过 512KB）。
// 启动时写的端口与 in-app key 行可能早已被挤出末尾窗口，所以查找分三级：
// 末尾 1MB（最近一次启动）→ 开头 1MB（长时间运行的那次启动）→ 整份（上限 64MB）。
const LOG_WINDOW_BYTES = 1024 * 1024;
const LOG_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 在日志里找「全局最后一次」匹配。
 *
 * 坑：head/tail 两个窗口里的 m.index 是相对各自窗口的偏移，直接比较会得出错误结论
 * （head 里最早的匹配 index 也可能大于 tail 里较新的匹配）。所以窗口查找只用来快速
 * 命中「tail 最近一次启动」这个常见情况；一旦 head 也命中，必须读整份（≤64MB）
 * 确认真正的全局最后一条——桌面端跑久了，最新端口行会落进 head/tail 之间的盲区。
 */
function lastLogMatch(file, patterns) {
  const pick = (text) => {
    let best = null;
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        if (!best || m.index > best.index) best = m;
      }
    }
    return best;
  };
  const tailHit = pick(readTail(file, LOG_WINDOW_BYTES));
  const headHit = pick(readHead(file, LOG_WINDOW_BYTES));
  if (tailHit && !headHit) return tailHit;
  // head 也命中（或 tail 没命中）→ 窗口不可靠，读整份定夺。
  try {
    if (fs.statSync(file).size <= LOG_MAX_BYTES) {
      return pick(fs.readFileSync(file, 'utf8')) || tailHit || headHit;
    }
  } catch {}
  return tailHit || headHit;
}

function maskId(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// ---------------------------------------------------------------- 端口发现

const portCache = { port: 0, at: 0, source: '' };

/**
 * DuMate 的 main-server 端口每次启动随机分配，落点有三处：
 *   electron.log  `[Backend] Started on port 52730, pid …`
 *   Main.log      app cfg 里的 `"Port":52730`
 *   进程命令行    `--port=52730`
 * 按上面顺序读取；都能在桌面端重启后自动跟上，不需要重启反代。
 */
function portFromElectronLog() {
  const hit = lastLogMatch(ELECTRON_LOG, [
    /\[Backend\] Started on port (\d+)/g,
    /\[Backend\] Starting:[^\n]*?--port=(\d+)/g,
  ]);
  return hit ? Number(hit[1]) : 0;
}

function portFromMainLog() {
  const hit = lastLogMatch(MAIN_LOG, [/"Port":\s*(\d+)/g]);
  return hit ? Number(hit[1]) : 0;
}

function portFromProcess() {
  if (!WIN) return 0;
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='dumate-main-server.exe'\" | Sort-Object CreationDate | Select-Object -Last 1 -ExpandProperty CommandLine",
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const m = /--port=(\d+)/.exec(out);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function discoverPort({ force = false } = {}) {
  const envPort = Number(process.env.DUMATE_MAIN_PORT);
  if (envPort > 0) return { port: envPort, source: 'env' };
  if (!force && portCache.port && Date.now() - portCache.at < PORT_CACHE_MS) {
    return { port: portCache.port, source: portCache.source };
  }

  let port = portFromElectronLog();
  let source = 'electron.log';
  if (!port) {
    port = portFromMainLog();
    source = 'Main.log';
  }
  if (!port) {
    port = portFromProcess();
    source = 'process';
  }

  portCache.port = port;
  portCache.at = Date.now();
  portCache.source = port ? source : '';
  return { port, source: portCache.source };
}

/** 只做 TCP 连接探测：main-server 的端口不会监听到一半。 */
function probeTcp(port, timeout = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function notRunning(message) {
  return Object.assign(new Error(message), { code: 'DUMATE_NOT_RUNNING' });
}

/**
 * 返回 main-server 的根地址。缓存失效或 TCP 探测失败时强制重新发现一次——
 * 桌面端重启后端口会变，反代不能一直钉着旧端口。
 */
async function mainServer({ force = false } = {}) {
  let { port, source } = discoverPort({ force });
  if (!port) {
    throw notRunning('找不到百度搭子主服务端口：请先打开 DuMate 桌面端');
  }
  if (!(await probeTcp(port))) {
    ({ port, source } = discoverPort({ force: true }));
    if (!port || !(await probeTcp(port))) {
      throw notRunning('百度搭子桌面端未运行：请先打开 DuMate');
    }
  }
  return {
    port,
    source,
    root: `http://127.0.0.1:${port}`,
    base: `http://127.0.0.1:${port}/api/qianfanproxy/v1`,
  };
}

// ---------------------------------------------------------------- 账号与鉴权

function readAuthInfo() {
  const data = readJson(AUTH_FILE) || {};
  const profiles = Array.isArray(data.accountProfiles) ? data.accountProfiles : [];
  const activeId = data.activeProfileId;
  const profile = profiles.find((p) => p && p.profileId === activeId) || profiles[0] || null;
  return {
    loggedIn: profiles.length > 0,
    name: (profile && String(profile.displayName || '').trim()) || '',
    accountId: String((profile && (profile.bceUserId || profile.bceAccountId)) || '').trim(),
    loginType: String((profile && profile.loginType) || data.activeProviderType || '').trim(),
    lastLogin: Number(profile && profile.lastSuccessfulLoginAt) || 0,
  };
}

const keyCache = { key: '', at: 0 };

/**
 * main-server 的 `/api/dumate/*` 需要桌面端这次启动时生成的 in-app key。
 * 它只写在 electron.log 里（每行带单引号），不在任何配置文件里。
 */
function readInappKey({ force = false } = {}) {
  const explicit = String(process.env.DUMATE_INAPP_KEY || '').trim();
  if (explicit) return explicit;
  if (!force && keyCache.key && Date.now() - keyCache.at < 60_000) return keyCache.key;

  const hit = lastLogMatch(ELECTRON_LOG, [/DUMATE_INAPP_KEY:\s*'([^']+)'/g]);
  if (hit) {
    keyCache.key = hit[1];
    keyCache.at = Date.now();
    return keyCache.key;
  }
  // 读不到时退回上一次的好值：日志被轮转/清空不该让额度接口立刻瘫掉。
  // 真是桌面端重启换了 key，上游会回 401/403，调用方会 force 重读再试一次。
  return keyCache.key;
}

// ---------------------------------------------------------------- 模型清单

// 桌面端把内部路由/校验/OCR/向量模型也塞进同一份清单；它们不是对外模型。
// `dm-auto-model/*` 是「自动选择」的入口，实测可调，保留。
const HIDDEN_MODEL = /^(?:llm-mock|dumate-image|qianfan-ocr|qwen3-embedding|qwen3-reranker|model-)/i;

const NICE_NAMES = {
  'deepseek-v4-flash-0731': 'DeepSeek V4 Flash 0731',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v41-flash': 'DeepSeek V4.1 Flash',
  'doubao-seed-2-0-pro': 'Doubao Seed 2.0 Pro',
  'ernie-4.5-turbo-vl-32k': 'ERNIE 4.5 Turbo VL 32K',
  'glm-5': 'GLM-5',
  'glm-53': 'GLM-5.3',
  'glm-53-flash': 'GLM-5.3 Flash',
  'kimi-k3': 'Kimi K3',
  'kimi-k31': 'Kimi K3.1',
  'qwen2.5-vl-32b-instruct': 'Qwen2.5 VL 32B Instruct',
  'qwen3.5-27b': 'Qwen3.5 27B',
  'qwen3.5-35b-a3b': 'Qwen3.5 35B A3B',
  'qwen3.5-397b-a17b': 'Qwen3.5 397B A17B',
  'qwen3.8-max': 'Qwen3.8 Max',
  'qwen38-flash': 'Qwen3.8 Flash',
  'qwen4-max': 'Qwen4 Max',
};

function prettyName(id) {
  if (NICE_NAMES[id]) return NICE_NAMES[id];
  if (id.startsWith('dm-auto-model/')) {
    const kind = id.includes('/mm.') ? '多模态' : '文本';
    const level = id.split('.').pop();
    return `搭子自动·${kind} ${level}`;
  }
  return id;
}

let catalogCache = { file: '', mtimeMs: -1, data: null };

function configCandidates() {
  const out = [];
  const explicit = String(process.env.DUMATE_OPENCODE_JSON || '').trim();
  if (explicit) out.push(explicit);
  try {
    for (const name of fs.readdirSync(XDG_ROOT)) {
      if (name === 'global' || name === 'data') continue;
      out.push(path.join(XDG_ROOT, name, 'config', 'opencode', 'opencode.json'));
    }
  } catch {}
  return out;
}

/** 桌面端升级/切换账号后可能有多份；取 mtime 最新的那份。 */
function latestConfigFile() {
  let best = null;
  for (const file of configCandidates()) {
    try {
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return best;
}

function toModel(id, raw, createdSec) {
  const limit = (raw && raw.limit) || {};
  const declared = raw && raw.modalities && Array.isArray(raw.modalities.input)
    ? raw.modalities.input
    : ['text'];
  const input = [...new Set(['text', ...declared.filter((m) => m === 'image')])];
  return {
    id,
    object: 'model',
    created: createdSec,
    owned_by: 'baidu-dumate',
    name: prettyName(id),
    type: 'chat',
    context_length: Number(limit.context || limit.input) || null,
    max_output_tokens: Number(limit.output) || null,
    capabilities: {
      // pi 的 models.json 只接受 text/image；audio/video 会让整份配置校验失败。
      vision: input.includes('image'),
      reasoning: false,
      tool_call: true,
      input_modalities: input,
      output_modalities: ['text'],
    },
  };
}

function readCatalog({ refresh = false } = {}) {
  const latest = latestConfigFile();
  if (!latest) {
    throw Object.assign(new Error('找不到百度搭子的模型配置：请先打开 DuMate 桌面端'), {
      code: 'DUMATE_NO_CATALOG',
    });
  }
  if (!refresh && catalogCache.data && catalogCache.file === latest.file && catalogCache.mtimeMs === latest.mtimeMs) {
    return catalogCache.data;
  }

  const cfg = readJson(latest.file);
  const models = cfg && cfg.provider && cfg.provider.QianfanPersonalQuota
    && cfg.provider.QianfanPersonalQuota.models;
  if (!models || typeof models !== 'object') {
    throw Object.assign(new Error(`百度搭子的模型配置里没有 QianfanPersonalQuota：${latest.file}`), {
      code: 'DUMATE_NO_CATALOG',
    });
  }

  const createdSec = Math.floor(latest.mtimeMs / 1000);
  const data = Object.entries(models)
    .filter(([id, raw]) => id && raw && !HIDDEN_MODEL.test(id))
    .map(([id, raw]) => toModel(id, raw, createdSec));
  if (!data.length) {
    throw Object.assign(new Error('百度搭子的模型清单是空的：请重启 DuMate 桌面端'), {
      code: 'DUMATE_NO_CATALOG',
    });
  }

  catalogCache = { file: latest.file, mtimeMs: latest.mtimeMs, data };
  return data;
}

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body, null, 2);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendError(res, status, message, type = 'dumate_error', headers = {}) {
  sendJson(res, status, { ok: false, error: { message, type, code: status } }, headers);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);

function upstreamHeaders(incoming, { stream = false } = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming || {})) {
    const lower = String(key).toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length' || lower === 'accept-encoding') continue;
    // Content-Type 由下面统一设置；复制入站头会让 fetch 看到两个同名头，
    // 上游会把它拼成 `application/json, application/json` 并直接 400。
    if (lower === 'content-type') continue;
    // main-server 不需要客户端 key；不要把入站占位 key 带上去。
    if (lower === 'authorization' || lower === 'x-api-key') continue;
    if (Array.isArray(value)) headers[key] = value.join(', ');
    else if (value != null) headers[key] = String(value);
  }
  headers['Content-Type'] = 'application/json';
  if (stream) headers.Accept = 'text/event-stream';
  return headers;
}

async function upstreamFetch(target, { method = 'GET', headers, body, timeout = SHORT_TIMEOUT_MS, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const composed = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  return fetch(target, {
    method,
    headers,
    body,
    signal: composed,
    redirect: 'follow',
  });
}

/**
 * 把 fetch 的响应原样写回客户端，去掉 hop-by-hop 与解码后不再成立的长度头。
 * 等到流真正写完才 resolve：调用方据此释放本地限流的执行位。
 */
function pipeUpstream(res, upstream) {
  return new Promise((resolve) => {
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) return;
      if (lower === 'content-encoding' || lower === 'content-length') return;
      try {
        res.setHeader(key, value);
      } catch {}
    });
    res.setHeader('Cache-Control', 'no-store');

    if (!upstream.body) {
      res.end();
      resolve();
      return;
    }

    const stream = Readable.fromWeb(upstream.body);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.on('close', () => {
      if (!res.writableEnded) {
        try { stream.destroy(); } catch {}
      }
      done();
    });
    stream.on('error', (err) => {
      if (!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || /aborted/i.test(err.message || '')))) {
        log('上游流中断:', err.message);
        if (!res.writableEnded) res.destroy(err);
      }
      done();
    });
    res.on('finish', done);
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------- 配额

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function handleQuota(res) {
  const auth = readAuthInfo();
  const accountId = String(process.env.DUMATE_ACCOUNT_ID || auth.accountId || '').trim();
  if (!readInappKey() || !accountId) {
    return sendError(
      res,
      501,
      '读取不到百度搭子的本地鉴权信息：请重启 DuMate 桌面端后重试',
      'dumate_quota_unavailable',
    );
  }

  let server;
  try {
    server = await mainServer();
  } catch (err) {
    return sendError(res, 503, err.message, 'dumate_not_running');
  }

  const target = `${server.root}/api/dumate/points/quota_overview`
    + '?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true';

  // in-app key 每次桌面端启动都会换；缓存里的旧 key 被上游拒绝时重读一次再试。
  let upstream = null;
  let text = '';
  let payload = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const key = readInappKey({ force: attempt > 0 });
    if (!key) break;
    try {
      upstream = await upstreamFetch(target, {
        headers: {
          'X-Dumate-Inapp-Key': key,
          'X-Dumate-Account-Id': accountId,
          Accept: 'application/json',
        },
        timeout: SHORT_TIMEOUT_MS,
      });
    } catch (err) {
      return sendError(res, 502, `百度搭子额度接口不可达：${err.message}`, 'dumate_network');
    }
    text = await upstream.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (upstream.status !== 401 && upstream.status !== 403) break;
  }

  if (!upstream || !upstream.ok || !payload || payload.success !== true || !payload.result) {
    const status = upstream ? upstream.status : 0;
    const message = (payload && (payload.message || payload.msg))
      || text.slice(0, 300)
      || `HTTP ${status}`;
    return sendError(
      res,
      status === 401 || status === 403 ? status : 502,
      `百度搭子额度接口返回：${message}`,
      'dumate_quota',
    );
  }

  const r = payload.result;
  const total = numberOrZero(r.totalPoints);
  const used = numberOrZero(r.usedPoints);
  const remaining = Math.max(0, total - used);
  const subscriptions = (Array.isArray(r.subscription) ? r.subscription : [])
    .concat(Array.isArray(r.incremental) ? r.incremental : [])
    .map((p) => ({
      packageId: p.packageId || null,
      packageType: p.packageType || null,
      source: p.source || null,
      status: p.status || null,
      product: p.product || null,
      total: numberOrZero(p.totalPoints),
      used: numberOrZero(p.usedPoints),
      remaining: Math.max(0, numberOrZero(p.totalPoints) - numberOrZero(p.usedPoints)),
      startAt: p.startDate ? new Date(p.startDate * 1000).toISOString() : null,
      expireAt: p.expireDate ? new Date(p.expireDate * 1000).toISOString() : null,
    }));

  let models = [];
  try {
    models = readCatalog().map((m) => ({ id: m.id, name: m.name, type: 'chat' }));
  } catch {}

  sendJson(res, 200, {
    ok: true,
    service: 'dumate',
    fetchedAt: new Date().toISOString(),
    user: {
      name: auth.name || null,
      accountId: maskId(accountId),
      loginType: auth.loginType || null,
      subscribed: r.isSubscribed === true,
      throttled: Boolean(r.modelThrottleInfo && r.modelThrottleInfo.throttled),
    },
    // 上游给的是「总额 - 已用」；这里保留原值，客户端可显示真实进度条。
    balance: { remaining, total, used, unit: 'credits' },
    wallet: { total, used, available: remaining },
    subscriptions,
    // DuMate 没有公开逐模型倍率：返回空对象，插件显示「—」而不是编一个值。
    multipliers: {},
    models,
  });
}

// ---------------------------------------------------------------- 路由

async function handleModels(req, res, url) {
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  let data;
  try {
    data = readCatalog({ refresh });
  } catch (err) {
    return sendError(res, 503, err.message || '获取模型列表失败', 'dumate_catalog');
  }
  sendJson(res, 200, {
    object: 'list',
    data,
    // 非标准字段：方便排障时确认代理读到的是哪份配置
    source: catalogCache.file || null,
  });
}

function parseStream(body) {
  if (!body || !body.length) return false;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return Boolean(parsed && parsed.stream === true);
  } catch {
    return false;
  }
}

async function handleProxy(req, res, url, body) {
  const stream = parseStream(body);
  const rest = url.pathname.replace(/^\/v1/, '') || '/';

  let release = null;
  if (LIMITER) {
    try {
      release = await LIMITER.acquire({ maxWaitMs: 5000 });
    } catch (err) {
      if (err instanceof LimiterBusy) {
        const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        return sendError(
          res,
          429,
          `本地限流：${seconds} 秒后重试（${LIMITER.limits.rpm}/分钟，并发 ${LIMITER.limits.concurrency}）`,
          'dumate_rate_limited',
        );
      }
      throw err;
    }
  }

  const ac = new AbortController();
  req.on('aborted', () => ac.abort());
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const started = Date.now();
  let attempt = 0;
  try {
    while (true) {
      const server = await mainServer({ force: attempt > 0 });
      const target = `${server.base}${rest}${url.search}`;
      try {
        const upstream = await upstreamFetch(target, {
          method: req.method,
          headers: upstreamHeaders(req.headers, { stream }),
          body: body && body.length ? body : undefined,
          timeout: CHAT_TIMEOUT_MS,
          signal: ac.signal,
        });
        log(`${req.method} ${url.pathname} → ${upstream.status} ${Date.now() - started}ms (port ${server.port})`);
        await pipeUpstream(res, upstream);
        return;
      } catch (err) {
        const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
        if (aborted) {
          if (!res.writableEnded) res.destroy();
          return;
        }
        // 端口在请求之间被桌面端重启换掉了：重新发现一次再试。
        // 连接被拒绝时请求没有到达上游，重放不会重复计费。
        const refused = /ECONNREFUSED|ECONNRESET|fetch failed|other side closed|socket hang up/i.test(
          `${err.code || ''} ${err.message || ''} ${err.cause && err.cause.code ? err.cause.code : ''}`,
        );
        if (attempt === 0 && refused) {
          attempt += 1;
          log(`上游连接失败（${err.message}），重新发现端口后重试`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err && err.code === 'DUMATE_NOT_RUNNING') {
      if (!res.headersSent) sendError(res, 503, err.message, 'dumate_not_running');
      else if (!res.writableEnded) res.destroy(err);
      return;
    }
    log(`${req.method} ${url.pathname} 失败：${err.message}`);
    if (!res.headersSent) {
      sendError(res, 502, `百度搭子上游不可达：${err.message}`, 'dumate_network');
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  } finally {
    release?.();
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendError(res, 400, '非法 URL');
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.end();
    return;
  }

  try {
    if (url.pathname === '/health' || url.pathname === '/') {
      const auth = readAuthInfo();
      let models = [];
      let modelError = '';
      try {
        models = readCatalog();
      } catch (err) {
        modelError = err.message;
      }
      let serverInfo = null;
      try {
        serverInfo = await mainServer();
      } catch {}

      return sendJson(res, 200, {
        ok: true,
        service: 'dumate-proxy',
        upstream: serverInfo ? serverInfo.base : null,
        upstreamRunning: Boolean(serverInfo),
        mainPort: serverInfo ? serverInfo.port : null,
        portSource: serverInfo ? serverInfo.source : null,
        loggedIn: auth.loggedIn,
        user: auth.loggedIn ? { name: auth.name || null, accountId: maskId(auth.accountId) } : null,
        models: models.length,
        modelError: modelError || undefined,
        catalogFile: catalogCache.file || null,
        quotaAvailable: Boolean(readInappKey() && (process.env.DUMATE_ACCOUNT_ID || auth.accountId)),
        limits: LIMITER ? LIMITER.snapshot() : null,
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      });
    }

    if (url.pathname === '/v1/models') {
      return await handleModels(req, res, url);
    }

    if (url.pathname === '/v1/quota' || url.pathname === '/v1/credits' || url.pathname === '/admin/api/credits') {
      if (req.method !== 'GET') return sendError(res, 405, '只支持 GET');
      return await handleQuota(res);
    }

    if (url.pathname.startsWith('/v1/')) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
      return await handleProxy(req, res, url, body);
    }

    sendError(res, 404, `未知端点：${url.pathname}`);
  } catch (err) {
    log('请求处理失败:', err && err.stack ? err.stack : err);
    if (!res.headersSent) sendError(res, 500, err.message || '内部错误');
    else if (!res.writableEnded) res.destroy(err);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.on('error', (err) => {
  console.error('[dumate-proxy] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const auth = readAuthInfo();
  let modelCount = 0;
  let modelError = '';
  try {
    modelCount = readCatalog().length;
  } catch (err) {
    modelError = err.message;
  }
  log(`百度搭子反代已启动：http://${HOST}:${PORT}`);
  log(`桌面端目录：${APP_DATA}`);
  log(`登录态：${auth.loggedIn ? `已登录（${auth.name || maskId(auth.accountId) || '未知账号'}）` : '未登录（等桌面端登录后自动生效）'}`);
  log(modelError ? `模型目录：${modelError}` : `模型目录：${modelCount} 个模型`);
});

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
