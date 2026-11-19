/**
 * 模型解析与候选顺序。
 *
 * 与 OpenResolver 的 `<pool>/<model>` 相比，这里多两种写法：
 *
 *   `trae-local/deepseek-v4.1-flash`   显式指定供应商（等价于 OpenResolver 的池前缀）
 *   `deepseek-v4.1-flash`              裸模型名 —— 在所有可用的上游里找谁有它
 *   `combo:fast`                       降级链（见 combo.mjs）
 *
 * 裸模型名是这次升级的重点：客户端只认模型名，让人为了「换个供应商」去改配置很别扭。
 * 找不到任何上游时报 404 并列出可用模型，而不是让上游回一个含糊的 400。
 *
 * **「上游」包含两类**：本机 9 家反代（`providers.mjs`）与免费供应商
 * （`free-providers.mjs`，云端 API-Key + 本机免账号）。对这个文件来说两者没有区别，
 * 所以全部查询都走 `modelsOfAny` / `servingAny` / `knownAny`，不要直接碰 BY_ID。
 */

import { enabledIds, modelsOfAny, servingAny, knownAny } from './providers.mjs';
import { normalizeCombos, chainFor, currentTurn, COMBO_PREFIX } from './combo.mjs';
import { freeEnabledIds } from './providers.mjs';

export class RouteError extends Error {
  constructor(message, status = 404, type = 'not_found_error', extra = {}) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.type = type;
    Object.assign(this, extra);
  }
}

/** 拆 `<provider>/<model>`；只按第一个 `/` 切，模型名里允许再带 `/`（如 `qwen/qwen3`）。 */
export function splitModel(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new RouteError('model 不能为空', 400, 'invalid_request_error');
  }
  const s = id.trim();
  const slash = s.indexOf('/');
  if (slash <= 0) return { provider: null, model: s };
  const provider = s.slice(0, slash);
  const model = s.slice(slash + 1);
  if (!model) throw new RouteError(`"${provider}/" 缺少模型名`, 400, 'invalid_request_error');
  return { provider, model };
}

/**
 * 把请求里的模型名匹配到一条 combo。
 *
 * 接受三种写法：`combo:fast`、`fast`（链名）、以及配置里的 `name`。
 * 只匹配**启用**的链；禁用的链当作不存在，让报错落到「没有这个模型」。
 */
export function matchCombo(rawModel, config = {}) {
  const combos = normalizeCombos(config.combos).filter((c) => !c.disabled);
  if (!combos.length) return null;
  const wanted = String(rawModel ?? '').trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  for (const combo of combos) {
    if (combo.id.toLowerCase() === lower) return combo;
    if (combo.id.slice(COMBO_PREFIX.length).toLowerCase() === lower) return combo;
    if (combo.name.toLowerCase() === lower) return combo;
  }
  return null;
}

/** 全部启用中的 combo（给 /v1/models 广播用）。 */
export function activeCombos(config = {}) {
  return normalizeCombos(config.combos).filter((c) => !c.disabled);
}

/** 当前可用的全部上游 id（本机 9 家 + 免费供应商）。 */
export async function allIds() {
  return [...enabledIds(), ...(await freeEnabledIds())];
}

/**
 * 解析出「按优先级排好的候选供应商」。
 *
 * 三种模式：
 *   combo    `combo:<名字>` 或链名 —— 一条用户命名的有序链，可跨供应商跨模型
 *   pinned   显式写了 `<provider>/<model>` —— 优先那一家，失败才按 fallbacks 换家
 *   auto     裸模型名 / 别名 —— 所有能提供它的上游，交给调度器按权重挑
 */
