#!/usr/bin/env node
/**
 * lingxi-proxy.js — 把 WPS 灵犀桌面端的「智点」额度暴露成本机只读接口。
 *
 * **这家目前只接积分，不接对话。** 原因写在 README 里，简述：
 * 灵犀是 Electron + Go app-server（JSON-RPC over stdio）的 agent 形态，
 * 上游没有可直达的 OpenAI 兼容面——`/api/public/v1/agent-runtime/chat/completions`
 * 挂在工具端点那一组下面，对任何 body（连空 `{}`）都回同一个 400 InvalidArgument；
 * 也没有模型清单接口。所以这里刻意**不提供** /v1/models 与 /v1/chat/completions，
 * 免得在 opencode/pi 里列出一个选中就报错的假 provider。
 *
 * 凭据链条（这是这家唯一特殊的地方）：
 *   %APPDATA%/WPS 灵犀/Local State → os_crypt.encrypted_key（DPAPI 保护）
 *     └─ DPAPI Unprotect（当前用户）→ 32 字节主密钥
 *          └─ AES-256-GCM 解 Partitions/lingxi-passport-v2-<hash>/Network/Cookies
 *               的 cookies.encrypted_value（"v10" + nonce + 密文 + tag，
 *               明文前还有 32 字节 SHA256(host) 前缀）
 *                 └─ wps_sid（.wps.cn 域，50 字符）
 *
 * 注意 SID **不在** app-server-data/auth.json 里：那份是 `auth_storage=runtime`，
 * 落盘的 wps_sid.value 是空串。真正的登录态在 Electron 的 cookie jar。
 * auth-binding-key.v1 只用于快照的 HMAC 绑定，不是快照密钥，别拿它去解 auth-snapshot.json。
 *
 * 端点（全部只读）：
 *   GET /health        进程、凭据状态、账号（不输出 SID）
 *   GET /v1/quota      智点余额 + 分项 + 每包到期（opencode provider-credits 插件用）
 *   GET /v1/credits    同上（别名）
 *   GET /v1/usage      智点收支明细（赠送/消费，带任务名与 session_id）
 *
 * 零依赖，只用 node: 内建模块（含 node:sqlite 读 cookie 库）；不写任何凭证文件。
 *
 * 用法：
 *   node lingxi-proxy.js                  # 127.0.0.1:8796
 *   node lingxi-proxy.js --port 8796
 *   LINGXI_WPS_SID=... node lingxi-proxy.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const STARTED_AT = Date.now();

const DEFAULT_PORT = 8796;
const UPSTREAM = String(process.env.LINGXI_UPSTREAM || 'https://lingxi.wps.cn').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.LINGXI_TIMEOUT_MS || 15_000);
// cookie 库会被桌面端持续写入；每次请求都解密太贵（DPAPI 要起 PowerShell），缓存一会儿。
const SID_CACHE_MS = Number(process.env.LINGXI_SID_CACHE_MS || 120_000);
const QUOTA_CACHE_MS = Number(process.env.LINGXI_QUOTA_CACHE_MS || 30_000);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PORT = Number(argValue('--port') || process.env.LINGXI_PORT || process.env.PORT || DEFAULT_PORT);
const HOST = String(process.env.LINGXI_HOST || '127.0.0.1');

/** 桌面端的 Electron userData 目录。 */
function appDataRoot() {
  const explicit = String(process.env.LINGXI_APP_DATA || '').trim();
  if (explicit) return explicit;
  if (WIN) {
    const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(roaming, 'WPS 灵犀');
  }
  return path.join(HOME, '.config', 'WPS 灵犀');
}

const APP_DATA = appDataRoot();

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

function maskSid(sid) {
  const s = String(sid || '');
  if (!s) return '';
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***';
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res, status, message, type = 'lingxi_error') {
  sendJson(res, status, { ok: false, error: { message, type, code: status } });
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 上游给的是 797.0 这种浮点，展示时收成两位小数。 */
function round2(value) {
  return Math.round(numberOrZero(value) * 100) / 100;
}

// ---------------------------------------------------------------- 凭据

const sidCache = { sid: '', at: 0, source: '', error: '' };

/** Windows：DPAPI 解 Local State 里的 Chromium 主密钥。 */
function windowsMasterKey() {
  const state = readJson(path.join(APP_DATA, 'Local State'));
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (typeof b64 !== 'string' || !b64) return null;
  let blob = Buffer.from(b64, 'base64');
  if (blob.subarray(0, 5).toString('latin1') === 'DPAPI') blob = blob.subarray(5);
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${blob.toString('base64')}')`,
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($p)',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const key = Buffer.from(String(r.stdout || '').trim(), 'base64');
  return key.length === 32 ? key : null;
}

/**
 * Chromium cookie 的 encrypted_value：`v10`/`v11` + 12 字节 nonce + 密文 + 16 字节 tag。
 * 新版 Chromium 在明文前加了 32 字节 SHA256(host) 前缀，要去掉才是真值。
 */
function decryptCookie(buf, key) {
  if (!buf || !buf.length || !key) return '';
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return buf.toString('utf8');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const out = Buffer.concat([d.update(buf.subarray(15, buf.length - 16)), d.final()]);
    if (out.length > 32) return out.subarray(32).toString('utf8');
    return out.toString('utf8');
  } catch {
    return '';
  }
}

