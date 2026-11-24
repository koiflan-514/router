#!/usr/bin/env node
/**
 * lobster-proxy.js — 把有道龙虾（LobsterAI）的订阅额度暴露成本机 OpenAI 兼容端点。
 *
 * LobsterAI 桌面端本身已经有一条「模型代理」：Electron 主进程在 127.0.0.1 的随机端口上
 * 起一个 tokenProxy，把 `/v1/chat/completions` 转发到
 *
 *   https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions
 *
 * 并负责带上 access token、过期自动 refresh、客户端版本头与用量上报。桌面端把端口和
 * 入站 token 写在 `%APPDATA%\LobsterAI\openclaw\loopback-state.json`。
 *
 * 所以这里**不重复实现对话链路**：能用桌面端代理就优先用它（刷新、用量、限流都归它），
 * 桌面端没在跑时退回直连（access token 从桌面端 SQLite 的 `kv.auth_tokens` 读）。
 *
 * 代理只补三件事：
 *
 *   1. `/v1/models`              → 上游 `/api/models/available` + 两个虚拟模型（yd-fast / yd-ultra）
 *   2. `/v1/quota`               → 上游 `/api/subscription` + `/api/user/quota`（积分包、签到状态、倍率）
 *   3. `yd-fast` / `yd-ultra`    → 转发前先调 `/api/models/<id>/resolve` 换成真实模型
 *
 * 端点：
 *   GET  /health                进程、桌面端代理、登录态（不输出 token）
 *   GET  /v1/models             模型清单（?refresh=1 跳过缓存）
 *   GET  /v1/quota              积分余额 + 积分包 + 签到状态 + 逐模型倍率
 *   GET  /v1/credits            同上（别名）
 *   GET  /admin/api/credits     同上（别名，router 的 credits 插件统一入口）
 *   POST /v1/checkin            每日签到（真实领取积分，只由插件的 checkin 调用）
 *   POST /v1/chat/completions   对话，透传给桌面端代理或上游
 *   *    /v1/*                 其余 OpenAI 兼容路径原样透传
 *
 * 零依赖，只用 node: 内建模块。读 SQLite 需要 Node 22.5+ 的 `node:sqlite`；
 * 没有它时对话仍可用（走桌面端代理），只是 `/v1/quota` 会明确报「读不到凭据」。
 *
 * 用法：
 *   node lobster-proxy.js                  # 127.0.0.1:8797
 *   node lobster-proxy.js --port 8797
 *   LOBSTER_APP_DATA=... LOBSTER_UPSTREAM_BASE=... node lobster-proxy.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');

// 本地限流：直连 :8797 也必须限，不能只靠网关。
let createLimiterFor = null;
let LimiterBusy = null;
try {
  ({ createLimiterFor, LimiterBusy } = require(path.join(__dirname, '..', 'limits', 'limiter.js')));
} catch {}
const LIMITER =
  createLimiterFor && String(process.env.LOBSTER_LIMITS || '').toLowerCase() !== 'off'
    ? createLimiterFor('lobster')
    : null;

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}

const HOME = os.homedir();
const STARTED_AT = Date.now();

const DEFAULT_PORT = 8797;
const DEFAULT_UPSTREAM = 'https://lobsterai-server.youdao.com';
const CACHE_TTL_MS = Number(process.env.LOBSTER_CACHE_MS || 60_000);
const SHORT_TIMEOUT_MS = Number(process.env.LOBSTER_SHORT_TIMEOUT_MS || 20_000);
const CHAT_TIMEOUT_MS = Number(process.env.LOBSTER_CHAT_TIMEOUT_MS || 1_200_000);
const MAX_BODY_BYTES = Number(process.env.LOBSTER_MAX_BODY || 64 * 1024 * 1024);
const CLIENT_CAPABILITIES = [
  'virtual-models-v1',
  'kimi-k3-agentic-v1',
  'thinking-level-control-v1',
  'upstream-error-details-v1',
  'context-window-selection-v1',
].join(',');
const VIRTUAL_MODELS = new Set(['yd-fast', 'yd-ultra']);
const ACTIVITY_PLACEMENT = 'desktop_sidebar';
const ACTIVITY_CONTAINER_API_VERSION = '2';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PORT = Number(argValue('--port') || process.env.LOBSTER_PORT || process.env.PORT || DEFAULT_PORT);
const HOST = String(process.env.LOBSTER_HOST || '127.0.0.1');

// ---------------------------------------------------------------- 路径与登录态

function appDataDir() {
  const explicit = String(process.env.LOBSTER_APP_DATA || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'LobsterAI');
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'LobsterAI');
  }
  const native = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'LobsterAI');
  // 官方只发 Windows / macOS 版；Linux 上用 Wine 跑时，SQLite 登录态和
  // 桌面端 tokenProxy 的 loopback-state.json 都在 Wine prefix 的 AppData\Roaming 下。
  try {
    const { candidateDirs, firstExistingDir } = require('../wine-paths.js');
    const hit = firstExistingDir(
      candidateDirs({ explicitEnv: 'LOBSTER_APP_DATA', nativeDir: native, productNames: ['LobsterAI'] }),
    );
    if (hit) return hit.dir;
  } catch {}
  return native;
}

const APP_DATA = appDataDir();
const DB_FILE = path.join(APP_DATA, 'lobsterai.sqlite');
const LOOPBACK_FILE = path.join(APP_DATA, 'openclaw', 'loopback-state.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 桌面端 loopback-state.json：端口 + 代理 token + 应用版本。每次读，文件很小。 */
function readLoopback() {
  const doc = readJson(LOOPBACK_FILE);
  const ports = doc && doc.ports && typeof doc.ports === 'object' ? doc.ports : {};
  const port = Number(ports.tokenProxy) || 0;
  const token = doc && typeof doc.proxyToken === 'string' ? doc.proxyToken.trim() : '';
  if (!port || !token) return null;
  return {
    port,
    token,
    appVersion: doc.appVersion ? String(doc.appVersion) : '',
    compatPort: Number(ports.compatProxy) || 0,
    updatedAt: Number(doc.updatedAt) || 0,
  };
}

