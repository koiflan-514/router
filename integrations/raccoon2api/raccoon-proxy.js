#!/usr/bin/env node
/**
 * raccoon-proxy.js — 把商汤小浣熊（Raccoon Work）桌面端的订阅额度暴露成本机
 * OpenAI 兼容端点。
 *
 * 上游本来就「说 OpenAI」：桌面端 box-agent 的 `config.yaml` 里写死了
 *
 *   provider: openai
 *   api_base: https://xiaohuanxiong.com/api/web/llm/v2
 *   model:    raccoon-090dd3
 *
 * 所以这里**不做任何协议转换**，只做四件事：
 *
 *   1. 读桌面端落盘的登录态（agent/config/auth.json 的 access_token），与桌面端
 *      共用同一份额度；
 *   2. 把 `/v1/chat/completions` 原样转发到上游的 `/chat/completions`，流式与非
 *      流式都不碰 body；
 *   3. 把上游的 `model_catalog`（模型清单 + 逐模型倍率）整理成 `/v1/models`；
 *   4. 把 `points/v1/balance`（积分余额）整理成 `/v1/quota`，给 opencode 的
 *      credits 插件与 TUI 额度页用。
 *
 * 端点：
 *   GET  /health               进程与登录态（不输出 token）
 *   GET  /v1/models            模型清单；?refresh=1 跳过缓存，?type=chat 只留对话模型
 *   GET  /v1/quota             积分余额 + 逐模型倍率
 *   GET  /v1/credits           同上（别名）
 *   POST /v1/chat/completions  对话，原样透传（流式/工具调用都由上游处理）
 *   POST /v1/images/generations 生图，映射到上游 /images/gen
 *   *    /v1/*                其余 OpenAI 兼容路径原样透传
 *
 * 零依赖，只用 node: 内建模块；不写任何凭证文件。
 *
 * 用法：
 *   node raccoon-proxy.js                  # 127.0.0.1:8793
 *   node raccoon-proxy.js --port 8793
 *   RACCOON_AUTH_FILE=... RACCOON_UPSTREAM_BASE=... node raccoon-proxy.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

// 本地限流：读同一个 limits.json，与网关用同一套档位（见 integrations/limits/limiter.js）。
// 为什么反代自己也要限：客户端可以绕过网关直连 :8793，那时只有这一层能挡住
// 「开 10 个子代理并行打上游」——上游看到的是同一个账号的 10 路并发，判定为套流。
let createLimiterFor = null;
let LimiterBusy = null;
try {
  ({ createLimiterFor, LimiterBusy } = require('../limits/limiter.js'));
} catch {}

const HOME = os.homedir();
const STARTED_AT = Date.now();

const DEFAULT_PORT = 8793;
const DEFAULT_BASE = 'https://xiaohuanxiong.com/api/web/llm/v2';
const CACHE_TTL_MS = Number(process.env.RACCOON_CACHE_MS || 60_000);
const SHORT_TIMEOUT_MS = Number(process.env.RACCOON_SHORT_TIMEOUT_MS || 20_000);
// 桌面端给 opencode/box-agent 配的是 20 分钟；长任务不能被代理先掐断。
const CHAT_TIMEOUT_MS = Number(process.env.RACCOON_CHAT_TIMEOUT_MS || 1_200_000);
const MAX_BODY_BYTES = Number(process.env.RACCOON_MAX_BODY || 64 * 1024 * 1024);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PORT = Number(argValue('--port') || process.env.RACCOON_PORT || process.env.PORT || DEFAULT_PORT);
const HOST = String(process.env.RACCOON_HOST || '127.0.0.1');

// ---------------------------------------------------------------- 登录态

/**
 * 桌面端把 IAM access token 写在 agent/config/auth.json：
 *
 *   { "access_token": "<JWT>", "office_identity": "personal" }
 *
 * 候选路径按平台给全，不能只写 Windows 那一条：
 *   Windows  ~/.office-raccoon/agent/config/auth.json（桌面端默认 agent home）
 *            ~/.box-agent/config/auth.json（旧版 OfficeV3）
 *   Linux/macOS 桌面端把 agent home 放在 Electron 的 userData 下：
 *            ~/.config/office-raccoon/agent/config/auth.json
 *            ~/Library/Application Support/office-raccoon/agent/config/auth.json
 * 只认前两条时，Linux 上装了桌面端也会一直报「未登录」。
 */
