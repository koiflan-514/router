/**
 * 把 CLI / 网关的原生 JSON 规范化为前端契约模型。
 *
 * 字段名以 frontend/docs/00-design-baseline.md §6 为准；drift 与 overlay 的推导见
 * 05-backend-contract.md §5.5 与任务说明。结构化状态**只从 JSON 推导**，不从人类文本反推。
 */

import { maskIdentity, maskUid, sanitize } from './redact.mjs';

export const SCHEMA_VERSION = 1;
export const DRIFT_KINDS = ['stopped', 'notSynced', 'stillRunning'];
const AUTH_STATES = new Set(['valid', 'expiring', 'expired', 'missing', 'unknown']);
const HEALTH_LEVELS = new Set(['ok', 'warn', 'error', 'unknown']);
const DIALECTS = new Set(['openai', 'anthropic', 'both']);

export const PROVIDER_IDS = [
  'qoder-cn',
  'qoder',
  'trae-local',
  'codearts',
  'zcode',
  'workbuddy',
  'workbuddy-global',
  'loomy',
  'raccoon',
];
export const ACTION_PROVIDER_WHITELIST = new Set([...PROVIDER_IDS, 'gateway']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const intOr = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v) => v === true;
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * drift 推导（05 §5.5）：
 *   on && !up → stopped
 *   on && !oc && !ocUserOwned → notSynced
 *   !on && up → stillRunning
 *   ocUserOwned → 永不报 notSynced
 * 叠加层（gateway）不参与 on/off 语义，不报 drift。
 */
export function deriveDrift({ on, up, oc, ocUserOwned, overlay = false }) {
  if (overlay) return [];
  const out = [];
  if (on && !up) out.push('stopped');
  if (on && !oc && !ocUserOwned) out.push('notSynced');
  if (!on && up) out.push('stillRunning');
  return out.filter((k) => DRIFT_KINDS.includes(k));
}

export function toAuth(raw) {
  const auth = raw && typeof raw === 'object' ? raw : {};
  const rawState = String(auth.state ?? '').trim();
  const state = AUTH_STATES.has(rawState) ? rawState : 'unknown';
  return {
    ok: bool(auth.ok),
    state,
    expiresAt: typeof auth.expiresAt === 'string' ? auth.expiresAt : null,
    label: sanitize(maskIdentity(str(auth.label))),
    ...(rawState && rawState !== 'unknown' && state === 'unknown' ? { rawState } : {}),
  };
}

/** `router.mjs list --json` 的 providers[] → ProviderStatus */
export function toProviderStatus(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const id = str(row.id);
  const overlay = id === 'gateway';
  const up = bool(row.up);
  // 网关是叠加层：没有独立开关，on 直接反映进程状态。
  const on = overlay ? up : bool(row.on);
  const oc = bool(row.oc);
  const ocUserOwned = bool(row.ocUserOwned);
  const pids = Array.isArray(row.pids) ? row.pids.filter((p) => typeof p === 'number') : [];
  const pid = num(row.pid) ?? pids[0] ?? null;
  return {
    id,
    title: sanitize(str(row.title, id)),
    on,
    up,
    models: num(row.models),
    port: intOr(row.port, 0),
    pid,
    pids,
    control: str(row.control),
    oc,
    ocUserOwned,
    auth: toAuth(row.auth),
    drift: deriveDrift({ on, up, oc, ocUserOwned, overlay }),
    overlay,
  };
}

function toAccount(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const health = a.health && typeof a.health === 'object' ? a.health : {};
  const noteSource = Array.isArray(health.notes) ? health.notes : [];
  return {
    key: str(a.key),
    name: sanitize(maskIdentity(str(a.name))),
    uid: maskUid(a.uid),
    enabled: bool(a.enabled),
    active: bool(a.active),
    detail: sanitize(maskIdentity(str(a.detail))),
    health: {
      level: HEALTH_LEVELS.has(health.level) ? health.level : 'unknown',
      notes: noteSource.map((n) => sanitize(maskIdentity(str(n)))),
    },
  };
}

/** `account --json` 的单家 provider → AccountGroup */
export function toAccountGroup(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const accounts = Array.isArray(g.accounts) ? g.accounts.map(toAccount) : [];
  return {
    id: str(g.id),
    title: sanitize(str(g.title, str(g.id))),
    kind: str(g.kind),
    switchable: bool(g.switchable),
    accounts,
  };
}