/** 读桌面端 SQLite 的 kv[key]；没有 node:sqlite 或数据库不存在时返回 null。 */
function readKv(key) {
  if (!DatabaseSync) return null;
  let db = null;
  try {
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    const row = db.prepare('select value from kv where key = ?').get(key);
    return row && typeof row.value === 'string' ? row.value : null;
  } catch {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
}

function readKvJson(key) {
  const text = readKv(key);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 登录态：access/refresh token、用户信息、keyfrom 归因（refresh 要用）。 */
function readDesktopAuth({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && authCache.data && now - authCache.at < 3000) return authCache.data;

  const tokens = readKvJson('auth_tokens');
  const accessToken = tokens && typeof tokens.accessToken === 'string' ? tokens.accessToken.trim() : '';
  const refreshToken = tokens && typeof tokens.refreshToken === 'string' ? tokens.refreshToken.trim() : '';
  const user = readKvJson('auth_user') || {};
  const attribution = readKvJson('keyfrom.attribution.v1') || {};
  const uuidRow = readKv('installation_uuid');
  let uuid = '';
  try {
    uuid = uuidRow ? JSON.parse(uuidRow) : '';
  } catch {
    uuid = uuidRow || '';
  }
  const payload = jwtPayload(accessToken);
  const expiresAt = payload && Number(payload.exp) ? Number(payload.exp) * 1000 : null;

  const data = accessToken
    ? {
        accessToken,
        refreshToken,
        expiresAt,
        userId: String(user.userId || (payload && payload.sub) || ''),
        yid: String(user.yid || ''),
        nickname: String(user.nickname || ''),
        accountMode: String(user.accountMode || (payload && payload.accountMode) || 'personal'),
        keyfrom: {
          firstKeyfrom: String(attribution.firstKeyfrom || 'official'),
          latestKeyfrom: String(attribution.latestKeyfrom || 'official'),
          uuid: String(uuid || ''),
        },
        source: 'desktop-sqlite',
      }
    : null;

  authCache = { at: now, data };
  return data;
}

let authCache = { at: 0, data: null };
let refreshedAuth = null;

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const UPSTREAM_BASE = normalizeBase(process.env.LOBSTER_UPSTREAM_BASE) || DEFAULT_UPSTREAM;

function maskId(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  return s.length <= 8 ? s : `${s.slice(0, 8)}…`;
}

function accountModeLabel(value) {
  return String(value || '').trim() === 'enterprise' ? '企业版' : '个人版';
}

// ---------------------------------------------------------------- HTTP 工具

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);

function log(...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}]`, ...args);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendError(res, status, message, type = 'lobster_error') {
  sendJson(res, status, { ok: false, error: { message, type, code: status } });
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

function clientHeaders(version, { stream = false } = {}) {
  return {
    'X-LobsterAI-Client-Capabilities': CLIENT_CAPABILITIES,
    ...(version ? { 'X-LobsterAI-Client-Version': version } : {}),
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
}

/** 直连上游：带 access token；401 时尝试 refresh 后重试一次。 */
async function upstreamFetch(target, { method = 'GET', body, timeout = SHORT_TIMEOUT_MS, stream = false, signal } = {}) {
  let auth = readDesktopAuth({ fresh: true }) || refreshedAuth;
  const loopback = readLoopback();
  const version = loopback && loopback.appVersion ? loopback.appVersion : '';
  const doFetch = async (token) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...clientHeaders(version, { stream }),
    };
    const timeoutSignal = AbortSignal.timeout(timeout);
    const composed = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    return fetch(target, { method, headers, body, signal: composed, redirect: 'follow' });
  };

  if (!auth || !auth.accessToken) throw Object.assign(new Error('未登录有道龙虾（读不到 access token）'), { status: 401 });
  let response = await doFetch(auth.accessToken);
  if (response.status === 401 && auth.refreshToken) {
    const next = await refreshAccessToken(auth);
    if (next) {
      auth = next;
      response = await doFetch(next.accessToken);
    }
  }
  return { response, auth };
}

async function refreshAccessToken(auth) {
  try {
    const body = JSON.stringify({
      refreshToken: auth.refreshToken,
      firstKeyfrom: auth.keyfrom.firstKeyfrom,
      latestKeyfrom: auth.keyfrom.latestKeyfrom,
      ...(auth.keyfrom.uuid ? { uuid: auth.keyfrom.uuid } : {}),
      ...(auth.userId ? { userId: auth.userId } : {}),
      version: readLoopback() && readLoopback().appVersion ? readLoopback().appVersion : '',
    });
    const response = await fetch(`${UPSTREAM_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...clientHeaders() },
      body,
      signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    const data = payload && payload.data ? payload.data : null;
    const accessToken = data && (data.accessToken || data.access_token);
    const refreshToken = data && (data.refreshToken || data.refresh_token);
    if (!response.ok || !payload || payload.code !== 0 || !accessToken) return null;
    refreshedAuth = {
      ...auth,
      accessToken: String(accessToken),
      refreshToken: refreshToken ? String(refreshToken) : auth.refreshToken,
      expiresAt: jwtPayload(accessToken) && jwtPayload(accessToken).exp ? jwtPayload(accessToken).exp * 1000 : null,
    };
    log('access token 已刷新（只在内存里用，不写桌面端数据库）');
    return refreshedAuth;
  } catch (err) {
    log('access token 刷新失败：', err.message);
    return null;
  }
}

