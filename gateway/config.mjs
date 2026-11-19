/**
 * 统一网关的配置与路径。
 *
 * 数据目录放在 `gateway/data/`：仓库根 `.gitignore` 里的 `**\/data/` 已经把它排除了，
 * 里面是密钥（只存 SHA-256）、用量记录与用户配置，属于机密，绝不入库。
 *
 * 端口只认环境变量：router.mjs 探活时也要用同一个值，两边都读
 * `ROUTER_GATEWAY_PORT`，避免「配置里改了端口、router 还在探旧端口」这种漂移。
 */

import fs from 'node:fs';
import path from 'node:path';

export const GATEWAY_DIR = import.meta.dirname;
export const REPO_ROOT = path.join(GATEWAY_DIR, '..');

export const DATA_DIR = process.env.ROUTER_GATEWAY_DATA
  ? path.resolve(process.env.ROUTER_GATEWAY_DATA)
  : path.join(GATEWAY_DIR, 'data');

export const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const USAGE_DIR = path.join(DATA_DIR, 'usage');

export const DEFAULT_PORT = 8785;
export const PORT = Number(process.env.ROUTER_GATEWAY_PORT || DEFAULT_PORT);
/** 默认只监听回环：这是一个把本机订阅额度拼起来的网关，不该默认暴露到局域网。 */
export const HOST = process.env.ROUTER_GATEWAY_HOST || '127.0.0.1';

/**
 * 调度默认值。与 OpenResolver 的 pools/settings.mjs 同构，但这里是**供应商级**：
 * router 没法替各家反代在账号之间选号（有的要改文件再重启），所以调度单位是
 * 「哪一家反代」，账号健康只作为权重参考（见 registry.mjs 的 healthWeight）。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** 单个请求最多换几家供应商 */
  maxAttempts: 3,
  /** 加权随机只在权重最高的前 N 家里掷骰子，避免每次都钉在同一家 */
  topN: 2,
  /** 同一家供应商允许的并发请求数 */
  maxInFlight: 4,
  /** 粘性会话有效期：同一会话尽量留在同一家 */
  stickyTtlMs: 30 * 60_000,
  /** 上游限流 */
  rateLimitCooldownMs: 120_000,
  /** 上游 5xx / 网络错误 */
  serverCooldownMs: 60_000,
  /** 额度用尽（402 / 业务码） */
  quotaCooldownMs: 600_000,
  /** 凭证失效：等人工重登，冷却给长一点 */
  authCooldownMs: 1_800_000,
  /** 连续失败到这个次数开始指数退避 */
  breakerThreshold: 3,
  breakerCooldownMs: 120_000,
  /** 退避上限 */
  breakerCapMs: 900_000,
});

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

const CLAMPS = {
  maxAttempts: [1, 10],
  topN: [1, 10],
  maxInFlight: [1, 64],
  stickyTtlMs: [0, 24 * 3_600_000],
  rateLimitCooldownMs: [0, 3_600_000],
  serverCooldownMs: [0, 3_600_000],
  quotaCooldownMs: [0, 24 * 3_600_000],
  authCooldownMs: [0, 24 * 3_600_000],
  breakerThreshold: [1, 100],
  breakerCooldownMs: [0, 24 * 3_600_000],
  breakerCapMs: [0, 24 * 3_600_000],
};

/** 非法值返回 undefined，调用方保留原值——绝不因为配置写错就把冷却清零。 */
export function clampSetting(key, value) {
  const range = CLAMPS[key];
  if (!range) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(range[1], Math.max(range[0], Math.trunc(n)));
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/**
 * 网关配置：`gateway/data/config.json`（可选）。
 *
 *   {
 *     "strict": false,              // true = 回环也必须带有效密钥
 *     "upstreamTimeoutMs": 600000,
 *     "maxBodyBytes": 8388608,
 *     "aliases":  { "fast": "trae-local/deepseek-v4.1-flash" },
 *     "fallbacks": { "trae-local": ["zcode", "codearts"] },
 *     "weights":   { "trae-local": 20, "codearts": 0 },
 *     "settings":  { "maxAttempts": 4 },
 *     "localAnswers": { "quota": true, "title": true },   // 本地应答开关
 *     "combos": [ { "name": "fast", "models": [...], "strategy": "fallback" } ]
 *   }
 *
 * `weights` 里的 0 表示硬关掉这家（不参与调度），不写默认 10。
 */
export function loadConfig() {
  const raw = readJson(CONFIG_FILE, {}) || {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    if (!(key in (raw.settings || {}))) continue;
    const v = clampSetting(key, raw.settings[key]);
    if (v !== undefined) settings[key] = v;
  }
  return {
    strict: raw.strict === true || process.env.ROUTER_GATEWAY_STRICT === '1',
    upstreamTimeoutMs: Number(process.env.ROUTER_GATEWAY_TIMEOUT_MS || raw.upstreamTimeoutMs || 600_000),
    maxBodyBytes: Number(process.env.ROUTER_GATEWAY_MAX_BODY || raw.maxBodyBytes || 8 * 1024 * 1024),
    aliases: raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
    fallbacks: raw.fallbacks && typeof raw.fallbacks === 'object' ? raw.fallbacks : {},
    weights: raw.weights && typeof raw.weights === 'object' ? raw.weights : {},
    // 本地应答：默认全开（省额度），传 false 关掉某一项或整族
    localAnswers:
      raw.localAnswers === false
        ? Object.fromEntries(['quota', 'prefix', 'title', 'suggestion', 'filepath'].map((k) => [k, false]))
        : raw.localAnswers && typeof raw.localAnswers === 'object'
          ? raw.localAnswers
          : {},
    combos: Array.isArray(raw.combos) ? raw.combos : [],
    settings,
    source: raw,
  };
}

export function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(USAGE_DIR, { recursive: true });
}
