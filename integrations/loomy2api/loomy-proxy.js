#!/usr/bin/env node
/**
 * loomy-proxy.js — 把讯飞 Loomy 的订阅额度暴露成本机 OpenAI 兼容端点。
 *
 * Loomy 桌面端（iFlytek Loomy）自己就是 opencode 套壳：它的 opencode 配置里有一个
 * 会话鉴权的 provider `imodel`，请求打到 `https://loomyad.xunfei.cn/api/v1`，
 * 靠桌面端登录态里的 session token 认证。这个代理做三件事：
 *
 *   1. 读 Loomy 桌面端落盘的登录态（auth-session.json），与其共用同一份额度；
 *   2. 把 opencode/pi 的 OpenAI 请求转发给 Loomy 网关，补齐会话鉴权与归因头；
 *   3. 把上游的模型清单、积分余额整理成稳定的本机接口。
 *
 * 端点：
 *   GET  /health             进程与登录态（不输出 token）
 *   GET  /v1/models          模型清单；?refresh=1 跳过缓存，?type=chat 只留对话模型
 *   GET  /v1/quota           积分余额 + 逐模型倍率（给 opencode 的 credits 插件用）
 *   GET  /v1/credits         同上（别名）
 *   POST /v1/chat/completions 对话，支持流式与工具调用（原样透传）
 *   *    /v1/*               其余 OpenAI 兼容路径原样透传
 *
 * 零依赖，只用 node: 内建模块；不写任何凭证文件。
 *
 * 用法：
 *   node loomy-proxy.js                  # 127.0.0.1:8791
 *   node loomy-proxy.js --port 8791
 *   LOOMY_AUTH_FILE=... LOOMY_UPSTREAM_BASE=... node loomy-proxy.js
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

// 本地限流：与网关共用 limits.json 的档位（见 integrations/limits/limiter.js）。
// 客户端可以绕过网关直连 :8791，所以反代自己也必须挡住「并行打上游」。
let createLimiterFor = null;
let LimiterBusy = null;
try {
  ({ createLimiterFor, LimiterBusy } = require('../limits/limiter.js'));
} catch {}

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const STARTED_AT = Date.now();

const DEFAULT_PORT = 8791;
const DEFAULT_BASE = 'https://loomyad.xunfei.cn/api/v1';
const CACHE_TTL_MS = Number(process.env.LOOMY_CACHE_MS || 60_000);
const SHORT_TIMEOUT_MS = Number(process.env.LOOMY_SHORT_TIMEOUT_MS || 20_000);
// Loomy 桌面端给 opencode 配的是 20 分钟；长任务不能被代理先掐断。
const CHAT_TIMEOUT_MS = Number(process.env.LOOMY_CHAT_TIMEOUT_MS || 1_200_000);
const MAX_BODY_BYTES = Number(process.env.LOOMY_MAX_BODY || 64 * 1024 * 1024);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PORT = Number(argValue('--port') || process.env.LOOMY_PORT || process.env.PORT || DEFAULT_PORT);
const HOST = String(process.env.LOOMY_HOST || '127.0.0.1');

// 与桌面端一致的配置根：Windows 是 C:\Users\Public\Loomy\<用户名 hash 前 12 位>。
function userHash() {
  return crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12);
}

function configRoot() {
  const override = String(process.env.LOOMY_CONFIG_ROOT || '').trim();
  if (override) return override;
  if (WIN) return path.join('C:', 'Users', 'Public', 'Loomy', userHash());
  return path.join(HOME, '.config', 'loomy');
}

function authCandidates() {
  const explicit = String(process.env.LOOMY_AUTH_FILE || '').trim();
  if (explicit) return [explicit];
  const root = configRoot();
  return [
    path.join(root, 'userData', 'auth-session.json'),
    path.join(HOME, '.config', 'loomy', 'auth-session.json'),
    path.join(HOME, 'AppData', 'Roaming', 'Loomy', 'auth-session.json'),
  ];
}

function authFile() {
  for (const file of authCandidates()) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return authCandidates()[0];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readAuth() {
  const data = readJson(authFile()) || {};
  const token = String(data.session || '').trim();
  if (!token) return null;
  return {
    token,
    userid: String(data.userid || '').trim(),
    phone: String(data.phone || '').trim(),
    updatedAt: Number(data.updatedAt) || 0,
  };
}

function maskPhone(phone) {
  const s = String(phone || '').trim();
  if (s.length < 7) return s ? `${s.slice(0, 2)}***` : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * 上游地址以 Loomy 桌面端当前的 opencode.json 为准：正式版是 loomyad.xunfei.cn，
 * 测试环境是 ossptest.voicecloud.cn。环境变量可强制覆盖。
 */