export async function resolveCandidates(rawModel, config = {}, { ids = null, force = false } = {}) {
  const scope = ids ?? (await allIds());

  // ---- combo：先认链名，再认 `<provider>/<model>`
  const combo = matchCombo(rawModel, config);
  if (combo) {
    const links = chainFor(combo, currentTurn(combo.id));
    const candidates = [];
    /** 供应商 → 该链上要用的模型名。裸模型名的一环会展开成多家，各自同名。 */
    const modelByProvider = {};
    const missing = [];
    for (const link of links) {
      try {
        const spec = splitModel(link);
        if (spec.provider) {
          if (!knownAny(spec.provider)) {
            missing.push(link);
            continue;
          }
          const own = await modelsOfAny(spec.provider, { force });
          if (own.length && !own.some((m) => m.id.toLowerCase() === spec.model.toLowerCase())) {
            missing.push(link);
            continue;
          }
          if (!candidates.includes(spec.provider)) candidates.push(spec.provider);
          modelByProvider[spec.provider] = spec.model;
        } else {
          const serving = await servingAny(spec.model, { ids: scope, force });
          if (!serving.length) {
            missing.push(link);
            continue;
          }
          for (const id of serving) {
            if (!candidates.includes(id)) candidates.push(id);
            modelByProvider[id] = spec.model;
          }
        }
      } catch {
        missing.push(link);
      }
    }
    if (!candidates.length) {
      throw new RouteError(
        `降级链 "${combo.name}" 上没有任何可用环节`,
        503,
        'api_error',
        { hint: missing.length ? `不可用：${missing.join('、')}` : null },
      );
    }
    return {
      model: modelByProvider[candidates[0]] ?? rawModel,
      modelByProvider,
      candidates,
      combo,
      missing,
      viaAlias: null,
      explicit: null,
      mode: 'combo',
    };
  }

  let spec = splitModel(rawModel);
  let viaAlias = null;

  const alias = config.aliases?.[spec.model] ?? config.aliases?.[rawModel];
  if (alias && !spec.provider) {
    viaAlias = spec.model;
    spec = splitModel(alias);
  }

  if (spec.provider) {
    if (!knownAny(spec.provider)) {
      throw new RouteError(
        `未知供应商 "${spec.provider}"，可用：${(await allIds()).join('、')}`,
        400,
        'invalid_request_error',
      );
    }
    const own = await modelsOfAny(spec.provider, { force });
    if (own.length && !own.some((m) => m.id.toLowerCase() === spec.model.toLowerCase())) {
      // 模型不在目录里：可能是新加的、或目录缓存过期。仍允许直连（上游会给出准确错误），
      // 但把「同名的哪几家有」一并带上，方便判断是不是写错了供应商。
      const elsewhere = await servingAny(spec.model, { ids: scope, force });
      throw new RouteError(
        `${spec.provider} 没有模型 "${spec.model}"`,
        404,
        'not_found_error',
        { hint: elsewhere.length ? `该模型在：${elsewhere.join('、')}` : null, model: spec.model },
      );
    }
    const candidates = [spec.provider];
    for (const id of config.fallbacks?.[spec.provider] || []) {
      if (id === spec.provider || !knownAny(id) || !scope.includes(id)) continue;
      const list = await modelsOfAny(id, { force });
      if (!list.length || list.some((m) => m.id.toLowerCase() === spec.model.toLowerCase())) candidates.push(id);
    }
    // 显式前缀默认**不**扩散到其它供应商：写死了 trae-local 就是 trae-local。
    // 想让它也享受跨供应商转移，配 `fallbacks` 或在 config 里打开 explicitFailover。
    if (config.explicitFailover === true) {
      for (const id of await servingAny(spec.model, { ids: scope, force })) {
        if (!candidates.includes(id)) candidates.push(id);
      }
    }
    return { model: spec.model, candidates, viaAlias, explicit: spec.provider, mode: 'pinned' };
  }

  const serving = await servingAny(spec.model, { ids: scope, force });
  if (!serving.length) {
    const rows = await Promise.all(
      scope.map(async (id) => ({ id, models: await modelsOfAny(id, { force }) })),
    );
    const sample = rows
      .filter((r) => r.models.length)
      .map((r) => `${r.id}（${r.models.slice(0, 3).map((m) => m.id).join('、')}${r.models.length > 3 ? '…' : ''}）`)
      .join('；');
    throw new RouteError(
      `没有可用的供应商提供模型 "${spec.model}"`,
      404,
      'not_found_error',
      {
        hint: sample
          ? `当前目录：${sample}`
          : '所有上游都没在跑，先 node router.mjs up；免费供应商要先 node router.mjs providers key <id>',
        model: spec.model,
      },
    );
  }
  return { model: spec.model, candidates: serving, viaAlias, explicit: null, mode: 'auto' };
}