export function toQuotaBucket(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(b.id),
    label: sanitize(str(b.label, str(b.id))),
    total: nonNeg(b.total),
    used: nonNeg(b.used),
    remaining: nonNeg(b.remaining),
    unit: str(b.unit, 'credits'),
    resetDate: typeof b.resetDate === 'string' ? b.resetDate : null,
    expiring: nonNeg(b.expiring),
  };
}

/** 网关 balance / CLI 额度行 → QuotaRow */
export function toQuotaRow(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const checkin = r.checkin && typeof r.checkin === 'object' ? r.checkin : null;
  const row = {
    provider: str(r.provider ?? r.id),
    kind: str(r.kind),
    title: sanitize(str(r.title, str(r.provider ?? r.id))),
    available: r.available === undefined ? true : bool(r.available),
  };
  if (r.reason !== undefined) row.reason = sanitize(str(r.reason));
  if (r.detail !== undefined) row.detail = sanitize(maskIdentity(str(r.detail)));
  if (r.account !== undefined) row.account = r.account === null ? null : sanitize(maskIdentity(str(r.account)));
  if (Array.isArray(r.buckets)) row.buckets = r.buckets.map(toQuotaBucket);
  if (Array.isArray(r.accounts)) row.accounts = r.accounts.map(toAccount);
  if (r.serviceRunning !== undefined) row.serviceRunning = bool(r.serviceRunning);
  if (checkin) {
    row.checkin = {
      supported: bool(checkin.supported),
      ...(checkin.claimable !== undefined ? { claimable: bool(checkin.claimable) } : {}),
      ...(checkin.claimed !== undefined ? { claimed: bool(checkin.claimed) } : {}),
      ...(checkin.rewardCredits !== undefined ? { rewardCredits: nonNeg(checkin.rewardCredits) ?? 0 } : {}),
      ...(checkin.note !== undefined ? { note: sanitize(str(checkin.note)) } : {}),
    };
  }
  if (r.error !== undefined) row.error = r.error === null ? null : sanitize(str(r.error));
  if (r.fetchedAt !== undefined) row.fetchedAt = typeof r.fetchedAt === 'string' ? r.fetchedAt : null;
  return row;
}

/** 网关 `/v1/gateway/status` 的单条 → GatewayProviderSnap */
export function toGatewayProviderSnap(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const dialect = DIALECTS.has(s.dialect) ? s.dialect : null;
  const cooldownUntil = num(s.cooldownUntil);
  const cooldownKindRaw = s.cooldownKind;
  return {
    id: str(s.id),
    running: bool(s.running),
    dialect,
    port: num(s.port),
    weight: intOr(s.weight, 0),
    quotaRatio: num(s.quotaRatio),
    inFlight: intOr(s.inFlight, 0),
    consecutiveFails: intOr(s.consecutiveFails, 0),
    successRate: intOr(s.successRate, 0),
    // 网关以 0 表示"无冷却"
    cooldownUntil: cooldownUntil && cooldownUntil > 0 ? cooldownUntil : null,
    cooldownKind: cooldownKindRaw === 0 || cooldownKindRaw === '' || cooldownKindRaw == null ? null : str(cooldownKindRaw),
    sticky: intOr(s.sticky ?? s.stickySessions, 0),
  };
}

/** 网关 `/v1/gateway/status` → 领域模型（前端 gatewayStatusEnvelope） */
export function toGatewayStatus(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    ok: r.ok === undefined ? true : bool(r.ok),
    version: str(r.version),
    pid: num(r.pid),
    uptimeSec: intOr(r.uptimeSec, 0),
    strict: bool(r.strict),
    openMode: r.openMode === undefined ? true : bool(r.openMode),
    quotaSnapshotAt: num(r.quotaSnapshotAt),
    settings: r.settings && typeof r.settings === 'object' ? r.settings : {},
    providers: Array.isArray(r.providers) ? r.providers.map(toGatewayProviderSnap) : [],
  };
}

/**
 * 网关 `/v1/gateway/usage` → 前端 gatewayUsageSchema。
 * 网关原生为 `{days:[{day,...providers:{}}], totals:{...}}`；
 * 前端要的是 `{days:number, requests, errors, inputTokens, outputTokens, byDay[], byProvider[], byModel[]}`。
 */
