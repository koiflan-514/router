/**
 * 供应商目录（网关视角）。
 *
 * 每家反代的**端口与协议能力**写在这里。为什么不在 router.mjs 里复用 `PROVIDERS`：
 * 那份表带着 spawn 用的命令行、日志路径、账号运维逻辑，而网关只需要「端口 + 说哪种方言」。
 * 两边一旦漂移就是最难查的故障（请求打到旧端口，看起来像上游挂了），所以 router 侧有
 * `router gateway doctor` 做交叉校验：它拿自己 PROVIDERS 的 port 跟这张表逐条比。
 *
 * dialect：
 *   openai    只有 /v1/chat/completions（Qoder、Trae、WorkBuddy、Loomy）
 *   both      两种方言都有（CodeArts、ZCode），优先用原生方言，少一层转换
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './config.mjs';
import { FREE_PROVIDERS } from './free-providers.mjs';

const FREE_PROVIDER_IDS = FREE_PROVIDERS.map((p) => p.id);

const HOME = os.homedir();

/** Trae 反代随包发了个本机 Bearer key。 */
const TRAE_ENV = path.join(REPO_ROOT, 'integrations', 'traework2api', '.env.local');
const CODEARTS_DATA = path.join(REPO_ROOT, 'integrations', 'codearts2api', 'codearts2api-data.json');
const PI_MODELS = path.join(HOME, '.pi', 'agent', 'models.json');

/** Trae 的 /v1/models 混着内部子代理，选中就报错。与 scripts/pi-models.mjs 保持一致。 */
export const INTERNAL_MODEL = /^custom_model|_(sub)?agent(_v\d)?$|^summary$|^computer_use|^browser_use|^file_search/;

export const DESCRIPTORS = [
  { id: 'qoder-cn', port: 8789, dialect: 'openai', key: 'qoder-local' },
  { id: 'qoder', port: 8790, dialect: 'openai', key: 'qoder-local' },
  { id: 'trae-local', port: 7863, dialect: 'openai', key: traeKey(), skip: (id) => INTERNAL_MODEL.test(String(id)) },
  {
    id: 'codearts',
    port: 10087,
    dialect: 'both',
    key: codeartsKey(),
  },
  { id: 'workbuddy', port: 8787, dialect: 'openai', key: 'workbuddy-local', catalogFromDisk: true },
  { id: 'workbuddy-global', port: 8788, dialect: 'openai', key: 'workbuddy-local', catalogFromDisk: true },
  { id: 'zcode', port: 20131, dialect: 'both', key: 'zcode-local' },
  { id: 'loomy', port: 8791, dialect: 'openai', key: 'loomy-local', modelsPath: '/models?type=chat' },
  // 商汤小浣熊：上游本来就吐 OpenAI，代理只补鉴权与目录，所以只有一种方言。
  {
    id: 'raccoon',
    port: 8793,
    // 生图走 /v1/images/generations，模型清单只含对话模型
    dialect: 'openai',
    key: 'raccoon-local',
  },
  // 千问办公：上游原生支持 OpenAI 与 Anthropic 两种方言，网关优先用原生。
  { id: 'qwenwork', port: 8794, dialect: 'both', key: 'qwenwork-local' },
  // 百度搭子：本机反代自动发现 DuMate main-server 的随机端口，对外只有 OpenAI 方言。
  { id: 'dumate', port: 8795, dialect: 'openai', key: 'dumate-local' },
  // WPS 灵犀：反代自己 spawn lingxi.exe app-server（JSON-RPC stdio），对外只有
  // OpenAI 方言。灵犀是完整 agent，不吐 tool_calls——网关转发 tools 时它只会
  // 返回文本，适合对话不适合编码驱动（见 integrations/lingxi2api/README.md）。
  { id: 'lingxi', port: 8796, dialect: 'openai', key: 'lingxi-local' },
  // 有道龙虾（LobsterAI）：本机反代优先复用桌面端的 tokenProxy，桌面端退出后直连
  // 上游；对外只有 OpenAI 方言。yd-fast / yd-ultra 是虚拟档位，反代转发前会先解析。
  { id: 'lobster', port: 8797, dialect: 'openai', key: 'lobster-local' },
];

export const BY_ID = new Map(DESCRIPTORS.map((d) => [d.id, d]));

/** 免费供应商的 id 集合（云端 + 本机免账号）。 */
export const FREE_IDS = new Set(FREE_PROVIDER_IDS);

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function traeKey() {
  const line = readText(TRAE_ENV)
    .split(/\r?\n/)
    .find((l) => l.startsWith('TW2A_API_KEY='));
  const v = line ? line.slice('TW2A_API_KEY='.length).trim() : '';
  return v && v !== 'changeme' ? v : null;
}

