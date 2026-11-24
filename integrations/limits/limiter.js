/**
 * limiter.js — 本机限流器（零依赖，CommonJS）。
 *
 * 为什么需要它：这些反代的上游都**按「像不像人在用」判流量**。免费/订阅账号的
 * 真实并发上限往往只有 1~3（见 docs/02-pitfalls.md P16、docs/08-codearts.md
 * 「每账号 3 个并发会话」、zcode-bridge 的 `ZCODE_LANE_WIDTH=1`）。客户端一旦开
 * 多个子代理、并行跑工具、或者 CI 里并发跑用例，瞬间就能打出十几路并发——
 * 上游看到的不是「一个人在用」，而是「有人在套流」，轻则排队 10605、重则风控。
 *
 * 所以限流必须**做在本地、做在请求出去之前**，而不是等上游 429 再退避：
 * 后者已经产生了一次可疑请求，且冷却期整家不可用。
 *
 * 四个维度一起管，缺一个都挡不住：
 *   concurrency   同时进行中的请求数（最容易被上游判定为套流）
 *   rpm           每分钟请求数（滑动窗口，挡「快速重试风暴」）
 *   minIntervalMs 相邻两次请求的最小间隔（挡「一瞬间连发 10 个」）
 *   dailyCap      每日请求上限（挡「挂机刷量」，0 = 不限）
 *
 * 用法：
 *   const { createLimiterFor } = require('.../limiter.js');
 *   const limiter = createLimiterFor('raccoon');
 *   const release = await limiter.acquire({ signal });
 *   try { ... } finally { release(); }
 *
 * 被拒时抛 `LimiterBusy`：带 `retryAfterMs`，调用方据此回 429 + Retry-After。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 四档预设。数值是「一个人正常用」的量级，不是上游的硬上限。
 *
 * 为什么 rpm 给得比「每 2 秒一个」宽：agent 循环里每一步之间只隔几百毫秒
 * （模型回完就立刻发下一个工具调用），一轮复杂任务 30~50 步很常见。
 * 把 rpm 压到 24 会把正常使用误伤成 429。真正的「套流」特征是**并发**与
 * **无间隔连发**，所以那两项收紧，rpm 放宽到能容纳一次完整任务。
 *
 *   safe      极脆的上游：并发 1（上游按串行计量），连发就排队
 *   balanced  一般订阅：并发 2，仍留出「人和界面交互」的节奏
 *   fast      已确认宽松的上游：并发 4，适合并行工具调用
 *   max       最宽档：并发 64、600/分钟、无最小间隔；配合 limits.json 的
 *             `overrideHardCaps: true` 才能突破下面的 HARD_CAPS
 */
const PRESETS = {
  safe: { concurrency: 1, rpm: 20, minIntervalMs: 3000, burst: 1, dailyCap: 0 },
  balanced: { concurrency: 2, rpm: 40, minIntervalMs: 1500, burst: 2, dailyCap: 0 },
  fast: { concurrency: 4, rpm: 90, minIntervalMs: 700, burst: 4, dailyCap: 0 },
  max: { concurrency: 64, rpm: 600, minIntervalMs: 0, burst: 64, dailyCap: 0 },
};

/**
 * 各家的硬约束：来自上游文档或实测，**默认任何档位都不能突破**。
 * 只有 `limits.json` 里显式写 `"overrideHardCaps": true` 才会放开——
 * 那是「我知道会撞上游 429/风控，但就是要最宽」的选择。
 *
 *   zcode      zcode-bridge 的计划通道按串行计量（`ZCODE_LANE_WIDTH=1`），
 *              并发 2 会拿到 3009「model concurrency」
 *   codearts   每账号 3 个并发会话（`TM.00001041`），留 1 个余量给 IDE 自己
 *   qoder      P16：免费账号按并发排队（10605 isQueued），并发 1 才稳
 *   trae       tw2api 的 soft_rate 冷却 60 秒，属于「一撞就整家歇」的类型
 *   workbuddy  浏览器会话，同一账号多路并发会被判异常
 *   loomy / raccoon  订阅制积分，没有公开并发数，按「一个人开几个标签页」估
 *   dumate    订阅制积分，桌面端本身也会用它；并发 2 与「一个人开两个窗口」相当
 */