function authCandidates() {
  const explicit = String(process.env.RACCOON_AUTH_FILE || '').trim();
  if (explicit) return [explicit];
  const out = [];
  if (process.platform !== 'win32') {
    const configRoot = process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
    out.push(path.join(configRoot, 'office-raccoon', 'agent', 'config', 'auth.json'));
    // Linux 上桌面端也可能用 .box-agent 作为 harness home
    out.push(path.join(configRoot, 'box-agent', 'config', 'auth.json'));
  }
  out.push(
    path.join(HOME, '.office-raccoon', 'agent', 'config', 'auth.json'),
    path.join(HOME, '.box-agent', 'config', 'auth.json'),
  );
  return out;
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

/** JWT 的 payload 段；解不开就当没有。只用于显示到期时间，不验签。 */
function jwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function readAuth() {
  const explicit = String(process.env.RACCOON_ACCESS_TOKEN || '').trim();
  if (explicit) {
    const payload = jwtPayload(explicit);
    return {
      token: explicit,
      file: null,
      identity: 'personal',
      subject: (payload && payload.sub) || '',
      expiresAt: payload && Number(payload.exp) ? Number(payload.exp) * 1000 : null,
    };
  }
  const file = authFile();
  const data = readJson(file) || {};
  const token = String(data.access_token || data.token || data.auth_token || '').trim();
  if (!token) return null;
  const payload = jwtPayload(token);
  return {
    token,
    file,
    identity: String(data.office_identity || '').trim() || 'personal',
    subject: (payload && payload.sub) || '',
    expiresAt: payload && Number(payload.exp) ? Number(payload.exp) * 1000 : null,
  };
}

function maskSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return '';
  return `${s.slice(0, 8)}…`;
}