/** CodeArts 签发的 `sk-ca-...`，取第一个启用的。 */
function codeartsKey() {
  try {
    const data = JSON.parse(readText(CODEARTS_DATA) || '{}');
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const hit = keys.find((k) => k && k.enabled !== false && typeof k.key === 'string' && k.key.startsWith('sk-ca-'));
    return hit ? hit.key : null;
  } catch {
    return null;
  }
}

/**
 * pi 的 models.json 里该 provider 的 apiKey。它是本机「客户端已经在用」的那份 key，
 * 优先于内置占位值：Trae / CodeArts 真校验，占位值会 401。
 * 注意 models.json 里可能同时存在 `TokenPlus` 与 `TOKENPLUS` 这种只差大小写的键，
 * JSON.parse 本身没问题，所以这里直接读文本解析，不用任何「大小写不敏感」的包装。
 */
export function piApiKey(providerId) {
  try {
    const cfg = JSON.parse(readText(PI_MODELS) || '{}');
    const p = cfg && cfg.providers && cfg.providers[providerId];
    return p && typeof p.apiKey === 'string' && p.apiKey ? p.apiKey : null;
  } catch {
    return null;
  }
}

/** 上游入站鉴权用的 key：pi 里配了就用它，否则用反代自己的占位值。 */
export function upstreamKeyFor(id) {
  const d = BY_ID.get(id);
  if (!d) return null;
  return piApiKey(id) || d.key || null;
}

/** 当前 router 开关（router.json 的 enabled）。读不到就当作全开。 */
export function enabledIds() {
  const all = DESCRIPTORS.map((d) => d.id);
  try {
    const s = JSON.parse(readText(path.join(REPO_ROOT, 'router.json')) || '{}');
    if (Array.isArray(s.enabled)) {
      const known = new Set(all);
      // 开关里可能混着 `gateway` 自己（它不是上游），剔掉再判断
      const picked = s.enabled.filter((id) => known.has(id));
      // `on gateway` 会把开关收成只剩网关自己；那种情况下按「十二家全开」处理，
      // 否则网关一个上游都没有、只能返回 502，看起来像网关坏了。
      return picked.length ? picked : all;
    }
  } catch {}
  return all;
}

// ---------------------------------------------------------------- 模型目录

/**
 * 每家 `/v1/models` 的缓存。60 秒是折中：足够让一个对话轮次里的多次请求共用一次拉取，
 * 又不至于在用户刚 `router models` 之后还看到旧清单。
 *
 * 拉取失败时**返回上一次成功的清单**（stale），而不是空数组——反代刚重启的几秒里
 * 把模型列表清空会让客户端直接报「模型不存在」，比给一份略旧的清单糟得多。
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function normalizeModels(json) {
  const arr = Array.isArray(json) ? json : (json && (json.data || json.models)) || [];
  return arr
    .map((m) => {
      const id = typeof m === 'string' ? m : m && (m.id || m.slug);
      if (!id) return null;
      const caps = (m && m.capabilities) || {};
      const declaredInput = Array.isArray(m && m.input_modalities) ? m.input_modalities : [];
      return {
        id,
        name: (m && (m.name || m.display_name)) || id,
        // Qoder 把上下文放在 limit.context（不是 context_length），漏了这层会让
        // 网关目录、以及写进 pi / opencode 的 contextWindow 全是默认值。
        context: (m && (m.context_length || m.context_window || m.limit?.context)) || null,
        // 能力位也往下带：pi 靠它决定要不要给 thinking 档位、能不能贴图。
        // 网关自己不用这两项，但 /v1/models 与 pi 的 provider 需要。
        vision: caps.vision === true || declaredInput.includes('image'),
        reasoning: caps.reasoning === true,
      };
    })
    .filter(Boolean);
}

/**
 * WorkBuddy 的模型目录不能抄反代的 /v1/models：那是包作者按公开资料猜的静态表，
 * 里面既有服务端不认的 id（11102 service info not found），也漏掉真正能用的模型。
 * 真实目录由桌面端落盘在 acc-product-config-v*.json（与 pi 扩展 workbuddy.ts 同源），
 * 这里直接读它，多份时取 mtime 最新的。
 *
 * 国内版与国际版各自一个目录；读不到时返回 null，由调用方退回反代的清单。
 */
