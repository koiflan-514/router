/**
 * 降级链（combo）：一个模型名，其实是一条有序链。
 *
 * 移植自 dsh-our-free-model 的 `src/combos.js`（MIT）。要解决的故障一点都不罕见：
 * 一家上游的额度墙、区域拒绝、凭据过期或 5xx，在客户端看来都是「这轮死了」，
 * 而本机另外三家正闲着。combo 把它变成用户看不见的一次重试。
 *
 * 与「裸模型名自动选家」的区别（两者都保留，各有用途）：
 *
 *   裸模型名   → 所有能提供**同一个模型**的供应商里按权重挑
 *   combo      → 一条**用户命名**的链，可以跨不同模型、不同供应商，顺序由人定
 *
 * 关键规则，全部来自原实现：
 *   - 链上任意一环在**任何正文增量之前**失败，整段丢弃、换下一环，调用方不可见；
 *   - **思考增量不算正文** —— 「想了一分钟然后撞上配额墙」正是最该降级的场景；
 *   - 一旦已有正文增量交付，之后的失败按正常方式结束该回合（不能重放，否则用户
 *     会看到重复输出）；
 *   - 容量取**交集**而不是并集：链头支持视觉不代表链尾也支持，谎报能力会让降级
 *     的那一环收到它读不懂的图；
 *   - 全部环节当前都不可用的链**原样保留并标注不可用**，而不是静默消失——否则
 *     用户会以为配置丢了。
 */

import crypto from 'node:crypto';

export const COMBO_CHANNEL = 'combo';
export const COMBO_PREFIX = 'combo:';
export const COMBO_STRATEGIES = ['fallback', 'round-robin'];

/** 轮转游标，按 combo id 存。刻意放在内存里：重启丢掉只是换一个起点。 */
const rotation = new Map();

export function isComboEntry(entry) {
  return entry?.channel === COMBO_CHANNEL && Array.isArray(entry.combo);
}

/** `My Fast Chain` → `combo:my-fast-chain`。非拉丁名也会得到一个稳定的 URL 安全身份。 */
export function comboId(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (normalized === '') return '';
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const identity =
    slug && !/[^\x20-\x7e]/.test(normalized)
      ? slug
      : `${slug || 'u'}-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
  return `${COMBO_PREFIX}${identity}`;
}

/**
 * 把存下来的配置整形成合法的 combo 列表。
 *
 * 存下来的 combo 是经过一个 JSON 文件的用户输入，所以每个字段都当不可信：
 * 非数组的 models 变空（然后整条丢弃，因为没有环节的链是答不出的模型），
 * 非字符串的 id 丢掉，未知策略回退成 fallback 而不是照着一个笔误执行。
 */
export function normalizeCombos(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const id = typeof row.id === 'string' && row.id.startsWith(COMBO_PREFIX) ? row.id : comboId(name);
    if (!id || seen.has(id)) continue;
    const models = (Array.isArray(row.models) ? row.models : [])
      .filter((m) => typeof m === 'string' && m.trim() !== '')
      .map((m) => m.trim());
    if (!models.length) continue;
    const strategy = COMBO_STRATEGIES.includes(row.strategy) ? row.strategy : 'fallback';
    const stickyLimit = Number.isSafeInteger(row.stickyLimit) && row.stickyLimit > 0 ? row.stickyLimit : 3;
    seen.add(id);
    out.push({
      id,
      name: name || id.slice(COMBO_PREFIX.length),
      models,
      strategy,
      stickyLimit,
      disabled: row.disabled === true,
    });
  }
  return out;
}

/** 轮转起点：`fallback` 永远从链头开始，`round-robin` 每 stickyLimit 轮换一次。 */
export function chainFor(combo, turn = 0) {
  const models = Array.isArray(combo?.models) ? combo.models : [];
  if (!models.length) return [];
  if (combo.strategy !== 'round-robin') return models;
  const limit = Math.max(1, combo.stickyLimit || 1);
  const rounds = Math.floor(turn / limit);
  const offset = rounds % models.length;
  return [...models.slice(offset), ...models.slice(0, offset)];
}

/** 推进轮转游标（一个回合结束时调用）。 */
export function advanceTurn(comboId_) {
  const next = (rotation.get(comboId_) ?? 0) + 1;
  rotation.set(comboId_, next);
  return next;
}

export function currentTurn(comboId_) {
  return rotation.get(comboId_) ?? 0;
}

/** 重置游标（配置变更时调用，避免游标指向已删掉的环节）。 */
export function resetRotation(comboId_) {
  if (comboId_) rotation.delete(comboId_);
  else rotation.clear();
}

/**
 * 一条链的容量：取**交集**。
 *
 * 链头支持视觉不代表链尾支持；链头 1M 窗口不代表降级的那一环也是 1M。
 * 诚实的能力声明是每个环节都能兑现的那个。
 *
 * @param {Array<{supportsVision?:boolean, contextWindow?:number, supportsTools?:boolean}>} links
 */
export function chainCapacity(links) {
  const rows = links.filter(Boolean);
  if (!rows.length) return { supportsVision: false, contextWindow: null, supportsTools: false };
  return {
    // 只有每一环都支持才声明支持
    supportsVision: rows.every((l) => l.supportsVision === true),
    supportsTools: rows.every((l) => l.supportsTools === true),
    // 窗口取最小值；有一环未知就当未知（null），不要用已知的去冒充
    contextWindow: rows.every((l) => Number.isFinite(l.contextWindow))
      ? Math.min(...rows.map((l) => l.contextWindow))
      : null,
  };
}

/**
 * 一条链在**已经产出正文之后**还能不能继续降级。
 *
 * 不能。一旦有正文增量交付给客户端，重放会让用户看到重复输出。这条判断在
 * `dispatch` 里被使用：`delivered` 为 true 时不再换家，直接把当前错误如实上报。
 */
export function canFallbackAfter(delivered) {
  return delivered !== true;
}

/** 链在目录里的呈现：一条虚拟模型行。 */
export function comboCatalogRow(combo, capacity) {
  return {
    id: combo.id,
    object: 'model',
    created: 0,
    owned_by: COMBO_CHANNEL,
    name: combo.name,
    combo: combo.models,
    strategy: combo.strategy,
    context_length: capacity?.contextWindow ?? null,
    supports_vision: capacity?.supportsVision ?? false,
    supports_tools: capacity?.supportsTools ?? false,
  };
}
