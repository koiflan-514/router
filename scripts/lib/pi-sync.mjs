/**
 * pi 侧 `~/.pi/agent/models.json` 的唯一写入点。
 *
 * 为什么要收口：router 现在有三个入口会碰 pi 的模型表——
 *   `scripts/pi-models.mjs`（六家本机反代）
 *   `router gateway install`（统一网关）
 *   `router providers install`（免费供应商）
 * 三处各写一份备份/合并逻辑，迟早出现「一个入口把另一个入口刚写的 provider 覆盖掉」。
 * 这里只做两件事：**读改写 models.json**、**把网关与免费供应商的目录翻译成 pi 的 provider**。
 *
 * 约定：
 *   - 只增/改自己的 provider id，其它 provider（TokenPlus、scf、用户手写的）原样保留；
 *   - 写前备份到 `models.backups/`，内容没变就不写、不备份；
 *   - Qoder / WorkBuddy 不走这里（pi 侧由扩展直连，写进来反而会抢 OAuth 凭据，
 *     见 docs/02-pitfalls.md P19）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferReasoning, withReasoning } from './model-caps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const PI_DIR = path.join(os.homedir(), '.pi', 'agent');
export const PI_MODELS_FILE = path.join(PI_DIR, 'models.json');
export const PI_BACKUP_DIR = path.join(PI_DIR, 'models.backups');

/** 网关在 opencode 里的 provider 名，pi 侧沿用同一份（两边能对着看）。 */
export const GATEWAY_PROVIDER_ID = 'router-gateway';
export const GATEWAY_PROVIDER_NAME = 'router 统一网关';
/** 网关回环免密钥，但 pi / opencode 都强制带一个非空 apiKey。 */
export const GATEWAY_API_KEY = 'router-local';

/**
 * pi 侧统一的上下文/输出限额：所有写入 models.json 的模型都套这一层。
 * 与 opencode 的 token-limits 默认值一致，避免两边看到的限额不同。
 */
export const PI_MODEL_LIMITS = { context: 300_000, output: 32_000 };

/** 把 provider 里的每个模型都写成统一限额，并补上缺失的 reasoning 能力位。 */
export function applyPiModelLimits(provider) {
  if (!provider || !Array.isArray(provider.models)) return provider;
  return {
    ...provider,
    models: provider.models.map((model) =>
      withReasoning({
        ...model,
        contextWindow: PI_MODEL_LIMITS.context,
        maxTokens: PI_MODEL_LIMITS.output,
      }),
    ),
  };
}

export const gatewayBaseUrl = () =>
  `http://127.0.0.1:${Number(process.env.ROUTER_GATEWAY_PORT || 8785)}/v1`;

// ---------------------------------------------------------------- 文件读写