function upstreamBase() {
  const explicit = normalizeBase(process.env.LOOMY_UPSTREAM_BASE);
  if (explicit) return explicit;

  const root = configRoot();
  const files = [
    path.join(root, 'opencode', 'opencode.json'),
    path.join(root, 'opencode', 'opencode.json.bak'),
  ];
  for (const file of files) {
    const cfg = readJson(file);
    const base = normalizeBase(cfg && cfg.provider && cfg.provider.imodel
      && cfg.provider.imodel.options && cfg.provider.imodel.options.baseURL);
    if (base) return base;
  }
  return DEFAULT_BASE;
}

function readVersion() {
  const explicit = String(process.env.LOOMY_VERSION || '').trim();
  if (explicit) return explicit;

  const root = configRoot();
  for (const file of [
    path.join(root, 'opencode', 'last-app-version.txt'),
    path.join(root, 'userData', 'app-version.txt'),
  ]) {
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v) return v;
    } catch {}
  }

  for (const dir of [
    process.env.LOOMY_APP_DIR,
    'D:\\Loomy',
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Loomy'),
  ].filter(Boolean)) {
    const pkg = readJson(path.join(dir, 'resources', 'app.asar.unpacked', 'package.json'))
      || readJson(path.join(dir, 'resources', 'app', 'package.json'));
    const v = pkg && String(pkg.version || '').trim();
    if (v) return v;
  }
  return '0.9.39';
}

const UPSTREAM_BASE = upstreamBase();
const LOOMY_VERSION = readVersion();

/** 本地限流器；`LOOMY_LIMITS=off` 可临时关掉（调试用，别长期关）。 */
const LIMITER =
  createLimiterFor && String(process.env.LOOMY_LIMITS || '').toLowerCase() !== 'off'
    ? createLimiterFor('loomy')
    : null;

// ---------------------------------------------------------------- 归因头

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateTraceparent() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function headerValue(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) {
      const v = Array.isArray(value) ? value[0] : value;
      return String(v == null ? '' : v).trim();
    }
  }
  return '';
}

function pickHeader(headers, names) {
  for (const name of names) {
    const v = headerValue(headers, name);
    if (v) return v;
  }
  return '';
}

/**
 * Loomy 网关把 ChatId / MsgId / TurnId 用于积分归属，traceparent 缺失时
 * chat/completions 会挂到超时（桌面端源码里的注释已实测）。客户端如果自己
 * 带了这些头就原样继承，否则铸一套新的。
 */
function trackingHeaders(incoming, { stream = false } = {}) {
  const incomingTrace = pickHeader(incoming, ['traceparent']);
  const chatId = pickHeader(incoming, ['x-loomy-chat-id', 'ChatId', 'x-chat-id', 'x-session-id'])
    || `loomy-${randomHex(12)}`;
  const msgId = pickHeader(incoming, ['x-loomy-msg-id', 'MsgId'])
    || `msg-${randomHex(12)}`;
  const turnId = pickHeader(incoming, ['x-loomy-turn-id', 'TurnId']) || msgId;
  return {
    traceparent: TRACEPARENT_RE.test(incomingTrace) ? incomingTrace.toLowerCase() : generateTraceparent(),
    ChatId: chatId.slice(0, 256),
    MsgId: msgId.slice(0, 256),
    ...(turnId ? { TurnId: String(turnId).slice(0, 256) } : {}),
    'X-Loomy-Request-Purpose': 'chat.message',
    'loomy-version': LOOMY_VERSION,
    ...(stream ? { Accept: 'text/event-stream' } : { Accept: 'application/json' }),
  };
}

function buildUpstreamHeaders(incoming, auth, { stream = false } = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming || {})) {
    const lower = String(key).toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'host' || lower === 'authorization' || lower === 'token') continue;
    if (lower === 'content-length' || lower === 'accept-encoding') continue;
    if (lower === 'x-api-key') continue;
    if (Array.isArray(value)) headers[key] = value.join(', ');
    else if (value != null) headers[key] = String(value);
  }
  headers.Authorization = `Bearer ${auth.token}`;
  // Loomy 的积分接口和部分网关路由只认 token 这个头；两个都带最稳。
  headers.token = auth.token;
  headers['Content-Type'] = 'application/json';
  Object.assign(headers, trackingHeaders(incoming, { stream }));
  return headers;
}

