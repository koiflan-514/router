#!/usr/bin/env node
/**
 * quota.js — 查各家 AI 编程工具的积分余额与签到状态。
 *
 * 为什么要有这一层：这些工具都没有公开的「查余额」API，但它们各自的本机形态
 * 已经把答案摆在本地了，只是摆放方式完全不同：
 *
 *   Qoder  凭证在 pi 的 auth.json，官方 openapi 有 /api/v2/quota/usage 与
 *          /sash/api/v1/me/daily-check-in/*，纯 Bearer，不需要签名
 *   Trae   trae2api 这类本机反代有自己的控制台（/admin/api/credits），
 *          余额与签到状态都在里面；直接调官方要设备指纹，风险大
 *   WorkBuddy 本机反代有自己的 status（账号、凭证有效期）
 *
 * 所以这里不重复实现任何一家的上游调用，而是「读已经在跑的本机服务」：
 * 它们在，就能拿到数字；不在，就明确说「拿不到」，而不是猜一个值。
 *
 * 唯一的例外是 Qoder：它的 openapi 是官方公开的只读接口，凭证又已经在 pi 手里，
 * 所以直接查（这也是 pi 扩展自己算 usage 用的同一个接口）。
 *
 * 零依赖，只用 node: 内建模块，所以既能在 pi 扩展里 require，也能被 qoder2pi 用。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PI_DIR = path.join(HOME, '.pi', 'agent');
const AUTH_JSON = path.join(PI_DIR, 'auth.json');

/**
 * 单次请求超时。
 *
 * 6 秒对多数本机反代够用，但 Qoder 的 openapi 在账号并发打满时会排很长的队
 * （实测 10 秒以上），6 秒就断会把「忙」误报成「查不到」。给到 12 秒，
 * 同时用 Promise.all 并发查各家，整体等待不会叠加。
 */
const TIMEOUT_MS = 12000;

// ---------------------------------------------------------------- 工具

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 带超时的 GET。返回 { ok, status, json, text, error }，从不抛。 */
async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 不是 JSON 就留着 text
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: '', error: describeFetchError(err) };
  }
}

/** 带超时的 POST。body 为对象时按 JSON 发。 */
async function postJson(url, body, headers = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 同上
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: '', error: describeFetchError(err) };
  }
}

/**
 * 把 Node fetch 的错误变成可读信息。
 *
 * `fetch failed` 本身毫无信息量——真正的原因在 `err.cause`（`ECONNRESET`、
 * `ETIMEDOUT`、`AbortSignal.timeout` 之类）。不展开它，用户只会看到
 * 「额度接口返回 fetch failed」，既不知道是网络、是超时、还是服务挂了。
 */
function describeFetchError(err) {
  if (!err) return '未知错误';
  if (err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message || '')) {
    return '超时（上游排队或负载高，稍后重试）';
  }
  const cause = err.cause;
  if (cause) {
    const code = cause.code || cause.errno || '';
    const msg = cause.message || '';
    if (/ECONNREFUSED/i.test(code)) return '连接被拒绝（服务没起？）';
    if (/ECONNRESET/i.test(code)) return '连接被重置（上游不稳定）';
    if (/ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(code)) return `网络不可达（${code}）`;
    if (/CERT|SSL|TLS/i.test(code)) return `TLS 失败（${code}）`;
    return `${code || err.message}${msg ? `：${msg.slice(0, 80)}` : ''}`;
  }
  return err.message || String(err);
}

// ---------------------------------------------------------------- Qoder

const QODER_REGIONS = {
  'qoder-cn': {
    provider: 'qoder-cn',
    title: 'Qoder 国内版',
    openapi: 'https://openapi.qoder.com.cn',
    manageUrl: 'https://qoder.com.cn/account/usage',
  },
  qoder: {
    provider: 'qoder',
    title: 'Qoder 国际版',
    openapi: 'https://openapi.qoder.sh',
    manageUrl: 'https://qoder.com/account/usage',
  },
};

/** pi 的 auth.json 里那个 provider 的 access token；没有就返回 null。 */
function qoderToken(provider) {
  const auth = readJson(AUTH_JSON);
  const entry = auth && auth[provider];
  return entry && entry.access ? entry.access : null;
}

/**
 * Qoder 的额度接口。
 *
 * 返回里有两块：userQuota（套餐额度）与 addOnQuota（加购/赠送包）。实际能用的
 * 通常是后者，所以两者都收进来，由调用方展示。
 */
async function qoderQuota(provider) {
  const region = QODER_REGIONS[provider];
  const token = qoderToken(provider);
  if (!token) {
    return { provider, title: region.title, available: false, reason: '未登录（qoder2pi login 或 pi 里 /login）' };
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'qodbuddy2pi' };

  const [quota, plan, checkin] = await Promise.all([
    getJson(`${region.openapi}/api/v2/quota/usage`, headers),
    getJson(`${region.openapi}/api/v2/user/plan`, headers),
    getJson(`${region.openapi}/sash/api/v1/me/daily-check-in/status`, headers),
  ]);

  if (!quota.ok || !quota.json) {
    const expired = quota.status === 401 || quota.status === 403;
    return {
      provider,
      title: region.title,
      available: false,
      reason: expired ? '凭证已过期（重新登录即可）' : `额度接口返回 ${quota.status || quota.error || '错误'}`,
    };
  }

  const q = quota.json;
  const buckets = [];
  const add = (id, label, src) => {
    if (!src || typeof src !== 'object') return;
    const total = Number(src.total || 0);
    const used = Number(src.used || 0);
    const remaining = typeof src.remaining === 'number' ? Number(src.remaining) : total - used;
    // 总量为 0 且剩余为 0 的桶没有信息量（比如套餐额度为 0 的免费账号）
    if (total === 0 && remaining === 0) return;
    buckets.push({ id, label, total, used, remaining, unit: src.unit || q.usageType || 'credits', detailUrl: src.detailUrl || region.manageUrl });
  };
  add('plan', '套餐额度', q.userQuota);
  add('addon', '加购额度', q.addOnQuota);
  for (const outer of Array.isArray(q.outerProviders) ? q.outerProviders : []) {
    add(`outer:${outer.name || outer.id || 'x'}`, outer.name || '外部额度', outer.quota || outer);
  }

  // 国际站的签到接口目前是 404（活动只挂在页面里，没有可领取的 API），
  // 所以「接口不存在」与「活动没开」要分开说，否则用户会以为是自己没资格。
  const checkinState =
    checkin.status === 404
      ? { supported: false, status: 'UNSUPPORTED', claimable: false, rewardCredits: 0, note: '该区域没有签到接口（活动只在网页里）' }
      : checkin.ok && checkin.json
        ? normalizeQoderCheckin(checkin.json)
        : null;

  return {
    provider,
    title: region.title,
    available: true,
    kind: 'qoder',
    account: q.userId ? `${String(q.userId).slice(0, 8)}…` : undefined,
    plan: plan.ok && plan.json ? plan.json.plan_tier_name || plan.json.user_type : undefined,
    buckets,
    checkin: checkinState,
    // 账号本身可用但额度为 0（免费号常见）：说明清楚，别显示成「查不到」
    quotaExhausted: !!q.isQuotaExceeded,
    raw: q,
  };
}