const HARD_CAPS = {
  'qoder-cn': { concurrency: 1 },
  qoder: { concurrency: 1 },
  'trae-local': { concurrency: 2 },
  codearts: { concurrency: 3 },
  zcode: { concurrency: 1 },
  workbuddy: { concurrency: 2 },
  'workbuddy-global': { concurrency: 2 },
  loomy: { concurrency: 2 },
  raccoon: { concurrency: 2 },
  // 千问办公：云端 MaaS 网关，按会话计量；并发 2 与桌面端单窗口的用量相当
  qwenwork: { concurrency: 2 },
  // 百度搭子：订阅积分，桌面端与反代共用同一份额度
  dumate: { concurrency: 2 },
  // WPS 灵犀：订阅智点，桌面端与反代共用同一份额度；反代内部 RPC 串行，
  // 并发 2 与「一个人开两个窗口」相当
  lingxi: { concurrency: 2 },
  // 有道龙虾：桌面端 tokenProxy 与反代共用同一账号额度；并发 2 与桌面端
  // 同时跑一个编码 agent + 一个对话窗口相当
  lobster: { concurrency: 2 },
};

/** 每家的默认档位：越脆的上游越保守。 */
const DEFAULT_TIER = {
  'qoder-cn': 'safe',
  qoder: 'safe',
  'trae-local': 'safe',
  codearts: 'balanced',
  zcode: 'safe',
  workbuddy: 'balanced',
  'workbuddy-global': 'balanced',
  loomy: 'balanced',
  raccoon: 'balanced',
  qwenwork: 'balanced',
  dumate: 'balanced',
  lingxi: 'balanced',
  lobster: 'balanced',
};

/** 自由供应商（云端 key）：按「普通 API 的礼貌用量」给一档，别把免费额度刷成风控。 */
const DEFAULT_FREE_LIMITS = { concurrency: 2, rpm: 30, minIntervalMs: 1200, burst: 2, dailyCap: 0 };