const WORKBUDDY_CATALOG_DIRS = {
  workbuddy: [
    path.join(HOME, '.workbuddy', 'cache'),
    path.join(HOME, '.workbuddy', 'cache', 'conversation-product-spill'),
  ],
  'workbuddy-global': [path.join(HOME, '.workbuddy-ai', 'cache')],
};

/** 与 workbuddy.ts 的 UNSERVABLE_MODEL_IDS / GLOBAL_UNSERVABLE_MODEL_IDS 保持一致。 */
const WORKBUDDY_UNSERVABLE = {
  workbuddy: new Set([
    'completion-gf',
    'deepseek-v3-1',
    'deepseek-v3-1-volc',
    'deepseek-v3-1-lkeap',
    'deepseek-v3-0324-lkeap',
    'deepseek-r1-0528-lkeap',
    'default-1.1',
    'default-1.2',
    'glm-4.6',
    'glm-4.6v',
    'glm-5.0-turbo',
    'hunyuan-2.0-instruct',
    'hy4-preview-x',
    'kimi-k2-instruct-taiji',
    'kimi-k2-thinking',
    'minimax-m2.5',
  ]),
  'workbuddy-global': new Set(['deep-model']),
};

/** 桌面端把 Auto 当模式而非模型，但上游确实能调；国内版补在最前面。 */
const WORKBUDDY_SUPPLEMENT = { workbuddy: ['auto'], 'workbuddy-global': [] };

/**
 * 目录读不到时的兜底。**与 workbuddy.ts 的 STATIC_MODELS / GLOBAL_STATIC_MODELS 同步**
 * （那是 2026-11 逐个实测的结果），而不是反代的静态表——后者含 claude-4.0 / gpt-5 /
 * gemini-2.5-pro 这类会被上游以 11158 not allowed 拒绝的 id。
 * 国际版没有桌面端目录时就走这份。
 */
const WORKBUDDY_STATIC = {
  workbuddy: [
    ['auto', 256000], ['fast-model', 300000], ['balanced-model', 300000], ['deep-model', 300000],
    ['hy3', 192000], ['hy3-b', 192000], ['hy3-c', 192000], ['hy3-x', 192000],
    ['hy4-preview-ctrl', 960000], ['hy4-preview-exp', 960000],
    ['glm-5.3', 1000000], ['glm-5.3-flash', 1000000], ['glm-5.2', 1000000],
    ['kimi-k3-1', 1000000], ['kimi-k2.8-preview', 1000000], ['kimi-k2.5', 256000],
    ['minimax-m2.7', 200000], ['deepseek-v4-flash', 1000000], ['deepseek-v4.1-flash', 1000000],
    ['deepseek-v4-pro', 1000000], ['deepseek-v3-2-volc', 96000], ['hunyuan-chat', 128000],
    ['space-bunny', 1000000], ['step-5-preview', 1000000], ['mimo-v2.6-pro', 1000000],
    ['minimax-m3.1-flash', 1000000], ['kimi-k3.1-pro', 1000000], ['hy4free', 960000], ['hy4std', 960000],
  ],
  'workbuddy-global': [
    ['default-model', 176000], ['max-model', 272000], ['deepseek-v4.1-flash-sg', 1000000],
    ['glm-5.3-flash', 1000000], ['hy4free', 1000000], ['hy4std', 1000000], ['hy3', 192000],
    ['glm-5.3', 1000000], ['minimax-m3.1-flash', 1000000], ['kimi-k3', 1000000],
  ],
};

function staticCatalog(id) {
  const rows = WORKBUDDY_STATIC[id];
  if (!rows) return null;
  return rows.map(([modelId, context]) => ({ id: modelId, name: modelId, context }));
}

function latestCatalogFile(dirs) {
  let best = null;
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^acc-product-config-v\d+.*\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch {}
    }
  }
  return best && best.file;
}

/** 从桌面端产品目录读 WorkBuddy 的真实可服务模型；读不到返回 null。 */
export function workbuddyCatalogModels(id) {
  const dirs = WORKBUDDY_CATALOG_DIRS[id];
  if (!dirs) return null;
  const file = latestCatalogFile(dirs);
  if (!file) return null;
  let parsed;
  try {
    parsed = JSON.parse(readText(file));
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed && parsed.models) ? parsed.models : [];
  const unservable = WORKBUDDY_UNSERVABLE[id] || new Set();
  const models = entries
    .filter((m) => m && typeof m.id === 'string' && m.supportsToolCall === true && !unservable.has(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name && String(m.name).trim() ? String(m.name).trim() : m.id,
      context: m.maxInputTokens || null,
    }));
  if (!models.length) return null;
  // 补充项（auto）放在最前，顺序稳定
  for (const extra of [...(WORKBUDDY_SUPPLEMENT[id] || [])].reverse()) {
    if (!models.some((m) => m.id === extra)) models.unshift({ id: extra, name: extra, context: null });
  }
  return models;
}