export function readPiModelsConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(PI_MODELS_FILE, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

export function backupPiModels() {
  try {
    if (!fs.existsSync(PI_MODELS_FILE)) return null;
    fs.mkdirSync(PI_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(PI_BACKUP_DIR, `models-${stamp}.json`);
    fs.copyFileSync(PI_MODELS_FILE, dest);
    return dest;
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON 让 pi 整个模型表失效。 */
export function writePiModelsConfig(cfg) {
  fs.mkdirSync(PI_DIR, { recursive: true });
  const tmp = `${PI_MODELS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, PI_MODELS_FILE);
}

/** 稳定字符串化，用来判断「内容真变了没有」（键顺序不同不算变化）。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 合并一组 provider（`{ id, ...provider }`）。
 *
 * 返回 `{ added, unchanged, removed, backup, file }`：`added` 是实际改动的 id，
 * `unchanged` 是内容一样、跳过的 id。全部一样时不备份、不落盘。
 */
export function mergePiProviders(list, { dryRun = false } = {}) {
  const cfg = readPiModelsConfig();
  cfg.providers = cfg.providers && typeof cfg.providers === 'object' ? cfg.providers : {};
  const added = [];
  const unchanged = [];
  for (const { id, ...provider } of list) {
    if (!id) continue;
    const next = applyPiModelLimits(provider);
    if (stable(cfg.providers[id]) === stable(next)) {
      unchanged.push(id);
      continue;
    }
    added.push({ id, models: (next.models || []).length });
    cfg.providers[id] = next;
  }
  if (!added.length || dryRun) return { added, unchanged, backup: null, file: PI_MODELS_FILE };
  const backup = backupPiModels();
  writePiModelsConfig(cfg);
  return { added, unchanged, backup, file: PI_MODELS_FILE };
}

/** 从 pi 的 models.json 里移除 provider（只动给定的 id）。 */
export function removePiProviders(ids, { dryRun = false } = {}) {
  const cfg = readPiModelsConfig();
  cfg.providers = cfg.providers && typeof cfg.providers === 'object' ? cfg.providers : {};
  const removed = [];
  for (const id of ids) {
    if (cfg.providers[id]) {
      removed.push(id);
      delete cfg.providers[id];
    }
  }
  if (!removed.length || dryRun) return { removed, backup: null, file: PI_MODELS_FILE };
  const backup = backupPiModels();
  writePiModelsConfig(cfg);
  return { removed, backup, file: PI_MODELS_FILE };
}

// ---------------------------------------------------------------- 模型条目

const positive = (n) => (Number.isFinite(n) && n > 0 ? n : undefined);

/** pi 的 models.json 只接受 text / image，别把 audio / video 写进去（整份会校验失败）。 */
function modalities(...mods) {
  return [...new Set(['text', ...mods.filter((m) => m === 'image')])];
}

/**
 * 把网关 / 免费供应商的模型（`{ id, name, context }` 或带 capabilities 的原始形状）
 * 翻译成 pi 的模型条目。
 */
export function piModelEntry(raw, { name, context, vision, reasoning } = {}) {
  const id = raw.id || raw.slug;
  if (!id) return null;
  const caps = raw.capabilities || {};
  const input = modalities(caps.vision === true || vision === true ? 'image' : null);
  const entry = { id };
  const display = name || raw.name || raw.display_name;
  if (display && display !== id) entry.name = display;
  if (caps.reasoning === true || reasoning === true || inferReasoning(id)) entry.reasoning = true;
  const ctx = positive(context ?? raw.context_length ?? raw.context_window ?? raw.limit?.context);
  if (ctx) entry.contextWindow = ctx;
  const out = positive(raw.max_output_tokens ?? raw.limit?.output);
  if (out) entry.maxTokens = out;
  if (input.length > 1) entry.input = input;
  return entry;
}

// ---------------------------------------------------------------- 统一网关

/**
 * 网关作为 pi 的一个 provider：**模型 id 就是网关 `/v1/models` 里的
 * `<供应商>/<模型>`**（外加 combo 虚拟模型），所以 pi 只配一个 baseURL 就能跨供应商。
 *
 * `entries` 可以传已经算好的目录（`router gateway install` 里已经拉过一遍），
 * 不传就自己去问九家 + 免费供应商。
 */
export async function gatewayPiProvider({ entries, combos = [], force = true } = {}) {
  const baseUrl = gatewayBaseUrl();
  const models = [];

  if (!entries) {
    const { modelsOfAny, allUpstreamIds } = await import(
      new URL('../../gateway/providers.mjs', import.meta.url).href
    );
    const ids = await allUpstreamIds();
    const rows = await Promise.all(ids.map(async (id) => ({ id, models: await modelsOfAny(id, { force }) })));
    entries = [];
    for (const row of rows) {
      for (const m of row.models) {
        entries.push({
          id: `${row.id}/${m.id}`,
          name: `${row.id}/${m.name || m.id}`,
          context: m.context,
          vision: m.vision,
          reasoning: m.reasoning,
        });
      }
    }
  }

  for (const e of entries) {
    const entry = piModelEntry(
      { id: e.id },
      { name: e.name, context: e.context, vision: e.vision, reasoning: e.reasoning },
    );
    if (entry) models.push(entry);
  }

  // combo 是网关的虚拟模型（跨供应商降级链），和 /v1/models 一致地广播给 pi。
  for (const c of combos) {
    const entry = piModelEntry({ id: c.id }, { name: c.name, context: c.context_length });
    if (!entry) continue;
    if (c.supports_vision) entry.input = modalities('image');
    models.push(entry);
  }

  return {
    id: GATEWAY_PROVIDER_ID,
    name: GATEWAY_PROVIDER_NAME,
    baseUrl,
    api: 'openai-completions',
    apiKey: GATEWAY_API_KEY,
    models,
  };
}

/** 网关侧已启用的 combo，供 pi 侧一并写出。 */
export async function gatewayCombos() {
  const { activeCombos } = await import(new URL('../../gateway/route.mjs', import.meta.url).href);
  const { loadConfig } = await import(new URL('../../gateway/config.mjs', import.meta.url).href);
  try {
    return activeCombos(loadConfig());
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 免费供应商

/**
 * 一家免费供应商写成 pi provider：直连上游（与 `providers install` 写 opencode 同一口径），
 * 不经过网关。baseUrl 含占位符或没有 key 的由调用方过滤。
 */
export function freePiProvider({ id, name, baseUrl, baseURL, apiKey, models }) {
  const list = (models || [])
    .map((m) => piModelEntry(m, { context: m.context }))
    .filter(Boolean);
  return {
    id,
    name: name || id,
    baseUrl: String(baseUrl || baseURL || '').replace(/\/+$/, ''),
    api: 'openai-completions',
    apiKey: apiKey || 'local',
    models: list,
  };
}

/**
 * 全部「当前可用」的免费供应商（有 key / 本机免账号，baseUrl 无占位符，
 * 并且能拉到模型清单）。`ids` 为空表示全选。
 */
export async function freePiProviders({ ids, store, env, force = true } = {}) {
  const { activeProviders } = await import(new URL('../../gateway/provider-keys.mjs', import.meta.url).href);
  const { freeModelsOf } = await import(new URL('../../gateway/free-upstream.mjs', import.meta.url).href);
  const wanted = ids && ids.length ? new Set(ids) : null;
  const rows = activeProviders(store, env).filter((r) => r.ok && (!wanted || wanted.has(r.def.id)));
  const out = [];
  const skipped = [];
  for (const r of rows) {
    const models = await freeModelsOf(r.def.id, { force, store, env });
    if (!models.length) {
      skipped.push({ id: r.def.id, reason: '拿不到模型清单' });
      continue;
    }
    out.push(
      freePiProvider({
        id: r.def.id,
        name: r.def.name,
        baseUrl: r.baseUrl,
        apiKey: r.key || 'local',
        models,
      }),
    );
  }
  return { providers: out, skipped };
}