/**
 * Qoder 签到状态。
 *
 * status 的取值见过 DISABLED（活动没开）与 ENABLED/AVAILABLE（可领）。这里不硬编码
 * 字符串比较，而是按「有没有可领的奖励」判断，活动改名字也不会误判。
 */
function normalizeQoderCheckin(raw) {
  const status = String(raw.status || '').toUpperCase();
  const reward = Number(raw.rewardCredits || 0);
  // DISABLED = 活动没开；其它状态才看奖励与冷却。nextClaimAt 为 0/缺失表示「现在就能领」
  const supported = status !== 'DISABLED';
  const claimable = supported && reward > 0 && !(Number(raw.nextClaimAt || 0) > 0);
  return {
    supported: status !== 'DISABLED',
    status: status || 'UNKNOWN',
    claimable,
    rewardCredits: reward,
    currentStreakDays: Number(raw.currentStreakDays || 0),
    totalClaimDays: Number(raw.totalClaimDays || 0),
    totalRewardCredits: Number(raw.totalRewardCredits || 0),
    nextClaimAt: Number(raw.nextClaimAt || 0) || null,
    campaignKey: raw.campaignKey || '',
  };
}

/**
 * Qoder 签到领取。
 *
 * 幂等：已领过时服务端返回 409 AlreadyExists，这里归一成「今日已签到」，
 * 不当作错误。没开活动时返回 supported:false，什么都不发。
 */
async function qoderClaim(provider) {
  const region = QODER_REGIONS[provider];
  const token = qoderToken(provider);
  if (!token) return { ok: false, reason: '未登录' };

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'qodbuddy2pi' };
  const status = await getJson(`${region.openapi}/sash/api/v1/me/daily-check-in/status`, headers);
  const state = status.ok && status.json ? normalizeQoderCheckin(status.json) : null;
  if (state && !state.supported) {
    return { ok: false, alreadyDone: false, reason: '该区域当前没有每日签到活动', rewardCredits: 0 };
  }
  if (state && !state.claimable) {
    return { ok: true, alreadyDone: true, reason: '今日已签到', rewardCredits: 0 };
  }

  const res = await postJson(`${region.openapi}/sash/api/v1/me/daily-check-in/claim`, {}, headers);
  if (res.ok) {
    const reward = res.json && Number(res.json.rewardCredits) ? Number(res.json.rewardCredits) : state ? state.rewardCredits : 0;
    return { ok: true, alreadyDone: false, rewardCredits: reward, reason: `已领取 ${reward} 积分` };
  }
  // 409 = 今天已经领过（并发或重复点击），不算失败
  if (res.status === 409) {
    return { ok: true, alreadyDone: true, reason: '今日已签到', rewardCredits: 0 };
  }
  const message = (res.json && (res.json.errorMessage || res.json.errorCode)) || `HTTP ${res.status}`;
  return { ok: false, reason: `领取失败：${message}` };
}

// ---------------------------------------------------------------- Trae

/**
 * Trae 的余额与签到只在 trae2api 这类本机反代里有现成的：它自己已经处理了
 * 设备指纹与 token 解密。直接打官方要伪造设备身份，风险不值得，所以这里只读
 * 本机反代。
 *
 * 端口不写死：先看 pi 的 models.json 里 trae 相关 provider 的 baseUrl，
 * 再用常见端口兜底。这样用户换端口也能找到。
 */