// ---------------------------------------------------------------- HTTP 工具

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

function sendError(res, status, message, type = 'loomy_error') {
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

/** 统一的上游请求；返回 fetch Response（由调用方决定流式还是 JSON）。 */
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

/** 把 fetch 的响应原样写回客户端，去掉 hop-by-hop 与解码后不再成立的长度头。 */
/**
 * 把 fetch 的响应原样写回客户端，去掉 hop-by-hop 与解码后不再成立的长度头。
 *
 * **等到流真正写完才 resolve**：调用方据此释放本地限流的执行位。早期版本
 * `stream.pipe(res)` 之后立刻 return，流式对话还在传输时并发位就已经还了，
 * 等于没有并发限制。
 */
function pipeUpstream(res, upstream) {
  return new Promise((resolve) => {
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) return;
      // fetch 会自动解压，content-encoding/content-length 可能已不匹配
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
      // 客户端断开后停止读取上游；handleProxy 里的 AbortController 同时会取消 fetch。
      if (!res.writableEnded) {
        try { stream.destroy(); } catch {}
      }
      done();
    });
    stream.on('error', (err) => {
      // 客户端主动断开（opencode 取消、curl Ctrl-C）是正常路径，不刷错误日志。
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

// ---------------------------------------------------------------- 模型清单

let modelsCache = { at: 0, data: null };

async function fetchModels({ refresh = false } = {}) {
  if (!refresh && modelsCache.data && Date.now() - modelsCache.at < CACHE_TTL_MS) {
    return modelsCache.data;
  }
  const auth = readAuth();
  if (!auth) throw Object.assign(new Error('Loomy 未登录：找不到 auth-session.json 里的 session'), { status: 401 });
  const target = `${UPSTREAM_BASE}/models`;
  const upstream = await upstreamFetch(target, {
    method: 'GET',
    headers: buildUpstreamHeaders({}, auth),
    timeout: SHORT_TIMEOUT_MS,
  });
  const text = await upstream.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!upstream.ok) {
    const message = (data && (data.error && data.error.message)) || text.slice(0, 300) || `HTTP ${upstream.status}`;
    throw Object.assign(new Error(message), { status: upstream.status });
  }
  if (!data || !Array.isArray(data.data)) {
    throw Object.assign(new Error('Loomy /models 返回了无法识别的格式'), { status: 502 });
  }
  modelsCache = { at: Date.now(), data };
  return data;
}

function parseMultiplier(name) {
  // 上游把倍率写在展示名里：Spark-X2.6 正式版(限时免费)(x0.0) / qwen 3.8 flash（x0.8）
  const match = String(name || '').match(/[（(]\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)\s*[)）]/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function modelMultipliers(models) {
  const out = {};
  for (const model of Array.isArray(models) ? models : []) {
    const id = String(model && model.id || '').trim();
    if (!id) continue;
    const base = parseMultiplier(model.name);
    // 没有标倍率（生图模型、auto）就不放进表里，避免界面上显示“9 个模型有倍率”其实一半是未知。
    if (base === null) continue;
    out[id] = { base, effective: base, labels: [] };
  }
  return out;
}

// ---------------------------------------------------------------- 积分

async function handleQuota(res) {
  const auth = readAuth();
  if (!auth) {
    return sendJson(res, 401, {
      ok: false,
      error: {
        message: 'Loomy 未登录：请打开 Loomy 桌面端登录后重试',
        type: 'loomy_auth',
        code: 401,
      },
    });
  }

  let payload = null;
  let status = 200;
  try {
    const upstream = await upstreamFetch(`${UPSTREAM_BASE}/points/balance`, {
      method: 'GET',
      headers: buildUpstreamHeaders({}, auth),
      timeout: SHORT_TIMEOUT_MS,
    });
    status = upstream.status;
    payload = await upstream.json().catch(() => null);
  } catch (err) {
    return sendError(res, 502, `积分接口不可达：${err.message}`, 'loomy_network');
  }

  if (!payload || String(payload.code) !== '000000' || !payload.data) {
    const message = (payload && payload.desc) || `积分接口返回 HTTP ${status}`;
    const authFailed = /登录|session|token/i.test(message) || status === 401;
    return sendJson(res, authFailed ? 401 : 502, {
      ok: false,
      error: {
        message,
        type: authFailed ? 'loomy_auth' : 'loomy_upstream',
        code: payload && payload.code ? payload.code : status,
      },
    });
  }

  let models = [];
  try {
    const data = await fetchModels().catch(() => null);
    models = data && Array.isArray(data.data) ? data.data : [];
  } catch {}

  const balance = Number(payload.data.balance) || 0;
  const daily = Number(payload.data.dailyBalance) || 0;
  const available = Number(payload.data.availableBalance);
  const remaining = Number.isFinite(available) ? available : balance + daily;

  sendJson(res, 200, {
    ok: true,
    service: 'loomy',
    fetchedAt: new Date().toISOString(),
    user: {
      id: auth.userid || null,
      phone: maskPhone(auth.phone),
      updatedAt: auth.updatedAt || null,
    },
    // 上游没有给“总额”，只有当前可用额；total=0 表示分母未知，
    // 插件会因此只显示余量而不是编一个 100% 的进度条。
    balance: { remaining, total: 0, used: 0, unit: 'credits' },
    wallet: { balance, daily, available: remaining },
    multipliers: modelMultipliers(models),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      type: model.type || null,
      multiplier: parseMultiplier(model.name),
    })),
  });
}