export async function modelsOf(id, { force = false, timeout = 5000 } = {}) {
  const d = BY_ID.get(id);
  if (!d) return [];
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models;

  // WorkBuddy 的清单来自桌面端产品目录，不是反代的静态表（见 workbuddyCatalogModels）
  if (d.catalogFromDisk) {
    const fromDisk = workbuddyCatalogModels(id) || staticCatalog(id);
    if (fromDisk && fromDisk.length) {
      cache.set(id, { at: Date.now(), models: fromDisk });
      return fromDisk;
    }
  }

  const key = upstreamKeyFor(id);
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/v1${d.modelsPath || '/models'}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = normalizeModels(await res.json()).filter((m) => !(d.skip && d.skip(m.id)));
    if (!models.length) throw new Error('模型清单为空');
    cache.set(id, { at: Date.now(), models });
    return models;
  } catch {
    return hit ? hit.models : [];
  }
}

export function invalidateModels(id) {
  if (id) cache.delete(id);
  else cache.clear();
}

/** 全部已开启供应商的模型并集：`<provider>/<model>` 加上原始条目。 */
export async function catalog({ ids = enabledIds(), force = false } = {}) {
  const rows = await Promise.all(
    ids.map(async (id) => ({ id, models: await modelsOf(id, { force }) })),
  );
  return rows.filter((r) => r.models.length);
}

/** 某个模型 id 在哪些供应商上存在（大小写不敏感，反代之间大小写不统一）。 */
export async function providersServing(model, { ids = enabledIds(), force = false } = {}) {
  const want = String(model || '').toLowerCase();
  const rows = await catalog({ ids, force });
  return rows.filter((r) => r.models.some((m) => m.id.toLowerCase() === want)).map((r) => r.id);
}

// ---------------------------------------------------------------- 免费供应商

/**
 * 免费供应商（云端 API-Key 直连 + 本机免账号）的接入。
 *
 * 它们和本机各家反代在调度器眼里**是同一种东西**（一个可选的 upstream），
 * 差别只在「怎么发请求」：本机走 127.0.0.1 的固定端口，免费供应商走云端 HTTPS
 * 且要带真 key。所以这里只提供三样东西给上层：
 *
 *   allIds()          合并后的全部上游 id
 *   modelsOfAny(id)   不分来源的模型清单
 *   isFree(id)        是不是免费供应商（决定用哪个 adapter 发请求）
 */

/** 免费供应商里当前**可用**的（有 key 或本机、baseUrl 无占位符）。 */
export async function freeEnabledIds() {
  const { activeProviders } = await import('./provider-keys.mjs');
  return activeProviders()
    .filter((r) => r.ok)
    .map((r) => r.def.id);
}
/** 全部上游 id：本机各家反代（受 router.json 开关约束）+ 可用的免费供应商。 */
export async function allUpstreamIds() {
  return [...enabledIds(), ...(await freeEnabledIds())];
}

export function isFreeProvider(id) {
  return FREE_IDS.has(id);
}

/** 不分来源的模型清单。 */
export async function modelsOfAny(id, opts = {}) {
  if (FREE_IDS.has(id)) {
    const { freeModelsOf } = await import('./free-upstream.mjs');
    return freeModelsOf(id, opts);
  }
  return modelsOf(id, opts);
}

/** 这个 id 是不是一个已知上游（本机反代或免费供应商）。 */
export function knownAny(id) {
  return BY_ID.has(id) || FREE_IDS.has(id);
}

/**
 * 某个模型在哪些上游上存在 —— 不分来源。
 *
 * 与本文件的 `providersServing` 的区别：那个只看本机反代，这个把免费供应商也算进来。
 * 裸模型名的自动选家必须用这个，否则「只在 OpenRouter 上的免费模型」永远找不到。
 */
export async function servingAny(model, { ids = null, force = false } = {}) {
  const want = String(model || '').toLowerCase();
  const scope = ids ?? (await allUpstreamIds());
  const rows = await Promise.all(scope.map(async (id) => ({ id, models: await modelsOfAny(id, { force }) })));
  return rows.filter((r) => r.models.some((m) => m.id.toLowerCase() === want)).map((r) => r.id);
}