/** 上游 JSON API（models / quota / profile / activities），自动处理 401 刷新。 */
async function apiJson(pathname, { method = 'GET', body, timeout = SHORT_TIMEOUT_MS } = {}) {
  const { response } = await upstreamFetch(`${UPSTREAM_BASE}${pathname}`, {
    method,
    body,
    timeout,
    stream: false,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  return { response, payload, text };
}

/** 把 fetch 的响应原样写回客户端；流真正写完才 resolve。 */
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

/**
 * 对话转发：优先用桌面端 tokenProxy（它负责 refresh、用量与版本头）；
 * 连不上时退回直连。两边路径同构，都是 `/v1/...`。
 */
async function forwardChat(req, res, url, body, { stream = false } = {}) {
  const loopback = readLoopback();
  const ac = new AbortController();
  req.on('aborted', () => ac.abort());
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  if (loopback) {
    try {
      const headers = {
        Authorization: `Bearer ${loopback.token}`,
        'Content-Type': 'application/json',
        ...(req.headers.accept ? { Accept: String(req.headers.accept) } : clientHeaders(loopback.appVersion, { stream })),
      };
      const target = `http://127.0.0.1:${loopback.port}${url.pathname}${url.search}`;
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: body && body.length ? body : undefined,
        signal: AbortSignal.any
          ? AbortSignal.any([ac.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)])
          : AbortSignal.timeout(CHAT_TIMEOUT_MS),
        redirect: 'follow',
      });
      log(`${req.method} ${url.pathname} → 桌面端代理 ${upstream.status}`);
      await pipeUpstream(res, upstream);
      return;
    } catch (err) {
      // ECONNREFUSED 等：桌面端可能刚退出，落回直连；其它错误也落回，直连会给出更准确的错
      log(`桌面端代理不可用（${err.code || err.message}），改直连上游`);
    }
  }

  const target = `${UPSTREAM_BASE}/api/proxy${url.pathname}${url.search}`;
  try {
    const { response } = await upstreamFetch(target, {
      method: req.method,
      body: body && body.length ? body : undefined,
      timeout: CHAT_TIMEOUT_MS,
      stream,
      signal: ac.signal,
    });
    log(`${req.method} ${url.pathname} → 上游 ${response.status}`);
    await pipeUpstream(res, response);
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    if (aborted) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    log(`${req.method} ${url.pathname} 失败：${err.message}`);
    if (!res.headersSent) {
      sendError(res, err.status || 502, `有道龙虾上游不可达：${err.message}`, 'lobster_network');
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  }
}