function identityLabel(identity) {
  const v = String(identity || '').trim();
  if (!v || v === 'personal') return '个人版';
  return v;
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const UPSTREAM_BASE = normalizeBase(process.env.RACCOON_UPSTREAM_BASE) || DEFAULT_BASE;
const UPSTREAM_ORIGIN = (() => {
  try {
    return new URL(UPSTREAM_BASE).origin;
  } catch {
    return 'https://xiaohuanxiong.com';
  }
})();

/** 本地限流器；`RACCOON_LIMITS=off` 可临时关掉（调试用，别长期关）。 */
const LIMITER =
  createLimiterFor && String(process.env.RACCOON_LIMITS || '').toLowerCase() !== 'off'
    ? createLimiterFor('raccoon')
    : null;

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

function sendError(res, status, message, type = 'raccoon_error') {
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

function upstreamHeaders(auth, { stream = false } = {}) {
  return {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
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
 * **等到流真正写完才 resolve**：调用方用它的返回值来判断「这一路请求结束了」，
 * 据此释放本地限流的执行位。早期版本 `stream.pipe(res)` 之后立刻 return，
 * 于是流还在传输时并发位就已经还了——流式对话能持续几十秒，等于没有并发限制。
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

// ---------------------------------------------------------------- 模型清单

let catalogCache = { at: 0, data: null };

function visionOf(model) {
  return Array.isArray(model.tags) && model.tags.includes('vision');
}

function reasoningOf(model) {
  return Array.isArray(model.tags) && model.tags.includes('reasoning');
}

function multiplierLabels(model) {
  const labels = [];
  for (const d of Array.isArray(model.billing_discounts) ? model.billing_discounts : []) {
    if (d && d.active && d.name) labels.push(String(d.name));
  }
  if (!labels.length && model.billing_status_note) labels.push(String(model.billing_status_note));
  return labels;
}

/** 上游 `model_catalog` → OpenAI /v1/models 条目。 */
function catalogToModels(payload) {
  const categories = payload && payload.data && Array.isArray(payload.data.categories)
    ? payload.data.categories
    : [];
  const out = [];
  for (const category of categories) {
    const type = String(category && category.type || 'chat').toLowerCase();
    // 生图/嵌入等非对话模型不能走 chat/completions，先只收 chat
    if (type !== 'chat') continue;
    for (const model of Array.isArray(category.models) ? category.models : []) {
      const id = String(model && (model.model_name || model.name) || '').trim();
      if (!id) continue;
      const params = model.params || {};
      out.push({
        id,
        object: 'model',
        owned_by: 'raccoon',
        name: model.description || id,
        description: model.display_description || '',
        context_window: Number(params.context_window) || null,
        max_output_tokens: Number(params.max_tokens) || null,
        capabilities: {
          vision: visionOf(model),
          reasoning: reasoningOf(model),
          tools: true,
        },
        tags: Array.isArray(model.tags) ? model.tags : [],
        visible: model.visible !== false,
        default: category.default_model === id,
        billing_multiplier: Number(model.billing_multiplier ?? 1),
        billing_effective_multiplier: Number(
          model.billing_effective_multiplier ?? model.billing_multiplier ?? 1,
        ),
        billing_status: model.billing_status || 'normal',
        billing_status_note: model.billing_status_note || '',
      });
    }
  }
  // 默认模型排最前，客户端默认选中它
  out.sort((a, b) => Number(b.default) - Number(a.default));
  return out;
}

async function fetchCatalog({ refresh = false } = {}) {
  if (!refresh && catalogCache.data && Date.now() - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache.data;
  }
  const auth = readAuth();
  if (!auth) {
    throw Object.assign(new Error('小浣熊未登录：找不到 agent/config/auth.json 里的 access_token'), { status: 401 });
  }
  const upstream = await upstreamFetch(`${UPSTREAM_ORIGIN}/api/web/llm/v2/model_catalog`, {
    method: 'GET',
    headers: upstreamHeaders(auth),
    timeout: SHORT_TIMEOUT_MS,
  });
  const text = await upstream.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  if (!upstream.ok) {
    const message = (payload && (payload.message || payload.details)) || text.slice(0, 300) || `HTTP ${upstream.status}`;
    throw Object.assign(new Error(message), { status: upstream.status });
  }
  if (!payload || Number(payload.code) !== 0 || !payload.data) {
    throw Object.assign(new Error('小浣熊 model_catalog 返回了无法识别的格式'), { status: 502 });
  }
  const models = catalogToModels(payload);
  catalogCache = { at: Date.now(), data: models };
  return models;
}

// ---------------------------------------------------------------- 积分

async function fetchBalance(auth) {
  const upstream = await upstreamFetch(`${UPSTREAM_ORIGIN}/api/web/points/v1/balance`, {
    method: 'GET',
    headers: upstreamHeaders(auth),
    timeout: SHORT_TIMEOUT_MS,
  });
  const text = await upstream.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  if (!upstream.ok) {
    const message = (payload && (payload.message || payload.details)) || text.slice(0, 300) || `HTTP ${upstream.status}`;
    throw Object.assign(new Error(message), { status: upstream.status });
  }
  if (!payload || Number(payload.code) !== 0 || !payload.data) {
    throw Object.assign(new Error('小浣熊积分接口返回了无法识别的格式'), { status: 502 });
  }
  return payload.data;
}

async function handleQuota(res) {
  const auth = readAuth();
  if (!auth) {
    return sendJson(res, 401, {
      ok: false,
      error: {
        message: '小浣熊未登录：请打开商汤小浣熊桌面端登录后重试',
        type: 'raccoon_auth',
        code: 401,
      },
    });
  }

  let wallet = null;
  try {
    wallet = await fetchBalance(auth);
  } catch (err) {
    const authFailed = err.status === 401 || /登录|token|authorization/i.test(err.message || '');
    return sendJson(res, authFailed ? 401 : 502, {
      ok: false,
      error: {
        message: authFailed ? '小浣熊登录态失效，请在桌面端重新登录' : `积分接口不可达：${err.message}`,
        type: authFailed ? 'raccoon_auth' : 'raccoon_upstream',
        code: err.status || 502,
      },
    });
  }

  let models = [];
  try {
    models = await fetchCatalog();
  } catch {}

  const multipliers = {};
  for (const model of models) {
    multipliers[model.id] = {
      base: model.billing_multiplier,
      effective: model.billing_effective_multiplier,
      labels: multiplierLabels(model),
      status: model.billing_status,
    };
  }

  const available = Number(wallet.available_points) || 0;
  const daily = Number(wallet.daily_points) || 0;
  const monthly = Number(wallet.monthly_points) || 0;
  const reward = Number(wallet.reward_points) || 0;
  const topup = Number(wallet.topup_points) || 0;

  sendJson(res, 200, {
    ok: true,
    service: 'raccoon',
    fetchedAt: new Date().toISOString(),
    user: {
      identity: identityLabel(auth.identity),
      subject: maskSubject(auth.subject) || null,
      expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
    },
    // 上游只给「当前可用额」，没有总额；total=0 表示分母未知，
    // 插件会因此只显示余量而不是编一个 100% 的进度条。
    balance: { remaining: available, total: 0, used: 0, unit: 'credits' },
    wallet: { available, daily, monthly, reward, topup },
    multipliers,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      multiplier: model.billing_effective_multiplier,
      tags: model.tags,
    })),
  });
}

// ---------------------------------------------------------------- 路由

async function handleModels(req, res, url) {
  const auth = readAuth();
  if (!auth) {
    return sendError(res, 401, '小浣熊未登录：请打开商汤小浣熊桌面端登录后重试', 'raccoon_auth');
  }
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  let models;
  try {
    models = await fetchCatalog({ refresh });
  } catch (err) {
    return sendError(res, err.status || 502, err.message || '获取模型列表失败', 'raccoon_upstream');
  }

  let list = models;
  if (String(url.searchParams.get('type') || '').toLowerCase() === 'chat') {
    list = list.filter((m) => (m.tags || []).length === 0 || !m.tags.includes('image'));
  }
  sendJson(res, 200, { object: 'list', data: list });
}

/** 上游路径：/v1/chat/completions → /chat/completions；生图有独立路径。 */
function upstreamPathFor(pathname) {
  if (pathname === '/v1/images/generations' || pathname === '/v1/images/gen') {
    return '/images/gen';
  }
  return pathname.replace(/^\/v1/, '') || '/';
}

async function handleProxy(req, res, url, body) {
  const auth = readAuth();
  if (!auth) {
    return sendError(res, 401, '小浣熊未登录：请打开商汤小浣熊桌面端登录后重试', 'raccoon_auth');
  }

  let stream = false;
  if (body && body.length) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      stream = parsed && parsed.stream === true;
    } catch {}
  }

  // 本地限流：对话与生图都要占一个执行位。生图更慢（20~30 秒），占着位的时候
  // 另一个请求会被排队——这正是想要的效果，别让上游看到两路并行的重请求。
  let release = null;
  if (LIMITER) {
    try {
      release = await LIMITER.acquire({ maxWaitMs: 5000 });
    } catch (err) {
      if (err instanceof LimiterBusy) {
        const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        return sendError(res, 429, `本地限流：${seconds} 秒后重试（${LIMITER.limits.rpm}/分钟，并发 ${LIMITER.limits.concurrency}）`, 'raccoon_rate_limited');
      }
      throw err;
    }
  }

  const target = `${UPSTREAM_ORIGIN}/api/web/llm/v2${upstreamPathFor(url.pathname)}${url.search}`;
  const ac = new AbortController();
  req.on('aborted', () => ac.abort());
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const started = Date.now();
  try {
    const upstream = await upstreamFetch(target, {
      method: req.method,
      headers: upstreamHeaders(auth, { stream }),
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
      sendError(res, 502, `小浣熊上游不可达：${err.message}`, 'raccoon_network');
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
        service: 'raccoon-proxy',
        upstream: UPSTREAM_BASE,
        loggedIn: Boolean(auth),
        user: auth
          ? {
              identity: identityLabel(auth.identity),
              subject: maskSubject(auth.subject) || null,
              expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
              expired: auth.expiresAt ? auth.expiresAt <= Date.now() : false,
            }
          : null,
        modelsCachedAt: catalogCache.data ? new Date(catalogCache.at).toISOString() : null,
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
  console.error('[raccoon-proxy] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const auth = readAuth();
  log(`小浣熊反代已启动：http://${HOST}:${PORT}`);
  log(`上游：${UPSTREAM_BASE}`);
  log(
    `登录态：${auth
      ? `已登录（${identityLabel(auth.identity)}${auth.expiresAt ? `，token 到期 ${new Date(auth.expiresAt).toISOString().slice(0, 10)}` : ''}）`
      : '未登录（等桌面端登录后自动生效）'}`,
  );
});

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