const LIMITS_FILE = process.env.ROUTER_LIMITS_FILE
  ? path.resolve(process.env.ROUTER_LIMITS_FILE)
  : path.join(__dirname, '..', '..', 'limits.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 读 `limits.json`；文件不存在或写坏时返回空配置（全部走默认档）。 */
function loadLimits(file = LIMITS_FILE) {
  const raw = readJson(file) || {};
  const tier = String(raw.tier || 'balanced').toLowerCase();
  return {
    file,
    tier: PRESETS[tier] ? tier : 'balanced',
    // 最宽配置的显式开关：默认仍按 HARD_CAPS 封顶，避免误配把上游打成风控。
    overrideHardCaps: raw.overrideHardCaps === true,
    providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
    free: raw.free && typeof raw.free === 'object' ? { ...DEFAULT_FREE_LIMITS, ...raw.free } : DEFAULT_FREE_LIMITS,
  };
}

function pickTierName(id, cfg) {
  const own = cfg.providers[id] && cfg.providers[id].tier;
  if (own && PRESETS[String(own).toLowerCase()]) return String(own).toLowerCase();
  return DEFAULT_TIER[id] || cfg.tier;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 解析出某家最终生效的限额：默认档 → 档位预设 → 该家覆盖 → 硬约束封顶。
 *
 * 顺序很重要：**硬约束最后生效**，否则用户写 `zcode: {concurrency: 8}` 会把
 * 一个必然 3009 的配置当成「用户自己的选择」放过。只有显式打开
 * `overrideHardCaps` 才跳过这一步（最宽配置）。
 *
 * 「免费供应商」（云端 API-Key 直连）走 `cfg.free`：它们不在 `DEFAULT_TIER` 里，
 * 也没有硬约束，但同样不该被并发刷——免费额度的风控往往比订阅更敏感。
 */
function resolveLimits(id, cfg = loadLimits()) {
  const isFree = !DEFAULT_TIER[id] && !HARD_CAPS[id];
  const tier = isFree ? null : pickTierName(id, cfg);
  const preset = isFree ? cfg.free || DEFAULT_FREE_LIMITS : PRESETS[tier] || PRESETS.balanced;
  const own = cfg.providers[id] || {};
  const out = {
    tier: isFree ? 'free' : tier,
    concurrency: num(own.concurrency, preset.concurrency),
    rpm: num(own.rpm, preset.rpm),
    minIntervalMs: num(own.minIntervalMs, preset.minIntervalMs),
    burst: num(own.burst, preset.burst),
    dailyCap: num(own.dailyCap, preset.dailyCap),
  };
  const cap = cfg.overrideHardCaps ? null : HARD_CAPS[id];
  if (cap) {
    for (const [k, v] of Object.entries(cap)) out[k] = Math.min(out[k], v);
  }
  // 至少留 1 路并发，否则这家永远发不出去
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.rpm = Math.max(1, Math.trunc(out.rpm));
  out.burst = Math.max(1, Math.trunc(out.burst));
  return out;
}

class LimiterBusy extends Error {
  constructor(message, retryAfterMs, kind = 'rate_limit') {
    super(message);
    this.name = 'LimiterBusy';
    this.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs));
    this.kind = kind;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 建一个限流器。所有状态在进程内存里——限流本来就该是「本进程看到的流量」，
 * 落盘反而会引入多进程互相踩的问题（router 与网关是两个进程）。
 *
 * 三个闸门一起判断，任一不满足就不放行：
 *   并发     inFlight < concurrency
 *   令牌桶   每 minIntervalMs 补 1 个令牌，容量 burst（挡瞬时连发）
 *   滑动窗口 最近 60 秒 < rpm（挡「慢速但持续」的刷量）
 * 另加每日上限 dailyCap（0 = 不限）。
 *
 * 令牌桶的初值是满的（`burst` 个），这样**第一次请求不会被自己挡住**——
 * 早期版本用 `lastStart = 0` 判 `t - lastStart < minInterval`，在 t=0 的
 * 第一次调用上就成立，表现为「刚启动就限流」。
 */
function createLimiter(limits, { now = Date.now } = {}) {
  const cfg = {
    concurrency: Math.max(1, Math.trunc(limits.concurrency || 1)),
    rpm: Math.max(1, Math.trunc(limits.rpm || 1)),
    minIntervalMs: Math.max(0, Math.trunc(limits.minIntervalMs || 0)),
    burst: Math.max(1, Math.trunc(limits.burst || 1)),
    dailyCap: Math.max(0, Math.trunc(limits.dailyCap || 0)),
    tier: limits.tier || 'balanced',
  };

  let inFlight = 0;
  /** 令牌桶：容量 = burst，每 minIntervalMs 补 1。minIntervalMs=0 时恒满。 */
  let tokens = cfg.burst;
  let refilledAt = now();
  /** 最近 60 秒内的启动时间戳（滑动窗口）。 */
  let window = [];
  let day = dayKey(now());
  let dayCount = 0;
  const waiters = [];
  let timer = null;

  function prune(t) {
    const cutoff = t - 60_000;
    if (window.length && window[0] < cutoff) window = window.filter((x) => x >= cutoff);
    const today = dayKey(t);
    if (today !== day) {
      day = today;
      dayCount = 0;
    }
  }

  function refill(t) {
    if (cfg.minIntervalMs <= 0) {
      tokens = cfg.burst;
      refilledAt = t;
      return;
    }
    const elapsed = t - refilledAt;
    if (elapsed <= 0) return;
    const gained = Math.floor(elapsed / cfg.minIntervalMs);
    if (gained <= 0) return;
    tokens = Math.min(cfg.burst, tokens + gained);
    refilledAt += gained * cfg.minIntervalMs;
    // 桶满时把基准时间贴到现在，避免长时间空闲后 refilledAt 落在很久以前
    if (tokens >= cfg.burst) refilledAt = t;
  }

  function dailyExhausted() {
    return cfg.dailyCap > 0 && dayCount >= cfg.dailyCap;
  }

  /** 当前最早能开工的时间；`blocked: 'daily'` 表示今天彻底没额度了。 */
  function nextAllowedAt(t) {
    prune(t);
    refill(t);
    if (dailyExhausted()) return { blocked: 'daily' };
    let at = t;
    if (tokens < 1 && cfg.minIntervalMs > 0) {
      at = Math.max(at, refilledAt + cfg.minIntervalMs);
    }
    // 窗口已满：要等最早那个滑出 60 秒
    if (window.length >= cfg.rpm) at = Math.max(at, window[0] + 60_000);
    return { at };
  }

  function canStart(t) {
    prune(t);
    refill(t);
    if (dailyExhausted()) return false;
    if (inFlight >= cfg.concurrency) return false;
    if (tokens < 1) return false;
    if (window.length >= cfg.rpm) return false;
    return true;
  }

  /** 记账：扣令牌、进窗口、加计数。 */
  function consume(t) {
    if (tokens >= 1) tokens -= 1;
    window.push(t);
    dayCount += 1;
    inFlight += 1;
  }

  function drain() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while (waiters.length) {
      const t = now();
      prune(t);
      const head = waiters[0];
      // 排队超时：预计等太久的调用方不该一直挂着，给它一个明确的 429
      if (Number.isFinite(head.deadline) && t >= head.deadline) {
        waiters.shift();
        head.reject(
          new LimiterBusy(
            `本地限流：排队超过上限（${cfg.rpm}/分钟）`,
            Math.max(1000, nextAllowedAt(t).at ? nextAllowedAt(t).at - t : 1000),
          ),
        );
        continue;
      }
      if (dailyExhausted()) {
        // 每日上限：立刻拒掉所有等待者，而不是让它们等到明天
        const w = waiters.shift();
        w.reject(new LimiterBusy(`今日请求已达本地上限（${cfg.dailyCap}）`, 60_000, 'daily_cap'));
        continue;
      }
      if (!canStart(t)) {
        const next = nextAllowedAt(t);
        if (next.blocked === 'daily') continue;
        const waitMs = Math.max(20, next.at - t);
        timer = setTimeout(() => {
          timer = null;
          drain();
        }, Math.min(waitMs, 5000));
        timer.unref?.();
        return;
      }
      const w = waiters.shift();
      consume(t);
      w.resolve(makeRelease());
    }
  }

  function makeRelease() {
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      drain();
    };
  }

  return {
    limits: cfg,
    /**
     * 拿一个执行位；返回 release()。
     *
     * `maxWaitMs` 是排队上限：预计要等更久时立刻抛 LimiterBusy，而不是让客户端
     * 挂在一个永远等不到的队上。网关用它把「本地限流」变成明确的 429 + Retry-After。
     */
    acquire({ signal, maxWaitMs = Infinity } = {}) {
      if (signal?.aborted) {
        return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }
      // 先看一眼：现在就要等超过上限的话，直接拒，不进队
      const t0 = now();
      if (!canStart(t0)) {
        const next = nextAllowedAt(t0);
        const waitMs = next.blocked === 'daily' ? 60_000 : Math.max(0, next.at - t0);
        // 并发满时 nextAllowedAt 给的等待是 0，只有 release 才能推进——那属于
        // 「值得排一下」的情况，不受 maxWaitMs 影响。
        const concurrencyBound = inFlight >= cfg.concurrency;
        if (next.blocked === 'daily') {
          return Promise.reject(new LimiterBusy(`今日请求已达本地上限（${cfg.dailyCap}）`, 60_000, 'daily_cap'));
        }
        if (!concurrencyBound && waitMs > maxWaitMs) {
          return Promise.reject(
            new LimiterBusy(
              `本地限流：${Math.ceil(waitMs / 1000)} 秒后才有额度（${cfg.rpm}/分钟）`,
              waitMs,
            ),
          );
        }
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, deadline: Number.isFinite(maxWaitMs) ? t0 + maxWaitMs : Infinity };
        if (signal) {
          const onAbort = () => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          waiter.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        const wrappedResolve = (release) => {
          if (waiter.onAbort) signal?.removeEventListener?.('abort', waiter.onAbort);
          resolve(release);
        };
        waiter.resolve = wrappedResolve;
        waiters.push(waiter);
        drain();
      });
    },
    /** 立刻判断能不能发（不排队），给「快速失败」的调用方用。 */
    tryAcquire() {
      const t = now();
      if (!canStart(t)) return null;
      consume(t);
      return makeRelease();
    },
    /** 现在这一刻能否开始（不消耗额度）。给调度器判「这家是否还吃得下」。 */
    canStartNow() {
      return canStart(now());
    },
    /** 现在被挡住的话，大概要等多久（毫秒）。0 = 随时可发。 */
    retryAfterMs() {
      const t = now();
      prune(t);
      refill(t);
      if (dailyExhausted()) return 60_000;
      if (inFlight >= cfg.concurrency) return 1000;
      const next = nextAllowedAt(t);
      if (next.blocked) return 60_000;
      return Math.max(0, next.at - t);
    },
    snapshot() {
      const t = now();
      prune(t);
      refill(t);
      return {
        tier: cfg.tier,
        concurrency: cfg.concurrency,
        rpm: cfg.rpm,
        minIntervalMs: cfg.minIntervalMs,
        burst: cfg.burst,
        dailyCap: cfg.dailyCap,
        inFlight,
        queued: waiters.length,
        tokens: Number(tokens.toFixed(2)),
        windowUsed: window.length,
        dayCount,
        retryAfterMs: this.retryAfterMs(),
        t,
      };
    },
  };
}

