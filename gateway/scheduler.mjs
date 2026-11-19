/**
 * 供应商级调度器：加权选家、粘性会话、冷却、指数退避。
 *
 * 为什么是「供应商级」而不是「账号级」：
 * router 管的九家反代里，只有 CodeArts / Trae / WorkBuddy 有账号池，而且换号要改文件
 * 再重启进程（见 docs/05-operations.md）。在一个 HTTP 请求里做账号级切换不现实，
 * 所以网关只在**反代之间**调度；账号健康通过 `router account check` 暴露，额度通过
 * `router gateway balance` 写进 quota 快照，间接参与权重。
 *
 * weight = (quotaFactor + idleBonus + successFactor) × manualWeight
 *   quotaFactor   = 额度比例 × 10        （无快照 → 取同批已知均值，不惩罚）
 *   idleBonus     = min(闲置小时 × 0.5, 5)（从未用过按 999 小时）
 *   successFactor = 最近 50 次成功率 × 3
 *   manualWeight  = config.weights[id]，默认 10；0 = 硬过滤
 *
 * 这套公式与 OpenResolver pools/base.mjs 一致，便于两个项目之间对照排查。
 *
 * **并发上限取两处的最小值**：`settings.maxInFlight`（网关自己的）与
 * `integrations/limits/limiter.js` 里那家反代的本地限额。后者是「别把上游当套流」
 * 的那条线（例如 zcode 只允许 1 路），网关不能靠配置绕过它——否则
 * `gateway combo` 里把 zcode 排第一就会打满 4 路并发、直接吃 3009。
 */

import { DEFAULT_SETTINGS } from './config.mjs';
import { createLimiter, resolveLimits, loadLimits } from '../integrations/limits/limiter.js';

const DEFAULT_MANUAL_WEIGHT = 10;
const SUCCESS_WINDOW = 50;
const NEVER_USED_HOURS = 999;
/** 额度快照超过这个时间就不再用它参与权重，避免拿着半天前的数字调度。 */
const QUOTA_STALE_MS = 30 * 60_000;

const clampManual = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MANUAL_WEIGHT;
  return Math.min(20, Math.max(0, n));
};

const clampRatio = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
};