function traeBaseUrls() {
  const urls = [];
  const models = readJson(path.join(PI_DIR, 'models.json'));
  const providers = (models && models.providers) || {};
  for (const [id, cfg] of Object.entries(providers)) {
    if (!/trae/i.test(id) && !/trae/i.test(String(cfg.name || ''))) continue;
    const base = String(cfg.baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    if (base) urls.push(base);
  }
  for (const port of [7863, 7864, 7865, 7866]) urls.push(`http://127.0.0.1:${port}`);
  return [...new Set(urls)];
}

async function traeCredits() {
  const candidates = traeBaseUrls();
  const tried = [];
  for (const base of candidates) {
    const res = await getJson(`${base}/admin/api/credits`);
    tried.push(`${base} → ${res.status || res.error || '错误'}`);
    if (!res.ok || !res.json || !Array.isArray(res.json.accounts)) continue;

    const accounts = res.json.accounts.map((a) => ({
      id: String(a.uid || ''),
      name: a.nickname || String(a.uid || '账号'),
      remaining: Number(a.remain ?? 0),
      total: Number(a.limit ?? 0),
      used: Number(a.used ?? 0),
      unit: 'credits',
      packs: Number(a.packs ?? 0),
      cooling: !!a.cooling,
      disabled: !!a.disabled,
      error: a.error || undefined,
      checkin: {
        supported: !!a.checkin_enable,
        claimed: !!a.checked_in,
        rewardCredits: Number(a.checkin_credits ?? 0),
      },
    }));

    return {
      provider: 'trae',
      title: 'Trae（免费积分）',
      available: true,
      kind: 'trae',
      baseUrl: base,
      fetchedAt: res.json.fetched_at,
      accounts,
    };
  }
  return {
    provider: 'trae',
    title: 'Trae（免费积分）',
    available: false,
    reason: `没找到本机 Trae 反代（试过 ${candidates.length} 个地址）`,
    detail: tried.slice(0, 4),
  };
}

/**
 * Trae 签到。
 *
 * 本机反代没有单账号签到接口（它自己的控制台也只有余额与状态），所以这里不假装
 * 能签：明确告诉用户去反代控制台或客户端点。这是刻意的——伪造设备身份打官方
 * 签到接口有封号风险，不是这个插件该做的事。
 */
async function traeClaim() {
  return {
    ok: false,
    unsupported: true,
    reason: 'Trae 的签到请在 trae2api 控制台（/admin）或 Trae 客户端里点',
  };
}

// ---------------------------------------------------------------- WorkBuddy

/**
 * WorkBuddy 的「余额」不是积分，而是凭证有效期 + 服务是否在跑。这里把它也做成
 * 一行，因为用户问「还剩多少」时，WorkBuddy 的答案就是「凭证还有几天」。
 *
 * 凭证字段的嵌套位置来自反代自己写的 session 文件：auth.expiresAt（毫秒）与
 * account.nickname。不同版本可能把 expiresAt 写成秒或字符串，所以三种都认。
 */
const WORKBUDDY_REGIONS = {
  workbuddy: { provider: 'workbuddy', title: 'WorkBuddy 国内版', port: 8787, session: '.codebuddy-session.json' },
  'workbuddy-global': { provider: 'workbuddy-global', title: 'WorkBuddy 国际版', port: 8788, session: '.codebuddy-global-session.json' },
};

/** 把各种写法的到期时间统一成毫秒时间戳；认不出来返回 null。 */
function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // 秒级时间戳（10 位）与毫秒级（13 位）都出现过
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

async function workbuddyStatus(provider) {
  const region = WORKBUDDY_REGIONS[provider];
  const base = `http://127.0.0.1:${region.port}`;
  const health = await getJson(`${base}/v1/models`);
  const session = readJson(path.join(HOME, region.session));

  // 到期时间优先看 auth.expiresAt，其次 refreshExpiresAt，最后顶层同名字段
  const auth = (session && session.auth) || {};
  const expiresMs = toMillis(auth.expiresAt) || toMillis(auth.expires_at) || toMillis(session && session.expiresAt);
  const refreshMs =
    toMillis(auth.refreshExpiresAt) || toMillis(auth.refresh_expires_at) || toMillis(session && session.refreshExpiresAt);
  const nickname = (session && session.account && session.account.nickname) || '';

  const rows = [];
  if (expiresMs) {
    rows.push({
      id: 'credential',
      label: '凭证有效期',
      remaining: Math.max(0, Math.floor((expiresMs - Date.now()) / 86400000)),
      total: null,
      used: null,
      unit: '天',
      expiresAt: expiresMs,
    });
  }
  if (refreshMs) {
    rows.push({
      id: 'refresh',
      label: '续期有效期',
      remaining: Math.max(0, Math.floor((refreshMs - Date.now()) / 86400000)),
      total: null,
      used: null,
      unit: '天',
      expiresAt: refreshMs,
    });
  }

  const available = health.ok || rows.length > 0;
  return {
    provider,
    title: region.title,
    available,
    kind: 'workbuddy',
    serviceRunning: health.ok,
    account: nickname || undefined,
    buckets: rows,
    checkin: { supported: false, claimed: false, rewardCredits: 0 },
    reason: available ? undefined : `服务未运行（127.0.0.1:${region.port}）且没有凭证文件`,
  };
}

// ---------------------------------------------------------------- CodeArts

/**
 * CodeArts Agent（华为云）的积分。
 *
 * 它由第三方 Go 网关 codearts2api 提供服务（:10087）。那个网关自带控制台接口：
 *   GET  /admin/api/credits   积分余额（总量/已用/剩余/到期日/即将过期）
 *   POST /admin/api/checkin   活动福利状态
 *   POST /admin/api/claim     领取活动福利（每日签到）
 *
 * 与 Qoder 不同：这里的积分是**真实扣费**的（免费权益通道 2026-10 已下线），
 * 所以「剩余」就是能用的量，不是「还能领多少」。
 */
const CODEARTS = {
  provider: 'codearts',
  title: 'CodeArts Agent',
  port: 10087,
};

async function codeartsCredits() {
  const base = `http://127.0.0.1:${CODEARTS.port}`;
  const health = await getJson(`${base}/health`);
  if (!health.ok) {
    return {
      provider: CODEARTS.provider,
      title: CODEARTS.title,
      available: false,
      kind: 'codearts',
      reason: `本机网关未运行（127.0.0.1:${CODEARTS.port}）`,
    };
  }

  const credits = await getJson(`${base}/admin/api/credits`);
  if (!credits.ok || !credits.json || !Array.isArray(credits.json.accounts)) {
    return {
      provider: CODEARTS.provider,
      title: CODEARTS.title,
      available: false,
      kind: 'codearts',
      reason: `积分接口返回 ${credits.status || credits.error || '错误'}`,
    };
  }

  const accounts = credits.json.accounts.map((a) => {
    const c = a.credit || {};
    return {
      id: String(a.id || ''),
      name: a.name || a.id || '账号',
      remaining: Number(c.remaining ?? 0),
      total: Number(c.total ?? 0),
      used: Number(c.used ?? 0),
      unit: 'credits',
      package: c.package_name || undefined,
      // 即将过期的那部分：提醒用户先用掉，不然浪费
      expiring: Number(c.expiring ?? 0) || 0,
      resetDate: c.reset_date || undefined,
      status: c.status || undefined,
      error: a.err || undefined,
    };
  });

  return {
    provider: CODEARTS.provider,
    title: CODEARTS.title,
    available: accounts.length > 0,
    kind: 'codearts',
    baseUrl: base,
    accounts,
    // CodeArts 的「签到」是运营活动福利，由网关的 claim 接口负责
    checkin: { supported: true, claimed: false, rewardCredits: 0 },
    reason: accounts.length === 0 ? '网关在线但没有账号' : undefined,
  };
}

/**
 * CodeArts 的活动福利领取。
 *
 * 网关的 /admin/api/claim 是幂等的：服务端对不能领的活动会明确拒绝
 * （「尚未到达权益刷新时间」/「该活动类型需要先通过触发接口激活」），
 * 所以这里如实转述它的结果，不自己判断能不能领。
 */
async function codeartsClaim() {
  const base = `http://127.0.0.1:${CODEARTS.port}`;
  const res = await postJson(`${base}/admin/api/claim`, {});
  if (!res.ok || !res.json) {
    return { ok: false, reason: `领取失败：${res.status || res.error || '网关不可用'}` };
  }
  const results = res.json.results || [];
  if (results.length === 0) return { ok: false, reason: '网关没有返回结果' };

  const messages = results.map((r) => (r.message || (r.ok ? '已领取' : r.err || '未知')));
  const got = results.filter((r) => r.ok && !/暂无可领/.test(r.message || '')).length;
  return {
    ok: got > 0,
    alreadyDone: got === 0 && /暂无可领/.test(messages.join(' ')),
    reason: messages.join('；'),
    rewardCredits: 0, // 网关不返回具体奖励数值
  };
}

// ---------------------------------------------------------------- ZCode

/**
 * ZCode（Z.ai / bigmodel 的编程套餐）在本机反代 zcode-bridge 里：
 *   GET /v1/quota  → 套餐 + 每条 entitlement 的 total/used/remaining
 * 上游按 **token** 计量，量级是几亿，所以统一换算成百万 token（M tok），
 * 既好读也不会把 TUI 的窄列撑歪。
 */
const ZCODE = {
  provider: 'zcode',
  title: 'ZCode（Z.ai）',
  port: 20131,
};

const ZCODE_M = 1_000_000;

async function zcodeCredits() {
  const base = `http://127.0.0.1:${ZCODE.port}`;
  const quota = await getJson(`${base}/v1/quota`);
  if (quota.status === 0) {
    return {
      provider: ZCODE.provider,
      title: ZCODE.title,
      available: false,
      kind: 'zcode',
      reason: `本机 ZCode 反代未运行（127.0.0.1:${ZCODE.port}）`,
    };
  }

  const rows = quota.json && Array.isArray(quota.json.rows) ? quota.json.rows : [];
  if (!quota.ok || rows.length === 0) {
    const err =
      quota.json && Array.isArray(quota.json.errors) && quota.json.errors.length > 0
        ? quota.json.errors[0]
        : null;
    return {
      provider: ZCODE.provider,
      title: ZCODE.title,
      available: false,
      kind: 'zcode',
      reason:
        quota.status === 401
          ? '凭据已失效（重新登录 ZCode 即可）'
          : err
            ? `没有可用套餐（${err}）`
            : `额度接口返回 ${quota.status || quota.error || '错误'}`,
    };
  }

  const buckets = rows.map((r) => {
    const round2 = (v) => Math.round(v * 100) / 100;
    const total = Number(r.total_units || 0) / ZCODE_M;
    const used = Number(r.used_units || 0) / ZCODE_M;
    const remaining = Number(r.available_units ?? r.remaining_units ?? 0) / ZCODE_M;
    const plan = r.plan_name || r.plan || '套餐';
    const model = r.model || (Array.isArray(r.models) && r.models[0]) || '模型';
    return {
      id: String(r.entitlement_id || `${plan}:${model}`),
      // TUI 的分账列窄，标签用模型名；套餐名放在 row.plan 里
      label: model,
      total: round2(total),
      used: round2(used),
      remaining: round2(Math.max(0, remaining)),
      unit: 'M tok',
      expiresAt: r.ends_at || r.expires_at || null,
    };
  });

  const plans = [...new Set(rows.map((r) => r.plan_name || r.plan).filter(Boolean))];

  return {
    provider: ZCODE.provider,
    title: ZCODE.title,
    available: true,
    kind: 'zcode',
    baseUrl: base,
    fetchedAt: quota.json && quota.json.server_time ? new Date(quota.json.server_time * 1000).toISOString() : undefined,
    account: quota.json && quota.json.account ? String(quota.json.account) : undefined,
    plan: plans.length > 0 ? plans.join('、') : undefined,
    buckets,
    // 限时套餐由 router 的 claim 定时任务负责；这里不占「签到」状态位，
    // 免得 TUI 的状态列显示成一句说明
  };
}

// ---------------------------------------------------------------- Loomy（讯飞）

/**
 * Loomy 的余额与倍率都在本仓库自写的反代 loomy-proxy 里（:8791）：
 *   GET /v1/quota → wallet { balance, daily, available } + multipliers
 * 上游只给“当前可用额”，没有总额；这里 total 留空，显示端只报余量。
 */
const LOOMY = {
  provider: 'loomy',
  title: 'Loomy（讯飞 iModel）',
  port: 8791,
};

async function loomyCredits() {
  const base = `http://127.0.0.1:${LOOMY.port}`;
  const quota = await getJson(`${base}/v1/quota`);
  if (quota.status === 0) {
    return {
      provider: LOOMY.provider,
      title: LOOMY.title,
      available: false,
      kind: 'loomy',
      reason: `本机 Loomy 反代未运行（127.0.0.1:${LOOMY.port}）`,
    };
  }

  const q = quota.json || {};
  if (!quota.ok || q.ok !== true) {
    const message = (q.error && q.error.message) || `额度接口返回 ${quota.status || quota.error || '错误'}`;
    return {
      provider: LOOMY.provider,
      title: LOOMY.title,
      available: false,
      kind: 'loomy',
      reason: quota.status === 401 ? 'Loomy 登录态失效（打开 Loomy 桌面端重新登录）' : message,
    };
  }

  const wallet = q.wallet || {};
  const available = Number(wallet.available ?? (q.balance && q.balance.remaining) ?? 0);
  const balance = Number(wallet.balance || 0);
  const daily = Number(wallet.daily || 0);
  const multipliers = q.multipliers && typeof q.multipliers === 'object' ? q.multipliers : null;
  const multiplierCount = multipliers ? Object.keys(multipliers).length : 0;

  return {
    provider: LOOMY.provider,
    title: LOOMY.title,
    available: true,
    kind: 'loomy',
    baseUrl: base,
    fetchedAt: q.fetchedAt,
    account: q.user && (q.user.phone || q.user.id) ? String(q.user.phone || q.user.id) : undefined,
    // 没有总额：total 留空，TUI 显示 “—”，不显示假的 20000/20000
    buckets: [{ label: '可用积分', remaining: available, unit: 'credits' }],
    detail: [
      `常驻 ${fmtNum(balance)} · 每日 ${fmtNum(daily)}`,
      multiplierCount > 0 ? `${multiplierCount} 个模型有倍率` : '上游没有逐模型倍率',
    ],
    multipliers,
  };
}

// ---------------------------------------------------------------- 小浣熊（商汤）

/**
 * 商汤小浣熊的余额与倍率都在本仓库自写的反代 raccoon-proxy 里（:8793）：
 *   GET /v1/quota → wallet { available, daily, monthly, reward, topup } + multipliers
 * 上游只给“当前可用额”，没有总额；这里 total 留空，显示端只报余量。
 */
const RACCOON = {
  provider: 'raccoon',
  title: '商汤小浣熊',
  port: 8793,
};

async function raccoonCredits() {
  const base = `http://127.0.0.1:${RACCOON.port}`;
  const quota = await getJson(`${base}/v1/quota`);
  if (quota.status === 0) {
    return {
      provider: RACCOON.provider,
      title: RACCOON.title,
      available: false,
      kind: 'raccoon',
      reason: `本机小浣熊反代未运行（127.0.0.1:${RACCOON.port}）`,
    };
  }

  const q = quota.json || {};
  if (!quota.ok || q.ok !== true) {
    const message = (q.error && q.error.message) || `额度接口返回 ${quota.status || quota.error || '错误'}`;
    return {
      provider: RACCOON.provider,
      title: RACCOON.title,
      available: false,
      kind: 'raccoon',
      reason: quota.status === 401 ? '小浣熊登录态失效（打开桌面端重新登录）' : message,
    };
  }

  const wallet = q.wallet || {};
  const available = Number(wallet.available ?? (q.balance && q.balance.remaining) ?? 0);
  const daily = Number(wallet.daily || 0);
  const reward = Number(wallet.reward || 0);
  const multipliers = q.multipliers && typeof q.multipliers === 'object' ? q.multipliers : null;
  const multiplierCount = multipliers ? Object.keys(multipliers).length : 0;
  const user = q.user || {};

  return {
    provider: RACCOON.provider,
    title: RACCOON.title,
    available: true,
    kind: 'raccoon',
    baseUrl: base,
    fetchedAt: q.fetchedAt,
    account: user.identity ? String(user.identity) : undefined,
    // 没有总额：total 留空，TUI 显示 “—”，不显示假的 20000/20000
    buckets: [{ label: '可用积分', remaining: available, unit: 'credits' }],
    detail: [
      `每日 ${fmtNum(daily)} · 赠送 ${fmtNum(reward)}`,
      multiplierCount > 0 ? `${multiplierCount} 个模型有倍率` : '上游没有逐模型倍率',
    ],
    multipliers,
  };
}

// ---------------------------------------------------------------- 千问办公（QwenWork）

/**
 * 千问办公的倍率在反代 qwenwork-proxy 里（:8794）：
 *   GET /v1/quota → multipliers（逐模式 price_factor）+ user（昵称/套餐）
 *
 * 与别家的差别：**没有可读的余额**。桌面端的 wallets 接口要宿主登录 JWT，
 * 而那个 JWT 加密绑定本机身份，反代刻意不解。所以这里只报倍率与账号，
 * 余额留空——显示端据此只显示「—」，不编数字。
 */
const QWENWORK = {
  provider: 'qwenwork',
  title: '千问办公（QwenWork）',
  port: 8794,
};

async function qwenworkCredits() {
  const base = `http://127.0.0.1:${QWENWORK.port}`;
  const quota = await getJson(`${base}/v1/quota`);
  if (quota.status === 0) {
    return {
      provider: QWENWORK.provider,
      title: QWENWORK.title,
      available: false,
      kind: 'qwenwork',
      reason: `本机千问办公反代未运行（127.0.0.1:${QWENWORK.port}）`,
    };
  }

  const q = quota.json || {};
  const multipliers = q.multipliers && typeof q.multipliers === 'object' ? q.multipliers : null;
  const multiplierCount = multipliers ? Object.keys(multipliers).length : 0;
  const user = q.user || {};

  // 反代在「凭据不可用」时仍返回倍率，同时把原因放 error
  if (!quota.ok || q.ok !== true) {
    return {
      provider: QWENWORK.provider,
      title: QWENWORK.title,
      available: false,
      kind: 'qwenwork',
      reason: (q.error && q.error.message) || `额度接口返回 ${quota.status || quota.error || '错误'}`,
      multipliers,
      detail: [user.plan ? `套餐 ${user.plan}` : ''].filter(Boolean),
    };
  }

  const detail = [];
  if (user.plan) detail.push(`套餐 ${user.plan}`);
  if (multiplierCount > 0) detail.push(`${multiplierCount} 个模型有倍率`);
  if (q.quotaNote) detail.push(String(q.quotaNote));

  return {
    provider: QWENWORK.provider,
    title: QWENWORK.title,
    available: true,
    kind: 'qwenwork',
    baseUrl: base,
    fetchedAt: q.fetchedAt,
    account: user.name || user.username || undefined,
    // 没有余额读数：buckets 留空，显示端只显示「—」
    buckets: [],
    detail,
    multipliers,
  };
}

// ---------------------------------------------------------------- 百度搭子（DuMate）

/**
 * 百度搭子的余额与模型都在本仓库自写的反代 dumate-proxy 里（:8795）：
 *   GET /v1/quota → wallet { total, used, available } + user + subscriptions
 *
 * 上游（桌面端 main-server 代理的 console 接口）给的是「总额 - 已用」，
 * 与 Loomy/小浣熊不同，这里能画真实进度条。积分在桌面端签到/购买。
 */
const DUMATE = {
  provider: 'dumate',
  title: '百度搭子（DuMate）',
  port: 8795,
};

async function dumateCredits() {
  const base = `http://127.0.0.1:${DUMATE.port}`;
  const quota = await getJson(`${base}/v1/quota`);
  if (quota.status === 0) {
    return {
      provider: DUMATE.provider,
      title: DUMATE.title,
      available: false,
      kind: 'dumate',
      reason: `本机百度搭子反代未运行（127.0.0.1:${DUMATE.port}）`,
    };
  }

  const q = quota.json || {};
  if (!quota.ok || q.ok !== true) {
    const message = (q.error && q.error.message) || `额度接口返回 ${quota.status || quota.error || '错误'}`;
    return {
      provider: DUMATE.provider,
      title: DUMATE.title,
      available: false,
      kind: 'dumate',
      reason: message,
    };
  }

  const wallet = q.wallet || {};
  const balance = q.balance || {};
  const available = Number(wallet.available ?? balance.remaining ?? 0);
  const total = Number(wallet.total ?? balance.total ?? 0);
  const used = Number(wallet.used ?? balance.used ?? 0);
  const user = q.user || {};
  const subs = Array.isArray(q.subscriptions) ? q.subscriptions : [];
  const expiring = subs
    .filter((s) => s.status === 'active' && s.expireAt)
    .map((s) => new Date(s.expireAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];

  const detail = [];
  if (user.subscribed) detail.push('已订阅');
  if (user.throttled) detail.push('上游限流中');
  if (subs.length > 1) detail.push(`${subs.length} 个积分包`);

  return {
    provider: DUMATE.provider,
    title: DUMATE.title,
    available: true,
    kind: 'dumate',
    baseUrl: base,
    fetchedAt: q.fetchedAt,
    account: user.name || user.accountId || undefined,
    buckets: [
      {
        label: '可用积分',
        total,
        used,
        remaining: available,
        unit: 'credits',
        ...(expiring ? { expiresAt: expiring } : {}),
      },
    ],
    detail,
    multipliers: q.multipliers && typeof q.multipliers === 'object' ? q.multipliers : null,
  };
}

// ---------------------------------------------------------------- WPS 灵犀

/**
 * WPS 灵犀的「智点」余额在本仓库自写的反代 lingxi-proxy 里（:8796）：
 *   GET /v1/quota → balance { remaining, total, used } + wallet + buckets[]
 *
 * 这家既有积分也有对话：反代自己 spawn lingxi.exe app-server（JSON-RPC stdio），
 * 提供 /v1/models 与 /v1/chat/completions。注意灵犀是完整 agent，不吐 OpenAI
 * tool_calls，适合对话、不适合当编码 agent 驱动（见 lingxi2api/README.md）。
 *
 * 与 Loomy/小浣熊不同，这家有真实发放总量，能画进度条。智点在桌面端做任务领取。
 */
const LINGXI = {
  provider: 'lingxi',
  title: 'WPS 灵犀（智点）',
  port: 8796,
};

async function lingxiCredits() {
  const base = `http://127.0.0.1:${LINGXI.port}`;
  const quota = await getJson(`${base}/v1/quota`);
  if (quota.status === 0) {
    return {
      provider: LINGXI.provider,
      title: LINGXI.title,
      available: false,
      kind: 'lingxi',
      reason: `本机 WPS 灵犀反代未运行（127.0.0.1:${LINGXI.port}）`,
    };
  }

  const q = quota.json || {};
  if (!quota.ok || q.ok !== true) {
    const message = (q.error && q.error.message) || `额度接口返回 ${quota.status || quota.error || '错误'}`;
    return {
      provider: LINGXI.provider,
      title: LINGXI.title,
      available: false,
      kind: 'lingxi',
      reason: message,
    };
  }

  const wallet = q.wallet || {};
  const balance = q.balance || {};
  const available = Number(wallet.available ?? balance.remaining ?? 0);
  const total = Number(wallet.granted ?? balance.total ?? 0);
  const used = Number(wallet.consumed ?? balance.used ?? 0);
  const user = q.user || {};
  const packs = Array.isArray(q.buckets) ? q.buckets : [];
  const expiring = packs
    .map((b) => (b.expireAt ? new Date(b.expireAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];

  const detail = ['对话可用（agent 形态，不支持工具调用驱动）'];
  if (Number(wallet.bonus) > 0) detail.push(`赠送 ${wallet.bonus}`);
  if (Number(wallet.purchased) > 0) detail.push(`购买 ${wallet.purchased}`);
  if (packs.length > 1) detail.push(`${packs.length} 个智点包`);
  if (q.subscription && q.subscription.name) detail.push(`订阅 ${q.subscription.name}`);

  return {
    provider: LINGXI.provider,
    title: LINGXI.title,
    available: true,
    kind: 'lingxi',
    baseUrl: base,
    fetchedAt: q.fetchedAt,
    account: user.name || user.id || undefined,
    buckets: [
      {
        label: '可用智点',
        total,
        used,
        remaining: available,
        unit: 'credits',
        ...(expiring ? { expiresAt: expiring } : {}),
      },
    ],
    detail,
    multipliers: null,
  };
}

// ---------------------------------------------------------------- 汇总

/**
 * 收集所有能查到的来源。
 *
 * 每个来源独立失败：一个没登录不该让整张表空白。返回的数组里 available:false
 * 的条目会显示成「拿不到 + 原因」，这比静默省略有用得多。
 */
async function collectAll({ only = null } = {}) {
  const wanted = (id) => (only ? only.includes(id) : true);
  const tasks = [];
  for (const provider of Object.keys(QODER_REGIONS)) {
    if (wanted(provider)) tasks.push(qoderQuota(provider));
  }
  if (wanted('codearts')) tasks.push(codeartsCredits());
  if (wanted('trae')) tasks.push(traeCredits());
  for (const provider of Object.keys(WORKBUDDY_REGIONS)) {
    if (wanted(provider)) tasks.push(workbuddyStatus(provider));
  }
  if (wanted('zcode')) tasks.push(zcodeCredits());
  if (wanted('loomy')) tasks.push(loomyCredits());
  if (wanted('raccoon')) tasks.push(raccoonCredits());
  if (wanted('qwenwork')) tasks.push(qwenworkCredits());
  if (wanted('dumate')) tasks.push(dumateCredits());
  if (wanted('lingxi')) tasks.push(lingxiCredits());
  const results = await Promise.all(tasks);
  return results;
}

/** 汇总一行字：今天能领多少、总共还剩多少。给状态栏与通知用。 */
function summarize(rows) {
  const claimable = [];
  const available = [];
  let remaining = 0;
  let unit = '';
  for (const row of rows) {
    if (!row.available) continue;
    available.push(row.provider);
    if (row.kind === 'trae' || row.kind === 'codearts') {
      // 两者都是「多账号 + accounts[] 结构」，余额直接来自各自的网关
      for (const acc of row.accounts || []) {
        if (acc.error) continue;
        remaining += Number(acc.remaining || 0);
        unit = acc.unit || unit;
        if (acc.checkin && acc.checkin.supported && !acc.checkin.claimed) {
          claimable.push({ provider: row.provider, account: acc.name, reward: acc.checkin.rewardCredits });
        }
      }
    } else if (row.buckets) {
      for (const b of row.buckets) {
        // 天数和 credits 不能相加：WorkBuddy 只贡献「凭证还剩几天」，不进积分合计
        if (b.unit !== 'credits') continue;
        remaining += Number(b.remaining || 0);
        unit = b.unit || unit;
      }
      if (row.checkin && row.checkin.supported && row.checkin.claimable) {
        claimable.push({ provider: row.provider, account: row.account, reward: row.checkin.rewardCredits });
      }
    }
  }
  return { available, remaining, unit, claimable };
}

/**
 * 积分数字的显示：整数不显示小数点，小数最多保留两位。
 * 上游给的是 6599.25 这种浮点，直接打会带一长串尾数。
 */
function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * 把结果排成可直接打印的纯文本。供 qoder2pi 子命令、pi 工具结果与 /credits 共用，
 * 保证三处看到的数字一致。
 */
function renderText(rows, { width = 60 } = {}) {
  const lines = [];
  const bar = '─'.repeat(Math.min(width, 48));
  lines.push('积分余额与签到');
  lines.push(bar);
  for (const row of rows) {
    const head = `[${row.title}]`;
    if (!row.available) {
      lines.push(`${head} ${row.reason || '不可用'}`);
      for (const d of row.detail || []) lines.push(`  ${d}`);
      continue;
    }
    if (row.kind === 'trae') {
      lines.push(`${head} ${row.accounts.length} 个账号${row.fetchedAt ? `（${row.fetchedAt}）` : ''}`);
      for (const acc of row.accounts) {
        if (acc.error) {
          lines.push(`  ${acc.name}：查询失败（${acc.error}）`);
          continue;
        }
        const pct = acc.total > 0 ? Math.round((acc.remaining / acc.total) * 100) : null;
        const bits = [`剩 ${acc.remaining}`, acc.total ? `共 ${acc.total}` : null, pct !== null ? `${pct}%` : null, acc.packs ? `${acc.packs} 个权益包` : null];
        const flags = [];
        if (acc.checkin.supported) flags.push(acc.checkin.claimed ? '今日已签到' : `今日可领 ${acc.checkin.rewardCredits}`);
        if (acc.cooling) flags.push('冷却中');
        if (acc.disabled) flags.push('已禁用');
        lines.push(`  ${acc.name}：${bits.filter(Boolean).join(' / ')}${flags.length ? `  ·  ${flags.join(' · ')}` : ''}`);
      }
      continue;
    }
    if (row.kind === 'codearts') {
      lines.push(`${head} ${row.accounts.length} 个账号`);
      for (const acc of row.accounts || []) {
        if (acc.error) {
          lines.push(`  ${acc.name}：查询失败（${acc.error}）`);
          continue;
        }
        const bits = [
          `剩 ${fmtNum(acc.remaining)}`,
          acc.total ? `共 ${fmtNum(acc.total)}` : null,
          acc.package ? `${acc.package}` : null,
        ].filter(Boolean);
        // 即将过期的那部分单独提示：不用掉就浪费了
        if (acc.expiring > 0) bits.push(`即将过期 ${fmtNum(acc.expiring)}`);
        if (acc.resetDate) bits.push(`${acc.resetDate} 重置`);
        lines.push(`  ${acc.name}：${bits.join(' / ')}`);
      }
      continue;
    }
    if (row.kind === 'loomy') {
      const parts = (row.buckets || []).map(
        (b) => `${b.label} ${fmtNum(b.remaining)} ${b.unit}`,
      );
      const meta = [row.account ? `账号 ${row.account}` : null, ...(row.detail || [])].filter(Boolean).join(' · ');
      lines.push(`${head} ${parts.join('　·　') || '没有可用额度信息'}${meta ? `　（${meta}）` : ''}`);
      lines.push('  每日积分在 Loomy 桌面端领取，插件不自动签');
      continue;
    }
    if (row.kind === 'raccoon') {
      const parts = (row.buckets || []).map(
        (b) => `${b.label} ${fmtNum(b.remaining)} ${b.unit}`,
      );
      const meta = [row.account ? `账号 ${row.account}` : null, ...(row.detail || [])].filter(Boolean).join(' · ');
      lines.push(`${head} ${parts.join('　·　') || '没有可用额度信息'}${meta ? `　（${meta}）` : ''}`);
      lines.push('  积分按桌面端定价计费；每日额度在桌面端领取');
      continue;
    }
    if (row.kind === 'qwenwork') {
      const meta = [row.account ? `账号 ${row.account}` : null, ...(row.detail || [])].filter(Boolean).join(' · ');
      // 没有余额读数（要宿主 JWT），只报账号、套餐与倍率数量
      lines.push(`${head} 没有可用额度信息${meta ? `　（${meta}）` : ''}`);
      if (row.multipliers) {
        lines.push(`  倍率：${Object.keys(row.multipliers).length} 个模型有上游倍率`);
      }
      continue;
    }
    if (row.kind === 'dumate') {
      const b = (row.buckets || [])[0] || {};
      const pct = b.total > 0 ? Math.round((b.remaining / b.total) * 100) : null;
      const bits = [
        `剩 ${fmtNum(b.remaining)}`,
        b.total ? `共 ${fmtNum(b.total)}` : null,
        pct !== null ? `${pct}%` : null,
      ].filter(Boolean);
      const meta = [row.account ? `账号 ${row.account}` : null, ...(row.detail || [])].filter(Boolean).join(' · ');
      lines.push(`${head} ${bits.join(' / ')}${meta ? `　（${meta}）` : ''}`);
      // 积分包会过期：最近的那个单独提一句，不用掉就浪费了
      if (b.expiresAt) {
        const when = new Date(b.expiresAt);
        if (!Number.isNaN(when.getTime())) {
          lines.push(`  最近到期 ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
        }
      }
      lines.push('  积分在百度搭子桌面端签到/购买，插件不自动签');
      continue;
    }
    if (row.kind === 'lingxi') {
      const b = (row.buckets || [])[0] || {};
      const pct = b.total > 0 ? Math.round((b.remaining / b.total) * 100) : null;
      const bits = [
        `剩 ${fmtNum(b.remaining)}`,
        b.total ? `共 ${fmtNum(b.total)}` : null,
        pct !== null ? `${pct}%` : null,
      ].filter(Boolean);
      const meta = [row.account ? `账号 ${row.account}` : null, ...(row.detail || [])].filter(Boolean).join(' · ');
      lines.push(`${head} ${bits.join(' / ')}${meta ? `　（${meta}）` : ''}`);
      if (b.expiresAt) {
        const when = new Date(b.expiresAt);
        if (!Number.isNaN(when.getTime())) {
          lines.push(`  最近到期 ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
        }
      }
      lines.push('  智点在 WPS 灵犀桌面端做任务领取，插件不自动签');
      continue;
    }
    if (row.kind === 'zcode') {
      const parts = (row.buckets || []).map(
        (b) => `${b.label} ${fmtNum(b.remaining)}/${fmtNum(b.total)} ${b.unit}`,
      );
      const plan = row.plan ? `　（${row.plan}）` : '';
      lines.push(`${head} ${parts.join('　·　') || '没有可用额度信息'}${plan}`);
      const ends = (row.buckets || [])
        .map((b) => b.expiresAt)
        .filter((v) => v != null)
        .map((v) => (typeof v === 'number' ? new Date(v * 1000) : new Date(v)))
        .filter((d) => !Number.isNaN(d.getTime()));
      if (ends.length > 0) {
        const when = ends[0].toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`  到期 ${when} UTC`);
      }
      lines.push('  限时套餐：node router.mjs claim zcode（已注册定时任务）');
      continue;
    }
    if (row.kind === 'workbuddy') {
      const cred = (row.buckets || []).find((x) => x.id === 'credential');
      const svc = row.serviceRunning ? '服务在线' : '服务未运行';
      const bits = [];
      if (row.account) bits.push(String(row.account));
      bits.push(cred ? `凭证剩 ${cred.remaining} 天` : '没有凭证文件');
      if (refresh) bits.push(`续期剩 ${refresh.remaining} 天`);
      bits.push(svc);
      lines.push(`${head} ${bits.join('　·　')}`);
      continue;
    }
    // Qoder
    const parts = [];
    for (const b of row.buckets || []) {
      parts.push(`${b.label} ${b.remaining}/${b.total} ${b.unit}`);
    }
    const meta = [row.plan ? `套餐 ${row.plan}` : null, row.account ? `账号 ${row.account}` : null].filter(Boolean).join(' · ');
    const quotaText = parts.length
      ? parts.join('　·　')
      : row.quotaExhausted
        ? '额度已用尽（0 credits，模型仍可调用）'
        : '没有可用额度信息';
    lines.push(`${head} ${quotaText}${meta ? `　（${meta}）` : ''}`);
    if (row.checkin) {
      if (row.checkin.note) lines.push(`  签到：${row.checkin.note}`);
      else if (!row.checkin.supported) lines.push('  签到：该区域当前没有每日签到活动');
      else if (row.checkin.claimable) lines.push(`  签到：今日可领 ${row.checkin.rewardCredits} 积分（连续 ${row.checkin.currentStreakDays} 天）`);
      else lines.push(`  签到：今日已签到（连续 ${row.checkin.currentStreakDays} 天，累计 ${row.checkin.totalRewardCredits} 积分）`);
    }
  }
  lines.push(bar);
  const s = summarize(rows);
  const tail = [`可查 ${s.available.length} 个来源`];
  if (s.remaining > 0) tail.push(`合计剩 ${s.remaining} ${s.unit || 'credits'}`);
  if (s.claimable.length > 0) tail.push(`今日可领 ${s.claimable.reduce((a, c) => a + Number(c.reward || 0), 0)}`);
  lines.push(tail.join('　·　'));
  return lines.join('\n');
}

module.exports = {
  // 数据源
  QODER_REGIONS,
  WORKBUDDY_REGIONS,
  qoderQuota,
  qoderClaim,
  normalizeQoderCheckin,
  traeCredits,
  traeClaim,
  traeBaseUrls,
  workbuddyStatus,
  codeartsCredits,
  codeartsClaim,
  CODEARTS,
  zcodeCredits,
  loomyCredits,
  raccoonCredits,
  qwenworkCredits,
  dumateCredits,
  lingxiCredits,
  ZCODE,
  LOOMY,
  RACCOON,
  QWENWORK,
  collectAll,
  // 展示
  summarize,
  renderText,
  fmtNum,
  // 工具（测试用）
  readJson,
  toMillis,
};