/** 递归找出所有 cookie 库；passport 分区优先（SID 就在那儿）。 */
function cookieDatabases() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'Cookies') out.push(p);
    }
  };
  walk(APP_DATA, 0);
  // passport 分区是登录态所在；其余分区（business / in-app-browser）作兜底
  out.sort((a, b) => {
    const pa = /passport/i.test(a) ? 0 : 1;
    const pb = /passport/i.test(b) ? 0 : 1;
    return pa - pb;
  });
  return out;
}

/**
 * 从 cookie 库里取 wps_sid。
 *
 * 桌面端在跑时库是锁着的，所以先复制到临时目录再只读打开——直接开会撞 SQLITE_BUSY。
 * expires_utc 是 WebKit 时间戳（微秒，1601 起算），超出 JS 安全整数，必须 CAST 成 TEXT。
 */
function sidFromCookies() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { error: '当前 Node 没有 node:sqlite（需要 Node 22.5+）' };
  }
  const key = windowsMasterKey();
  if (!key) return { error: `读不到 DPAPI 主密钥（${path.join(APP_DATA, 'Local State')}）` };

  const dbs = cookieDatabases();
  if (!dbs.length) return { error: `找不到 cookie 库：${APP_DATA}` };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-'));
  try {
    for (const db of dbs) {
      const copy = path.join(tmp, `c${dbs.indexOf(db)}.db`);
      try {
        fs.copyFileSync(db, copy);
      } catch {
        continue;
      }
      let conn;
      try {
        conn = new DatabaseSync(copy, { readOnly: true });
        const rows = conn
          .prepare("SELECT host_key, encrypted_value, CAST(expires_utc AS TEXT) AS exp FROM cookies WHERE name = 'wps_sid'")
          .all();
        for (const row of rows) {
          const sid = decryptCookie(Buffer.from(row.encrypted_value), key);
          if (sid) {
            return { sid, source: path.relative(APP_DATA, db), host: row.host_key };
          }
        }
      } catch {
        // 这个分区没有 SID 或库损坏，换下一个
      } finally {
        try {
          if (conn) conn.close();
        } catch {}
      }
    }
    return { error: '未登录 WPS 灵犀（cookie 库里没有 wps_sid）' };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

/** 取 SID：环境变量优先，其次 cookie 库（带缓存）。 */
function readSid({ force = false } = {}) {
  const explicit = String(process.env.LINGXI_WPS_SID || '').trim();
  if (explicit) return { sid: explicit, source: 'env' };
  if (!force && sidCache.sid && Date.now() - sidCache.at < SID_CACHE_MS) {
    return { sid: sidCache.sid, source: sidCache.source };
  }
  const got = sidFromCookies();
  if (got.sid) {
    sidCache.sid = got.sid;
    sidCache.at = Date.now();
    sidCache.source = got.source;
    sidCache.error = '';
    return { sid: got.sid, source: got.source };
  }
  sidCache.error = got.error || '取不到 wps_sid';
  // 读不到时退回上一次的好值：桌面端正在写库导致的瞬时失败不该让接口立刻瘫掉。
  // 真是重新登录换了 SID，上游会回 401，调用方会 force 重读再试一次。
  if (sidCache.sid) return { sid: sidCache.sid, source: sidCache.source, stale: true };
  return { error: sidCache.error };
}

// ---------------------------------------------------------------- 上游

async function upstreamGet(apiPath, { force = false } = {}) {
  let auth = readSid({ force });
  if (!auth.sid) {
    return Object.assign(new Error(auth.error || '取不到 WPS 灵犀登录态'), { code: 'LINGXI_NO_AUTH' });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetch(`${UPSTREAM}${apiPath}`, {
        headers: {
          Cookie: `wps_sid=${auth.sid}`,
          Accept: 'application/json',
          // 上游按客户端通道下发配置，UA 带上桌面端标识
          'User-Agent': 'lingxi-desktop/1.3.41',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return Object.assign(new Error(`WPS 灵犀上游不可达：${err.message}`), { code: 'LINGXI_NETWORK' });
    }
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}

    if (res.status === 401 || res.status === 403) {
      // SID 轮换了：强制重读 cookie 库再试一次
      auth = readSid({ force: true });
      if (auth.sid && attempt === 0) continue;
      return Object.assign(new Error('WPS 灵犀登录态失效（打开桌面端重新登录）'), { code: 'LINGXI_AUTH' });
    }
    if (!res.ok || !payload || payload.result !== 'ok') {
      const message = (payload && (payload.msg || payload.hint)) || text.slice(0, 200) || `HTTP ${res.status}`;
      return Object.assign(new Error(`WPS 灵犀接口返回：${message}`), { code: 'LINGXI_UPSTREAM', status: res.status });
    }
    return { data: payload.data || {}, fetchedAt: new Date().toISOString() };
  }
  return Object.assign(new Error('WPS 灵犀登录态失效（打开桌面端重新登录）'), { code: 'LINGXI_AUTH' });
}

function statusFor(err) {
  if (err.code === 'LINGXI_NO_AUTH') return 501;
  if (err.code === 'LINGXI_AUTH') return 401;
  if (err.code === 'LINGXI_NETWORK') return 502;
  return 502;
}

// ---------------------------------------------------------------- 账号

const profileCache = { data: null, at: 0 };

async function readProfile({ force = false } = {}) {
  if (!force && profileCache.data && Date.now() - profileCache.at < 300_000) return profileCache.data;
  const got = await upstreamGet('/api/public/v1/account/profile', { force });
  if (got instanceof Error) return null;
  profileCache.data = got.data;
  profileCache.at = Date.now();
  return got.data;
}

// ---------------------------------------------------------------- 路由

const quotaCache = { data: null, at: 0 };

/** 积分包的人话标签：分账列窄，别把 sku_key 原样塞进去。 */
function bucketLabel(item, kind) {
  const sku = String(item.sku_key || '');
  if (kind === 'purchased') return '购买智点';
  if (kind === 'contract') return '套餐智点';
  if (sku.includes('grant')) return '赠送智点';
  return '赠送智点';
}

async function handleQuota(res, url) {
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  if (!refresh && quotaCache.data && Date.now() - quotaCache.at < QUOTA_CACHE_MS) {
    return sendJson(res, 200, quotaCache.data);
  }

  const got = await upstreamGet('/api/public/v1/credits/balance', { force: refresh });
  if (got instanceof Error) return sendError(res, statusFor(got), got.message, 'lingxi_quota');

  const d = got.data;
  const profile = await readProfile({ force: refresh });

  const remaining = round2(d.total_balance);
  const bonus = round2(d.total_bonus);
  const purchased = round2(d.total_purchased);
  const contract = round2(d.total_contract);
  // 上游给的是「当前可用总额」与各来源分项，没有统一分母。
  // 用 bonus_summary.total_value + purchased_summary.total_value 当发放总量：
  // 它是真实读数（发放了多少），不是编出来的 100%。
  const grantedBonus = round2(d.bonus_summary && d.bonus_summary.total_value);
  const grantedPurchased = round2(d.purchased_summary && d.purchased_summary.total_value);
  const total = round2(grantedBonus + grantedPurchased);
  const consumed = round2(
    numberOrZero(d.bonus_summary && d.bonus_summary.total_consumed)
    + numberOrZero(d.purchased_summary && d.purchased_summary.total_consumed),
  );

  const buckets = [];
  for (const [kind, list] of [
    ['bonus', d.bonus_credits],
    ['purchased', d.purchased_credits],
  ]) {
    for (const item of Array.isArray(list) ? list : []) {
      buckets.push({
        kind,
        label: bucketLabel(item, kind),
        skuKey: item.sku_key || null,
        total: round2(item.value),
        used: round2(item.consumed),
        remaining: round2(item.balance),
        unit: 'credits',
        effectAt: item.effect_time || null,
        expireAt: item.expire_time || null,
      });
    }
  }
  // 快到期的排前面：不用掉就浪费了
  buckets.sort((a, b) => String(a.expireAt || '9999').localeCompare(String(b.expireAt || '9999')));

  const sub = d.active_subscription || null;
  const body = {
    ok: true,
    service: 'lingxi',
    fetchedAt: got.fetchedAt,
    user: {
      id: profile && profile.id ? String(profile.id) : null,
      name: profile && profile.name ? String(profile.name) : null,
      corpId: profile && profile.corp_id ? String(profile.corp_id) : null,
      isCorp: Boolean(profile && String(profile.corp_id || '0') !== '0'),
    },
    // 有真实发放总量：客户端可以画进度条
    balance: { remaining, total, used: consumed, unit: 'credits' },
    wallet: {
      available: remaining,
      bonus,
      purchased,
      contract,
      granted: total,
      consumed,
      enabled: d.enabled === true,
    },
    subscription: sub
      ? {
          skuKey: sub.sku_key || null,
          name: sub.merchandise_name || null,
          expireAt: sub.expire_time || null,
          planExpireAt: sub.plan_expire_time || null,
        }
      : null,
    buckets,
    // 灵犀没有公开逐模型倍率：返回空对象，显示端报「—」而不是编一个值。
    multipliers: {},
    // 这家只接积分，不接对话（见文件头注释）
    chatAvailable: false,
    chatNote: 'WPS 灵犀上游没有可直达的 OpenAI 兼容对话入口，本反代只提供积分查询',
  };

  quotaCache.data = body;
  quotaCache.at = Date.now();
  sendJson(res, 200, body);
}

async function handleUsage(res, url) {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const got = await upstreamGet('/api/public/v1/credits/transaction_summary');
  if (got instanceof Error) return sendError(res, statusFor(got), got.message, 'lingxi_usage');

  const list = Array.isArray(got.data.list) ? got.data.list : [];
  sendJson(res, 200, {
    ok: true,
    service: 'lingxi',
    fetchedAt: got.fetchedAt,
    hasMore: got.data.has_more === true,
    transactions: list.slice(0, limit).map((t) => ({
      type: t.type || null,
      amount: round2(t.amount),
      taskName: t.task_name || null,
      remark: t.remark || null,
      source: t.source || null,
      sessionId: t.session_id || null,
      skuKey: t.sku_key || null,
      at: t.time || null,
      expireAt: t.expire_time || null,
    })),
  });
}

async function handleHealth(res) {
  const auth = readSid();
  const profile = auth.sid ? await readProfile() : null;
  sendJson(res, 200, {
    ok: true,
    service: 'lingxi-proxy',
    mode: 'credits-only',
    upstream: UPSTREAM,
    loggedIn: Boolean(auth.sid),
    credentialSource: auth.source || null,
    credentialError: auth.error || undefined,
    sid: auth.sid ? maskSid(auth.sid) : null,
    user: profile ? { id: String(profile.id || ''), name: profile.name || null } : null,
    appData: APP_DATA,
    chatAvailable: false,
    endpoints: ['/health', '/v1/quota', '/v1/credits', '/v1/usage'],
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendError(res, 400, '非法 URL');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, '本反代只读，只支持 GET');
  }

  try {
    if (url.pathname === '/health' || url.pathname === '/') return await handleHealth(res);
    if (url.pathname === '/v1/quota' || url.pathname === '/v1/credits' || url.pathname === '/admin/api/credits') {
      return await handleQuota(res, url);
    }
    if (url.pathname === '/v1/usage') return await handleUsage(res, url);

    // 刻意不提供模型与对话端点：宁可明确 404，也不要在客户端里列一个选中就报错的 provider。
    if (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/chat')) {
      return sendError(
        res,
        501,
        'WPS 灵犀只接入积分查询：上游没有可直达的 OpenAI 兼容对话入口（见 integrations/lingxi2api/README.md）',
        'lingxi_chat_unavailable',
      );
    }
    sendError(res, 404, `未知端点：${url.pathname}`);
  } catch (err) {
    log('请求处理失败:', err && err.stack ? err.stack : err);
    if (!res.headersSent) sendError(res, 500, err.message || '内部错误');
    else if (!res.writableEnded) res.destroy(err);
  }
});

server.on('error', (err) => {
  console.error('[lingxi-proxy] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const auth = readSid();
  log(`WPS 灵犀积分反代已启动：http://${HOST}:${PORT}（只读，不含对话）`);
  log(`桌面端目录：${APP_DATA}`);
  log(
    auth.sid
      ? `登录态：已取到 wps_sid（${maskSid(auth.sid)}，来源 ${auth.source}）`
      : `登录态：${auth.error || '未登录'}（打开 WPS 灵犀桌面端登录后自动生效）`,
  );
});

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));