// ---------------------------------------------------------------- 模型清单

let catalogCache = { at: 0, data: null };

function virtualModel(id) {
  return {
    id,
    object: 'model',
    owned_by: 'lobster',
    name: id === 'yd-fast' ? '快速（自动选模型）' : '旗舰（自动选模型）',
    description: id === 'yd-fast'
      ? 'LobsterAI 的快速档：按会话自动路由到当前最合适的模型'
      : 'LobsterAI 的旗舰档：按会话自动路由到能力更强的模型',
    context_window: 400000,
    max_output_tokens: 32768,
    capabilities: { vision: true, reasoning: true, tools: true },
    tags: ['virtual', 'reasoning', 'vision'],
    virtual: true,
  };
}

/** `/api/models/available` → OpenAI /v1/models 条目。 */
function availableToModels(payload) {
  const rows = payload && payload.data && Array.isArray(payload.data) ? payload.data : [];
  const out = [virtualModel('yd-fast'), virtualModel('yd-ultra')];
  for (const model of rows) {
    const id = String(model && model.modelId || '').trim();
    if (!id || VIRTUAL_MODELS.has(id)) continue;
    const caps = {
      vision: model.supportsImage === true,
      reasoning: model.supportsThinking === true,
      // 上游没给 supportsToolCalling 时按 LobsterAI 桌面端默认「能调工具」处理
      tools: model.supportsToolCalling !== false,
    };
    out.push({
      id,
      object: 'model',
      owned_by: 'lobster',
      name: model.modelName || id,
      description: model.description || '',
      context_window: Number(model.contextWindow) || null,
      max_output_tokens: null,
      capabilities: caps,
      tags: [
        caps.vision ? 'vision' : '',
        caps.reasoning ? 'reasoning' : '',
        model.limitedFreeActive ? 'limited-free' : '',
      ].filter(Boolean),
      visible: model.accessible !== false,
      default: id === 'deepseek-flash',
      busy: model.busy === true,
      cost_multiplier: Number(model.costMultiplier) || null,
      limited_free: model.limitedFree === true,
      limited_free_active: model.limitedFreeActive === true,
      limited_free_end: model.limitedFreeEndAt || null,
      api_format: model.apiFormat || 'openai',
    });
  }
  return out;
}