function headerValue(headers, name) {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function firstUserText(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return '';
  const msg = messages.find((m) => m?.role === 'user');
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * 粘性会话 key：请求头优先，最后回退到首条 user 文本。
 * 必须混入密钥 id，否则不同密钥的同一句 prompt 会撞到同一家。
 * 完全无来源时返回 null —— 不启用粘性（纯加权）。
 */
export function sessionKeyOf({ req, body, keyId } = {}) {
  const headers = req?.headers || {};
  let source =
    headerValue(headers, 'x-router-session') ||
    headerValue(headers, 'x-session-id') ||
    headerValue(headers, 'x-conversation-id') ||
    (typeof body?.metadata?.conversation_id === 'string' ? body.metadata.conversation_id : null);

  if (!source) {
    const text = firstUserText(body);
    if (!text) return null;
    // 只取前 4KB：长 prompt 的后半段往往是文件内容，哈希它会让「同一轮对话」不断换 key
    source = text.slice(0, 4096);
  }
  return `k${keyId ?? 'anon'}:${hash(source)}`;
}

/** 非加密哈希（FNV-1a 32 位）：粘性 key 只需要稳定，不需要抗碰撞。 */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function createScheduler({
  ids = [],
  weights = {},
  quota = null,
  settings = DEFAULT_SETTINGS,
  // 本机限额：undefined = 读 limits.json（默认，生产路径）；
  // false = 关闭本地限流（selftest 用它把限流从调度测试里摘出去）；
  // 对象 = 用给定配置（测试）。
  limits = undefined,
  rng = Math.random,
  now = Date.now,
} = {}) {
  const current = { ...DEFAULT_SETTINGS, ...settings };
  const limitsCfg = limits === false ? null : limits || loadLimits();
  const limiters = new Map();
  /**
   * 每家一个 limiter，**由 scheduler 自己持有**，不走 `createLimiterFor` 的进程级
   * 单例：网关与 router 是不同进程，各自持有才正确；而同一个进程里若有两个
   * scheduler（测试、或多租户场景），共享单例会让它们互相吃掉对方的额度。
   * `now` 也透传下去，否则测试用固定时钟时 limiter 仍走真实时间。
   */
  const limiterFor = (id) => {
    if (!limitsCfg) return null;
    if (!limiters.has(id)) limiters.set(id, createLimiter(resolveLimits(id, limitsCfg), { now }));
    return limiters.get(id);
  };

  /** 某家实际允许的并发：网关设置与本地限额取小。 */
  function concurrencyOf(id) {
    const limiter = limiterFor(id);
    const local = limiter ? limiter.limits.concurrency : Infinity;
    return Math.max(1, Math.min(current.maxInFlight, local));
  }

  /** 这一家现在能不能再吃一个请求（并发 + 速率都算）。 */
  function hasCapacity(acc) {
    if (acc.inFlight >= concurrencyOf(acc.id)) return false;
    const limiter = limiterFor(acc.id);
    // 速率维度只影响「现在能不能发」，不参与权重；被它挡住时 pick 会去挑别家
    return limiter ? limiter.canStartNow() : true;
  }

  const runtime = ids.map((id) => ({
    id,
    manualWeight: clampManual(weights[id] ?? DEFAULT_MANUAL_WEIGHT),
    inFlight: 0,
    cooldownUntil: 0,
    cooldownKind: null,
    consecutiveFails: 0,
    lastUsedAt: 0,
    outcomes: [],
  }));
  const byId = new Map(runtime.map((a) => [a.id, a]));

  /** key → { id, expiresAt }：按 id 存，账号/权重变化后粘性仍有效。 */
  const sticky = new Map();

  /** 额度比例来自 router 写的快照；过期或缺失返回 null（不参与权重）。 */
  function ratioOf(acc) {
    if (!quota || typeof quota !== 'object') return null;
    // 注意用 isFinite 而不是真值判断：`at: 0` 是合法时间戳，
    // 用 `if (quota.at && ...)` 会让它跳过过期检查，拿着半天前的额度调度。
    if (!Number.isFinite(quota.at) || now() - quota.at > QUOTA_STALE_MS) return null;
    const row = quota.pools?.[acc.id];
    if (!row) return null;
    if (Number.isFinite(row.ratio)) return clampRatio(row.ratio);
    // 没有 ratio 但有 total/balance 时现算：额度耗尽的供应商权重会自然掉到 0
    if (Number.isFinite(row.total) && row.total > 0 && Number.isFinite(row.remaining)) {
      return clampRatio(row.remaining / row.total);
    }
    return null;
  }

  function weightOf(acc, peers = runtime) {
    const own = ratioOf(acc);
    let quotaFactor;
    if (own !== null) {
      quotaFactor = own * 10;
    } else {
      const known = peers.map(ratioOf).filter((r) => r !== null);
      quotaFactor = known.length ? (known.reduce((s, r) => s + r, 0) / known.length) * 10 : 0;
    }
    const idleHours = acc.lastUsedAt ? Math.max(0, (now() - acc.lastUsedAt) / 3_600_000) : NEVER_USED_HOURS;
    const idleBonus = Math.min(idleHours * 0.5, 5);
    const rate = successRateOf(acc);
    return (quotaFactor + idleBonus + rate * 3) * acc.manualWeight;
  }

  function successRateOf(acc) {
    const o = acc.outcomes || [];
    return o.length ? o.reduce((s, ok) => s + ok, 0) / o.length : 0;
  }

  function recordOutcome(acc, ok) {
    acc.outcomes.push(ok ? 1 : 0);
    if (acc.outcomes.length > SUCCESS_WINDOW) acc.outcomes.splice(0, acc.outcomes.length - SUCCESS_WINDOW);
  }

  function cooldownFor(kind, fails) {
    if (kind === 'rate_limit') return fails >= 2 ? current.rateLimitCooldownMs * 2 : current.rateLimitCooldownMs;
    if (kind === 'server') return current.serverCooldownMs;
    if (kind === 'quota') return current.quotaCooldownMs;
    if (kind === 'auth') return current.authCooldownMs;
    return 0;
  }

  function eligible(candidates, exclude) {
    return candidates.filter(
      (a) => a.manualWeight > 0 && !(exclude?.has(a.id)),
    );
  }

  function weightedPick(candidates) {
    if (!candidates.length) return null;
    const scored = candidates
      .map((a) => ({ acc: a, weight: weightOf(a, candidates) }))
      .sort((x, y) => y.weight - x.weight);
    const top = scored.slice(0, Math.max(1, current.topN));
    const total = top.reduce((s, i) => s + i.weight, 0);
    // 全零权重（都被额度快照判死）时等权随机，而不是钉在 top-N 的第一个
    if (total <= 0) return candidates[Math.floor(rng() * candidates.length)];
    let roll = rng() * total;
    for (const item of top) {
      roll -= item.weight;
      if (roll < 0) return item.acc;
    }
    return top[top.length - 1].acc;
  }

  /**
   * 选家。
   *
   * `prefer` 是路由给出的候选顺序。
   *   - 默认：候选集就是 prefer，但**内部仍按权重**挑（裸模型名 / 别名场景，
   *     让额度与成功率决定用哪家）；
   *   - `ordered: true`：严格按 prefer 顺序取第一个可用的（显式 `<provider>/<model>`
   *     场景，用户写死了哪家就该是哪家）。
   */
  /**
   * 选家。
   *
   * `prefer` 是路由给出的候选顺序。
   *   - 默认：候选集就是 prefer，但**内部仍按权重**挑（裸模型名 / 别名场景，
   *     让额度与成功率决定用哪家）；
   *   - `ordered: true`：严格按 prefer 顺序取第一个可用的（显式 `<provider>/<model>`
   *     场景，用户写死了哪家就该是哪家）；
   *   - `ignoreCapacity: true`：忽略本地限流的速率/并发闸门，只避开冷却中的家。
   *     调用方拿到候选后由 `limiter.acquire({maxWaitMs})` 自己排队——「等多久」
   *     只应该有一个地方决定，否则两处各等一次会把延迟叠起来。
   */
  function pick({
    exclude = new Set(),
    allowFallback = true,
    prefer = null,
    ordered = false,
    ignoreCapacity = false,
  } = {}) {
    const t = now();
    const base = prefer && prefer.length ? prefer.map((id) => byId.get(id)).filter(Boolean) : runtime;
    const pool = eligible(base.length ? base : runtime, exclude);
    const ready = pool.filter((a) => a.cooldownUntil <= t && (ignoreCapacity || hasCapacity(a)));
    if (ready.length) {
      if (ordered) return ready[0];
      return weightedPick(ready);
    }
    if (!allowFallback) return null;
    // 全在冷却时，挑最早恢复的那家——比直接 429 更可能成功（上游可能只是瞬时抖动）
    const cooling = pool
      .filter((a) => a.cooldownUntil > t && a.inFlight < concurrencyOf(a.id))
      .sort((x, y) => x.cooldownUntil - y.cooldownUntil);
    return cooling[0] ?? null;
  }

  function onSuccess(acc) {
    acc.consecutiveFails = 0;
    acc.cooldownUntil = 0;
    acc.cooldownKind = null;
    acc.lastUsedAt = now();
    recordOutcome(acc, true);
  }

  function onUpstreamError(acc, cls = {}) {
    const kind = cls.kind || 'client';
    acc.consecutiveFails += 1;
    recordOutcome(acc, false);
    let cooldown = cooldownFor(kind, acc.consecutiveFails);
    if (kind !== 'auth' && kind !== 'client' && acc.consecutiveFails >= current.breakerThreshold) {
      cooldown = Math.max(
        cooldown,
        Math.min(
          current.breakerCooldownMs * 2 ** (acc.consecutiveFails - current.breakerThreshold),
          current.breakerCapMs,
        ),
      );
    }
    // 冷却只增不减：短冷却不能抹掉还在生效的长冷却
    acc.cooldownUntil = Math.max(acc.cooldownUntil, now() + cooldown);
    acc.cooldownKind = kind;
    return acc.cooldownUntil;
  }

  function stickyGet(key, { readyOnly = false } = {}) {
    const entry = sticky.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      sticky.delete(key);
      return null;
    }
    const acc = byId.get(entry.id) ?? null;
    if (!acc) {
      sticky.delete(key);
      return null;
    }
    if (
      readyOnly &&
      (acc.manualWeight <= 0 || acc.cooldownUntil > now() || acc.inFlight >= concurrencyOf(acc.id))
    ) {
      return null;
    }
    entry.expiresAt = now() + current.stickyTtlMs;
    return acc;
  }

  function stickySet(key, acc) {
    if (!key || !acc) return;
    if (sticky.size > 1000) {
      const t = now();
      for (const [k, v] of sticky) if (v.expiresAt <= t) sticky.delete(k);
    }
    sticky.set(key, { id: acc.id, expiresAt: now() + current.stickyTtlMs });
  }

  function stickyClear(key) {
    if (key) sticky.delete(key);
  }

  function snapshot() {
    const t = now();
    return runtime.map((a) => {
      const limiter = limiterFor(a.id);
      return {
        id: a.id,
        weight: Number(weightOf(a).toFixed(2)),
        manualWeight: a.manualWeight,
        quotaRatio: ratioOf(a),
        inFlight: a.inFlight,
        cooldownUntil: a.cooldownUntil,
        cooldownRemainingMs: Math.max(0, a.cooldownUntil - t),
        cooldownKind: a.cooldownKind,
        consecutiveFails: a.consecutiveFails,
        successRate: Number(successRateOf(a).toFixed(3)),
        lastUsedAt: a.lastUsedAt,
        stickySessions: [...sticky.values()].filter((v) => v.id === a.id && v.expiresAt > t).length,
        // 本机限额：让 `gateway status` 能直接看出「这家是被限流挡住还是冷却挡住」
        limit: limiter
          ? {
              tier: limiter.limits.tier,
              concurrency: limiter.limits.concurrency,
              effectiveConcurrency: concurrencyOf(a.id),
              rpm: limiter.limits.rpm,
              minIntervalMs: limiter.limits.minIntervalMs,
              dailyCap: limiter.limits.dailyCap,
              windowUsed: limiter.snapshot().windowUsed,
              dayCount: limiter.snapshot().dayCount,
              throttled: !limiter.canStartNow(),
              retryAfterMs: limiter.retryAfterMs(),
            }
          : null,
      };
    });
  }

  /** 429 文案需要的可用性快照：区分「全在冷却」「并发打满」「本地限流」。 */
  function unavailableInfo() {
    const t = now();
    const pool = eligible(runtime, new Set());
    const cooling = pool.filter((a) => a.cooldownUntil > t);
    const ready = pool.filter((a) => a.cooldownUntil <= t);
    const throttled = ready.filter((a) => !hasCapacity(a));
    const retryHints = throttled
      .map((a) => limiterFor(a.id)?.retryAfterMs() || 0)
      .filter((ms) => ms > 0);
    return {
      pool: pool.length,
      cooling: cooling.length,
      saturated: ready.length > 0 && throttled.length === ready.length,
      localLimited: throttled.length > 0 && retryHints.length > 0,
      soonestRecovery: cooling.length ? Math.min(...cooling.map((a) => a.cooldownUntil)) : 0,
      // 被本地限流挡住时，最早多久能再发（毫秒）
      soonestThrottleMs: retryHints.length ? Math.min(...retryHints) : 0,
    };
  }

  return {
    runtime,
    settings: current,
    pick,
    weightOf,
    successRateOf,
    onSuccess,
    onUpstreamError,
    stickyGet,
    stickySet,
    stickyClear,
    snapshot,
    unavailableInfo,
    /** 某家实际允许的并发（网关设置与本地限额取小）。 */
    concurrencyOf,
    /** 某家当前的本地限流器（网关在发请求前用它取执行位）。 */
    limiterFor,
    /** 把本机限额表整体换掉（`router limits` 改完文件后热更新用）。 */
    reloadLimits(next) {
      limiters.clear();
      if (next === null) return;
      Object.assign(limitsCfg || {}, next || {});
    },
    /**
     * 确保这些 id 都有运行态。
     *
     * 为什么需要：网关启动时只有本机 9 家有 runtime，而免费供应商的可用性取决于
     * 「key 配了没」——那是运行时才确定的（`router providers key`）。没有这个方法，
     * 后配的供应商在 scheduler 里查不到，`pick()` 会把它当作不存在，于是候选集里
     * 明明有它、请求却报「所有供应商暂不可用」。
     *
     * 新加入的不重置已有状态：冷却、成功率、粘性都保留。
     */
    ensure(extraIds = []) {
      const added = [];
      for (const id of extraIds) {
        if (!id || byId.has(id)) continue;
        const acc = {
          id,
          manualWeight: clampManual(weights[id] ?? DEFAULT_MANUAL_WEIGHT),
          inFlight: 0,
          cooldownUntil: 0,
          cooldownKind: null,
          consecutiveFails: 0,
          lastUsedAt: 0,
          outcomes: [],
        };
        runtime.push(acc);
        byId.set(id, acc);
        added.push(id);
      }
      return added;
    },
    get(id) {
      return byId.get(id) ?? null;
    },
  };
}