/** 每家一个单例：同一个进程里 router / 网关 / 反代各自持有自己的一份。 */
const registry = new Map();

function createLimiterFor(id, { cfg = null, now } = {}) {
  const limitsCfg = cfg || loadLimits();
  const key = `${id}@${limitsCfg.file}`;
  if (!now && registry.has(key)) return registry.get(key);
  const limiter = createLimiter(resolveLimits(id, limitsCfg), now ? { now } : {});
  limiter.provider = id;
  if (!now) registry.set(key, limiter);
  return limiter;
}

/** 全部已知 provider 的生效限额（给 `router limits` 与文档用）。 */
function describeLimits(ids, { cfg = loadLimits() } = {}) {
  return ids.map((id) => ({
    id,
    ...resolveLimits(id, cfg),
    file: cfg.file,
    hardCapsOverridden: cfg.overrideHardCaps === true,
    tierSource: cfg.providers[id] && cfg.providers[id].tier
      ? 'override'
      : DEFAULT_TIER[id]
        ? 'provider-default'
        : HARD_CAPS[id]
          ? 'hardcap-only'
          : 'free',
  }));
}

module.exports = {
  PRESETS,
  HARD_CAPS,
  DEFAULT_TIER,
  DEFAULT_FREE_LIMITS,
  LIMITS_FILE,
  LimiterBusy,
  loadLimits,
  resolveLimits,
  createLimiter,
  createLimiterFor,
  describeLimits,
  sleep,
};