export function toGatewayUsage(raw, days) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const dayRows = Array.isArray(r.days) ? r.days : [];
  const totals = r.totals && typeof r.totals === 'object' ? r.totals : {};
  const byProviderMap = new Map();
  for (const day of dayRows) {
    const providers = day && typeof day === 'object' && day.providers && typeof day.providers === 'object' ? day.providers : {};
    for (const [provider, value] of Object.entries(providers)) {
      const cur = byProviderMap.get(provider) ?? { provider, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
      cur.requests += intOr(value?.requests, 0);
      cur.errors += intOr(value?.errors, 0);
      cur.inputTokens += intOr(value?.inputTokens, 0);
      cur.outputTokens += intOr(value?.outputTokens, 0);
      byProviderMap.set(provider, cur);
    }
  }
  return {
    days: intOr(days ?? r.days, 7),
    requests: intOr(totals.requests, 0),
    errors: intOr(totals.errors, 0),
    inputTokens: intOr(totals.inputTokens, 0),
    outputTokens: intOr(totals.outputTokens, 0),
    byDay: dayRows.map((d) => ({
      day: str(d.day),
      requests: intOr(d.requests, 0),
      errors: intOr(d.errors, 0),
      inputTokens: intOr(d.inputTokens, 0),
      outputTokens: intOr(d.outputTokens, 0),
      avgDurationMs: intOr(d.avgDurationMs, 0),
      providers: d.providers ?? {},
    })),
    byProvider: [...byProviderMap.values()].sort((a, b) => b.requests - a.requests),
    byModel: [],
    totals: {
      requests: intOr(totals.requests, 0),
      errors: intOr(totals.errors, 0),
      inputTokens: intOr(totals.inputTokens, 0),
      outputTokens: intOr(totals.outputTokens, 0),
      avgDurationMs: intOr(totals.avgDurationMs, 0),
    },
  };
}

const COMBO_PREFIX = 'combo:';

/** 网关 `/v1/models` 里 `owned_by=combo` / id 以 `combo:` 开头的虚拟行 → Combo */
export function toCombo(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const id = str(m.id);
  const models = Array.isArray(m.combo)
    ? m.combo.filter((x) => typeof x === 'string')
    : Array.isArray(m.models)
      ? m.models.filter((x) => typeof x === 'string')
      : [];
  const strategy = m.strategy === 'round-robin' ? 'round-robin' : 'fallback';
  return {
    name: str(m.name, id.startsWith(COMBO_PREFIX) ? id.slice(COMBO_PREFIX.length) : id),
    models,
    strategy,
    available: true,
    id,
    context_length: num(m.context_length),
    supportsVision: bool(m.supports_vision ?? m.supportsVision),
    supportsTools: bool(m.supports_tools ?? m.supportsTools),
  };
}

export function isComboRow(model) {
  if (!model || typeof model !== 'object') return false;
  if (str(model.owned_by) === 'combo') return true;
  if (str(model.id).startsWith(COMBO_PREFIX)) return true;
  return Array.isArray(model.combo);
}

/**
 * `providers list --json` 的 providers[] → 前端 freeProviderSchema。
 * 只出元数据，**不含**任何 key 值（gateway/cli.mjs 的 keySource 已只给来源）。
 */
export function toFreeProvider(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const keySource = str(p.keySource, 'none');
  const local = bool(p.local);
  const ok = bool(p.ok);
  return {
    id: str(p.id),
    title: sanitize(str(p.name, str(p.id))),
    category: local ? 'local' : str(p.format, 'cloud'),
    local,
    hasKey: local || keySource !== 'none',
    baseUrl: sanitize(str(p.baseUrl)),
    status: ok ? 'ok' : keySource === 'none' && !local ? 'needs-key' : 'down',
    note: sanitize(str(p.reason ?? p.free ?? '')),
    format: str(p.format),
    env: str(p.env),
    keySource,
    ok,
    reason: p.reason == null ? null : sanitize(str(p.reason)),
    free: sanitize(str(p.free)),
    freeModels: Array.isArray(p.freeModels) ? p.freeModels.filter((m) => typeof m === 'string') : [],
  };
}

/**
 * 网关 `gateway/data/keys.json` 的单条 → 面板密钥行。
 *
 * 只映射**公开字段**：绝不返回 `hash`（密钥库只存 SHA-256），也不返回任何明文。
 * `prefix` 是公开的识别前缀，**不做** secret 脱敏（否则 `zsk_…` 会被掩码成不可读）。
 * 契约字段用 `tokenQuota` / `disabled`，同时补 `quota` / `enabled` 兼容别名。
 */