async function fetchCatalog({ refresh = false } = {}) {
  if (!refresh && catalogCache.data && Date.now() - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache.data;
  }
  const { response, payload } = await apiJson('/api/models/available');
  if (!response.ok) {
    const message = payload && (payload.message || payload.error) || `HTTP ${response.status}`;
    throw Object.assign(new Error(`模型目录不可达：${message}`), { status: response.status });
  }
  if (!payload || payload.code !== 0 || !Array.isArray(payload.data)) {
    throw Object.assign(new Error('有道龙虾模型目录返回了无法识别的格式'), { status: 502 });
  }
  const models = availableToModels(payload);
  catalogCache = { at: Date.now(), data: models };
  return models;
}

// ---------------------------------------------------------------- 虚拟模型解析

const resolveCache = new Map();

function hasImageInput(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') return true;
    }
  }
  return false;
}

async function resolveVirtualModel(modelId, body) {
  const requiresImage = hasImageInput(body);
  const key = `${modelId}:${requiresImage ? 'image' : 'text'}`;
  const cached = resolveCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.modelId;

  const { response, payload } = await apiJson(`/api/models/${encodeURIComponent(modelId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: `router-lobster-${process.pid}`, requiresImage }),
    timeout: 30_000,
  });
  const data = payload && payload.data ? payload.data : null;
  const model = data && (data.modelId || data.model);
  if (!response.ok || !payload || payload.code !== 0 || !model || VIRTUAL_MODELS.has(model)) {
    throw Object.assign(new Error((payload && payload.message) || '虚拟模型解析失败'), {
      status: response.status || 502,
    });
  }
  resolveCache.set(key, { at: Date.now(), modelId: String(model) });
  return String(model);
}

// ---------------------------------------------------------------- 积分与签到

function shanghaiTime(value) {
  if (!value) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 积分包的人话标签：优先用上游的活动名（例如「每日登录奖励」）。 */
function packLabel(pack) {
  const name = String(pack.boostPackName || pack.boostPackNameEn || '').trim();
  const source = String(pack.rewardSource || '').trim();
  if (name) return name;
  if (source) return source;
  if (String(pack.type || '') === 'campaign') return '活动赠送';
  return '积分包';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

const quotaCache = { at: 0, data: null };

async function fetchQuota({ refresh = false } = {}) {
  if (!refresh && quotaCache.data && Date.now() - quotaCache.at < 15_000) {
    return quotaCache.data;
  }

  const auth = readDesktopAuth({ fresh: true }) || refreshedAuth;
  if (!auth) {
    throw Object.assign(new Error('未登录有道龙虾：打开 LobsterAI 桌面端登录后重试'), { status: 401 });
  }

  const [subResult, quotaResult, profileResult] = await Promise.all([
    apiJson('/api/subscription').catch((err) => ({ response: { ok: false, status: 0 }, payload: null, error: err })),
    apiJson('/api/user/quota').catch((err) => ({ response: { ok: false, status: 0 }, payload: null, error: err })),
    apiJson('/api/user/profile').catch(() => ({ response: { ok: false, status: 0 }, payload: null })),
  ]);

  const subBody = subResult && subResult.payload && subResult.payload.code === 0 ? subResult.payload.data : null;
  const quotaBody = quotaResult && quotaResult.payload && quotaResult.payload.code === 0 ? quotaResult.payload.data : null;
  if (!subBody && !quotaBody) {
    const detail = (subResult.error && subResult.error.message)
      || (subResult.payload && subResult.payload.message)
      || (quotaResult.payload && quotaResult.payload.message)
      || '额度接口不可达';
    throw Object.assign(new Error(detail), { status: subResult.response.status || 502 });
  }
  const profile = profileResult && profileResult.payload && profileResult.payload.code === 0
    ? profileResult.payload.data
    : null;

  const sub = subBody || {};
  const quota = quotaBody || {};

  const boostRemaining = round2(sub.boostCreditsRemaining ?? quota.boostCreditsRemaining);
  const monthlyRemaining = round2(sub.monthlyCreditsRemaining ?? quota.monthlyCreditsRemaining);
  const bonusRemaining = round2(sub.bonusCreditsRemaining ?? quota.bonusCreditsRemaining);
  const trialRemaining = round2(sub.trial && sub.trial.active ? sub.trial.creditsRemaining : 0);

  const packs = (Array.isArray(sub.boostCreditsRecords) ? sub.boostCreditsRecords : [])
    .filter((p) => p && String(p.status || 'active') === 'active' && num(p.creditsTotal) > 0);
  const packTotal = packs.reduce((sum, p) => sum + num(p.creditsTotal), 0);
  const monthlyLimit = round2(sub.monthlyCreditsLimit ?? quota.monthlyCreditsLimit);
  const bonusLimit = round2(sub.bonusCreditsLimit ?? quota.bonusCreditsLimit);

  // 「总量」用本轮实际发放的积分包 + 月度额度；试用积分已经包含在 boost 包里，
  // 不要再加一次（否则同 1000 分会被算成 2000）。
  const total = round2(packTotal + monthlyLimit + bonusLimit);
  const remaining = round2(boostRemaining + monthlyRemaining + bonusRemaining);
  const used = total > 0 ? round2(Math.max(0, total - remaining)) : 0;

  const buckets = packs.map((p) => ({
    id: String(p.id || p.rewardSource || packLabel(p)),
    label: packLabel(p),
    total: round2(p.creditsTotal),
    used: round2(p.creditsUsed),
    remaining: round2(p.creditsRemaining),
    unit: 'credits',
    cycleEnd: shanghaiTime(p.expiredAt),
    status: p.status || null,
  }));

  let models = [];
  try {
    models = await fetchCatalog({ refresh });
  } catch {}

  const multipliers = {};
  for (const model of models) {
    if (model.virtual) continue;
    const base = model.cost_multiplier;
    if (base === null || base === undefined) continue;
    const labels = [];
    if (model.limited_free_active) labels.push('限时免费');
    multipliers[model.id] = {
      base,
      effective: model.limited_free_active ? 0 : base,
      labels,
      status: model.busy ? 'busy' : 'normal',
    };
  }

  const checkin = await fetchCheckinStatus().catch(() => null);

  const name = String((profile && (profile.nickname || profile.yid)) || auth.nickname || auth.yid || '').trim();
  const data = {
    ok: true,
    service: 'lobster',
    fetchedAt: new Date().toISOString(),
    user: {
      id: String((profile && profile.id) || auth.userId || ''),
      name: name || `用户 ${maskId(auth.userId)}`,
      yid: String((profile && profile.yid) || auth.yid || ''),
      accountMode: accountModeLabel(auth.accountMode),
      plan: sub.planName || quota.planName || '',
      planEn: sub.planNameEn || '',
      subscriptionStatus: sub.subscriptionStatus || quota.subscriptionStatus || '',
      subscriptionProvider: sub.subscriptionProvider || quota.subscriptionProvider || '',
      periodEnd: shanghaiTime(sub.currentPeriodEnd),
      expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
    },
    balance: { remaining, total, used, unit: 'credits' },
    wallet: {
      boost: boostRemaining,
      monthly: monthlyRemaining,
      bonus: bonusRemaining,
      trial: trialRemaining,
      boostTotal: round2(packTotal),
      monthlyLimit,
      bonusLimit,
    },
    buckets,
    multipliers,
    multiplierNote: Object.keys(multipliers).length ? undefined : '上游没有返回逐模型倍率',
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      multiplier: model.virtual ? null : model.cost_multiplier,
      tags: model.tags,
      virtual: !!model.virtual,
    })),
    checkin: checkin
      ? {
          supported: true,
          claimed: checkin.claimed === true,
          claimable: checkin.claimable === true,
          reward: checkin.reward,
          streak: 0,
          note: checkin.note || null,
        }
      : {
          supported: true,
          claimed: false,
          claimable: false,
          reward: 0,
          note: '签到活动暂不可用',
        },
  };

  quotaCache.at = Date.now();
  quotaCache.data = data;
  return data;
}

const activityCache = { at: 0, data: null };

async function fetchCheckinStatus({ refresh = false } = {}) {
  if (!refresh && activityCache.data && Date.now() - activityCache.at < CACHE_TTL_MS) {
    return activityCache.data;
  }
  const query = new URLSearchParams({
    placement: ACTIVITY_PLACEMENT,
    clientVersion: (readLoopback() && readLoopback().appVersion) || '',
    containerApiVersion: ACTIVITY_CONTAINER_API_VERSION,
    platform: process.platform,
  });
  const slot = await apiJson(`/api/client-activities/slot?${query.toString()}`);
  const slotData = slot.payload && slot.payload.code === 0 ? slot.payload.data : null;
  const activity = slotData && slotData.activity;
  if (!activity || slotData.slotState !== 'available') {
    const data = { available: false, claimed: false, claimable: false, reward: 0, note: '当前没有签到活动', activity: null };
    activityCache.at = Date.now();
    activityCache.data = data;
    return data;
  }

  const contextQuery = new URLSearchParams({ configRevision: String(activity.configRevision) });
  const context = await apiJson(
    `/api/client-activities/${encodeURIComponent(activity.activityCode)}/context?${contextQuery.toString()}`,
  );
  const state = context.payload && context.payload.code === 0 && context.payload.data
    ? context.payload.data
    : null;
  const info = state && state.state ? state.state : {};
  const actions = state && Array.isArray(state.actions) ? state.actions : [];
  const claimed = info.claimedToday === true || info.completed === true;
  const claimable = state && state.authenticated === true && !claimed && actions.includes('check_in');
  const data = {
    available: true,
    activityCode: activity.activityCode,
    configRevision: activity.configRevision,
    templateKey: activity.templateKey || '',
    claimed,
    claimable,
    reward: round2(info.rewardCredits),
    claimedCredits: round2(info.claimedCredits),
    note: claimed ? null : claimable ? null : '今日不可领',
    activity,
    state: info,
    actions,
  };
  activityCache.at = Date.now();
  activityCache.data = data;
  return data;
}

/** 每日签到：真实领取积分。只在插件的 checkin:true 路径里被调用。 */
async function runCheckin() {
  const status = await fetchCheckinStatus({ refresh: true });
  if (!status.available) return { ok: false, claimed: false, reason: status.note || '当前没有签到活动' };
  if (status.claimed) {
    return {
      ok: true,
      claimed: false,
      detail: `今日已签到${status.reward > 0 ? `（+${status.reward}）` : ''}`,
    };
  }
  if (!status.claimable) return { ok: false, claimed: false, reason: '今日不可领（未登录或活动已结束）' };

  const body = JSON.stringify({
    configRevision: status.configRevision,
    idempotencyKey: `router-lobster-checkin-${randomUUID()}`.slice(0, 64),
    payload: {},
  });
  const { response, payload } = await apiJson(
    `/api/client-activities/${encodeURIComponent(status.activityCode)}/actions/check_in`,
    { method: 'POST', body, timeout: 30_000 },
  );
  const code = payload && Number(payload.code);
  if (!response.ok || !payload || payload.code !== 0) {
    if (code === 51104) {
      activityCache.at = 0;
      return { ok: true, claimed: false, detail: '今日已签到' };
    }
    return {
      ok: false,
      claimed: false,
      reason: (payload && payload.message) || `签到接口返回 HTTP ${response.status}`,
    };
  }
  activityCache.at = 0;
  quotaCache.at = 0;
  await fetchCheckinStatus({ refresh: true }).catch(() => {});
  const reward = payload.data && Number(payload.data.rewardCredits);
  return {
    ok: true,
    claimed: true,
    detail: reward > 0 ? `+${round2(reward)}` : '已领取',
  };
}

// ---------------------------------------------------------------- 路由

async function handleModels(req, res, url) {
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  try {
    const models = await fetchCatalog({ refresh });
    sendJson(res, 200, { object: 'list', data: models });
  } catch (err) {
    sendError(res, err.status || 502, err.message || '获取模型列表失败', 'lobster_upstream');
  }
}

async function handleQuota(req, res, url) {
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  try {
    const data = await fetchQuota({ refresh });
    sendJson(res, 200, data);
  } catch (err) {
    const authFailed = err.status === 401 || /未登录|token|authorization/i.test(err.message || '');
    sendError(res, authFailed ? 401 : 502, err.message || '额度接口不可达', authFailed ? 'lobster_auth' : 'lobster_upstream');
  }
}

async function handleChat(req, res, url, body) {
  let stream = false;
  let parsed = null;
  if (body && body.length) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
      stream = parsed && parsed.stream === true;
    } catch {}
  }

  // 虚拟模型（yd-fast / yd-ultra）先解析成真实模型，再转发。
  if (parsed && VIRTUAL_MODELS.has(String(parsed.model || ''))) {
    try {
      const real = await resolveVirtualModel(String(parsed.model), parsed);
      parsed.model = real;
      body = Buffer.from(JSON.stringify(parsed));
      res.setHeader('X-LobsterAI-Resolved-Model', real);
      log(`虚拟模型 ${String(parsed.model)} → ${real}`);
    } catch (err) {
      return sendError(res, err.status || 502, err.message || '虚拟模型解析失败', 'lobster_resolve');
    }
  }

  await forwardChat(req, res, url, body, { stream });
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
    if (url.pathname === '/health') {
      const auth = readDesktopAuth({ fresh: true });
      let proxyUp = false;
      const loopback = readLoopback();
      if (loopback) {
        try {
          const probe = await fetch(`http://127.0.0.1:${loopback.port}/health`, {
            headers: { Authorization: `Bearer ${loopback.token}` },
            signal: AbortSignal.timeout(1500),
          });
          // `/health` 在 tokenProxy 上不存在，404 也说明端口活着；502/连接错误才算不在
          proxyUp = probe.status !== 0;
        } catch {
          proxyUp = false;
        }
      }
      return sendJson(res, 200, {
        ok: true,
        service: 'lobster-proxy',
        upstream: UPSTREAM_BASE,
        appData: APP_DATA,
        desktop: loopback
          ? { proxyPort: loopback.port, proxyUp, appVersion: loopback.appVersion }
          : null,
        loggedIn: Boolean(auth),
        user: auth
          ? {
              id: maskId(auth.userId),
              name: auth.nickname || auth.yid || '',
              mode: accountModeLabel(auth.accountMode),
              expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
              expired: auth.expiresAt ? auth.expiresAt <= Date.now() : false,
            }
          : null,
        modelsCachedAt: catalogCache.data ? new Date(catalogCache.at).toISOString() : null,
        limits: LIMITER ? LIMITER.snapshot() : null,
        sqlite: DatabaseSync ? 'node:sqlite' : 'unavailable',
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      });
    }

    if (url.pathname === '/v1/quota' || url.pathname === '/v1/credits' || url.pathname === '/admin/api/credits') {
      if (req.method !== 'GET') return sendError(res, 405, '只支持 GET');
      return await handleQuota(req, res, url);
    }

    if (url.pathname === '/v1/checkin') {
      if (req.method !== 'POST') return sendError(res, 405, '只支持 POST');
      try {
        const result = await runCheckin();
        return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
      } catch (err) {
        return sendError(res, err.status || 502, err.message || '签到失败', 'lobster_checkin');
      }
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return await handleModels(req, res, url);
    }

    if (url.pathname.startsWith('/v1/')) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
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
              'lobster_rate_limited',
            );
          }
          throw err;
        }
      }
      try {
        return await handleChat(req, res, url, body);
      } finally {
        if (release) release();
      }
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
  console.error('[lobster-proxy] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const auth = readDesktopAuth({ fresh: true });
  const loopback = readLoopback();
  log(`有道龙虾反代已启动：http://${HOST}:${PORT}`);
  log(`桌面端代理：${loopback ? `127.0.0.1:${loopback.port}（v${loopback.appVersion || '?'}）` : '未运行（直接连上游）'}`);
  log(
    `登录态：${auth
      ? `已登录（${auth.nickname || auth.yid || maskId(auth.userId)}${auth.expiresAt ? `，token 到期 ${new Date(auth.expiresAt).toISOString().slice(0, 10)}` : ''}）`
      : '未登录（打开 LobsterAI 桌面端登录后自动生效）'}`,
  );
  if (!DatabaseSync) log('警告：当前 Node 没有 node:sqlite，/v1/quota 读不到桌面端凭据');
});

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));