// ---------------------------------------------------------------- 路由

async function handleModels(req, res, url) {
  const auth = readAuth();
  if (!auth) {
    return sendError(res, 401, 'Loomy 未登录：请打开 Loomy 桌面端登录后重试', 'loomy_auth');
  }
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  let data;
  try {
    data = await fetchModels({ refresh });
  } catch (err) {
    return sendError(res, err.status || 502, err.message || '获取模型列表失败', 'loomy_upstream');
  }

  let list = data.data;
  if (String(url.searchParams.get('type') || '').toLowerCase() === 'chat') {
    list = list.filter((model) => {
      const type = String(model && model.type || '').toLowerCase();
      return !type || type === 'chat';
    });
  }
  sendJson(res, 200, { ...data, data: list });
}

async function handleProxy(req, res, url, body) {
  const auth = readAuth();
  if (!auth) {
    return sendError(res, 401, 'Loomy 未登录：请打开 Loomy 桌面端登录后重试', 'loomy_auth');
  }

  let stream = false;
  if (body && body.length) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      stream = parsed && parsed.stream === true;
    } catch {}
  }

  const rest = url.pathname.replace(/^\/v1/, '') || '/';
  const target = `${UPSTREAM_BASE}${rest}${url.search}`;
  const ac = new AbortController();
  req.on('aborted', () => ac.abort());
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  // 本地限流：在发请求之前占一个执行位，挡「并行打上游」。
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
          'loomy_rate_limited',
        );
      }
      throw err;
    }
  }

  const started = Date.now();
  try {
    const upstream = await upstreamFetch(target, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, auth, { stream }),
      body: body && body.length ? body : undefined,
      timeout: CHAT_TIMEOUT_MS,
      signal: ac.signal,
    });
    log(`${req.method} ${url.pathname} → ${upstream.status} ${Date.now() - started}ms`);
    await pipeUpstream(res, upstream);
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    if (aborted) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    log(`${req.method} ${url.pathname} 失败：${err.message}`);
    if (!res.headersSent) {
      sendError(res, 502, `Loomy 上游不可达：${err.message}`, 'loomy_network');
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
    if (url.pathname === '/health') {
      const auth = readAuth();
      return sendJson(res, 200, {
        ok: true,
        service: 'loomy-proxy',
        version: LOOMY_VERSION,
        upstream: UPSTREAM_BASE,
        loggedIn: Boolean(auth),
        user: auth ? { id: auth.userid || null, phone: maskPhone(auth.phone) } : null,
        modelsCachedAt: modelsCache.data ? new Date(modelsCache.at).toISOString() : null,
        limits: LIMITER ? LIMITER.snapshot() : null,
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      });
    }

    if (url.pathname === '/v1/quota' || url.pathname === '/v1/credits' || url.pathname === '/admin/api/credits') {
      if (req.method !== 'GET') return sendError(res, 405, '只支持 GET');
      return await handleQuota(res);
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return await handleModels(req, res, url);
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
  console.error('[loomy-proxy] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const auth = readAuth();
  log(`Loomy 反代已启动：http://${HOST}:${PORT}`);
  log(`上游：${UPSTREAM_BASE}`);
  log(`登录态：${auth ? `已登录（${maskPhone(auth.phone) || auth.userid || '未知账号'}）` : '未登录（等桌面端登录后自动生效）'}`);
});

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));