export function toGatewayKey(raw) {
  const k = raw && typeof raw === 'object' ? raw : {};
  const disabled = k.disabled === true;
  const tokenQuota = nonNeg(k.tokenQuota) ?? 0;
  const usedTokens = nonNeg(k.usedTokens) ?? 0;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    id: str(k.id),
    name: sanitize(str(k.name)),
    prefix: str(k.prefix),
    enabled: !disabled,
    disabled,
    providers: list(k.providers),
    models: list(k.models),
    ips: list(k.ips),
    tokenQuota,
    quota: tokenQuota,
    usedTokens,
    createdAt: typeof k.createdAt === 'string' ? k.createdAt : null,
    expiresAt: typeof k.expiresAt === 'string' ? k.expiresAt : null,
    note: sanitize(str(k.note)),
  };
}

/**
 * OpenCode session.stats 输出的 `data`（或缺省即整体）透传，仅补 range。
 *
 * 上游可能给 `null` 或缺失的数字字段；契约里这些是 `z.number()`，直接透传会
 * 让前端 schema 解析失败。这里只把**已知数值字段**兜底成 0，未知字段仍原样保留。
 */
export function toUsageStats(raw, { range, from, to }) {
  const stats = raw && typeof raw === 'object' ? raw : {};
  const n = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const tokensRaw = stats.tokens && typeof stats.tokens === 'object' ? stats.tokens : {};
  const cacheRaw = tokensRaw.cache && typeof tokensRaw.cache === 'object' ? tokensRaw.cache : null;
  const toolsRaw = stats.tools && typeof stats.tools === 'object' ? stats.tools : null;
  const totalsRaw = toolsRaw?.totals && typeof toolsRaw.totals === 'object' ? toolsRaw.totals : null;
  const tokens = {
    ...tokensRaw,
    input: n(tokensRaw.input),
    output: n(tokensRaw.output),
    reasoning: n(tokensRaw.reasoning),
    ...(cacheRaw ? { cache: { ...cacheRaw, read: n(cacheRaw.read), write: n(cacheRaw.write) } } : {}),
  };
  return {
    ...stats,
    sessions: n(stats.sessions),
    subagents: n(stats.subagents),
    prompts: n(stats.prompts),
    steps: n(stats.steps),
    tokens,
    cost: n(stats.cost),
    ...(toolsRaw
      ? {
          tools: {
            ...toolsRaw,
            ...(totalsRaw
              ? { totals: { ...totalsRaw, calls: n(totalsRaw.calls), succeeded: n(totalsRaw.succeeded), failed: n(totalsRaw.failed) } }
              : {}),
          },
        }
      : {}),
    activeDays: n(stats.activeDays),
    streak: n(stats.streak),
    activity: Array.isArray(stats.activity)
      ? stats.activity.filter((a) => a && typeof a === 'object').map((a) => ({ ...a, steps: n(a.steps) }))
      : [],
    models: Array.isArray(stats.models)
      ? stats.models
          .filter((m) => m && typeof m === 'object')
          .map((m) => ({ ...m, id: str(m.id), providerID: str(m.providerID), steps: n(m.steps), cost: n(m.cost) }))
      : [],
    range: stats.range && typeof stats.range === 'object' ? stats.range : { from, to },
    queryRange: range,
  };
}

/** 组装 Task（前端 contract.ts taskSchema）。 */
export function toTask(task) {
  return {
    actionId: task.actionId,
    action: task.action,
    providerIds: Array.isArray(task.providerIds) ? task.providerIds : [],
    accountKey: task.accountKey ?? null,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt ?? null,
    exitCode: task.exitCode ?? null,
    status: task.status,
    stdout: task.stdout ?? '',
    stderr: task.stderr ?? '',
    truncated: Boolean(task.truncated),
    refreshStatus: task.refreshStatus ?? 'pending',
  };
}

/** 本地应答开关的 5 个已知键（gateway/cli.mjs cmdLocal）。 */
export const LOCAL_ANSWER_KEYS = ['quota', 'prefix', 'title', 'suggestion', 'filepath'];

/**
 * 从 `node router.mjs gateway local` 的清理后文本里取开关。
 * gateway local 尚无 `--json`（05 §3.17 计划增加）；这里只对 5 个已知键做**受限**识别，
 * 无法识别的键不猜测，退化为默认（网关语义：未显式 false 即开启）。
 */
export function parseLocalAnswers(text) {
  const out = Object.fromEntries(LOCAL_ANSWER_KEYS.map((k) => [k, true]));
  const clean = sanitize(text);
  for (const key of LOCAL_ANSWER_KEYS) {
    const re = new RegExp(`^\\s*${key}\\s+(开|关|on|off|true|false)\\b`, 'im');
    const m = clean.match(re);
    if (!m) continue;
    out[key] = /^(开|on|true)$/i.test(m[1]);
  }
  return out;
}
