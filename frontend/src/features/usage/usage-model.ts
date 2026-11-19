import type { UsageRange, UsageStats } from '@/lib/contract';

/**
 * 用量页纯逻辑：范围解析、Token 字段读取、模型聚合行与排序。
 * 口径对齐 frontend/docs/14-usage-analytics.md §4/§5/§6；此处不渲染任何组件。
 */

export const DEFAULT_RANGE: UsageRange = '7d';

export const RANGE_OPTIONS: Array<{ value: UsageRange; label: string; short: string }> = [
  { value: '24h', label: '近 24 小时', short: '24h' },
  { value: '7d', label: '近 7 天', short: '7d' },
  { value: '30d', label: '近 30 天', short: '30d' },
  { value: 'all', label: '全部历史', short: '全部' },
];

export function parseRange(value: unknown): UsageRange {
  return isUsageRange(value) ? value : DEFAULT_RANGE;
}

/** URL 取值校验（用于“非法回退并提示一次”）。 */
export function isUsageRange(value: unknown): value is UsageRange {
  return value === '24h' || value === '7d' || value === '30d' || value === 'all';
}

export function rangeLabel(range: UsageRange): string {
  return RANGE_OPTIONS.find((o) => o.value === range)?.label ?? '近 7 天';
}

/** 模型行 token 的多种可能字段名（OpenCode 原样透传，未知键不猜测）。 */
const INPUT_KEYS = [
  'input',
  'inputTokens',
  'input_tokens',
  'prompt_tokens',
  'promptTokens',
];
const OUTPUT_KEYS = [
  'output',
  'outputTokens',
  'output_tokens',
  'completion_tokens',
  'completionTokens',
];
const REASONING_KEYS = [
  'reasoning',
  'reasoningTokens',
  'reasoning_tokens',
  'reasoning_output_tokens',
];
const CACHE_READ_KEYS = [
  'cache_read',
  'cacheRead',
  'cache_read_tokens',
  'cacheReadTokens',
  'cache_read_input_tokens',
  'cached_tokens',
  'cache.read',
  'cache.read_tokens',
];
const CACHE_WRITE_KEYS = [
  'cache_write',
  'cacheWrite',
  'cache_write_tokens',
  'cacheWriteTokens',
  'cache.write',
  'cache.write_tokens',
];

/** 支持 `a.b` 形式的嵌套别名读取；非有限数一律视为未知。 */
function readNumericPath(tokens: Record<string, number>, path: string): number | null {
  const parts = path.split('.');
  let cur: unknown = tokens;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

function pickToken(tokens: Record<string, number> | undefined, keys: string[]): number | null {
  if (!tokens) return null;
  for (const key of keys) {
    const v = readNumericPath(tokens, key);
    if (v !== null) return v;
  }
  return null;
}

export type ModelRow = UsageStats['models'][number];

export interface ModelDetail {
  /** `providerID/id`，可作为可分享的稳定键。 */
  key: string;
  id: string;
  providerID: string;
  steps: number;
  cost: number;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export function modelKey(row: ModelRow): string {
  return row.providerID ? `${row.providerID}/${row.id}` : row.id;
}

export function toModelDetail(row: ModelRow): ModelDetail {
  return {
    key: modelKey(row),
    id: row.id,
    providerID: row.providerID,
    steps: row.steps,
    cost: row.cost,
    input: pickToken(row.tokens, INPUT_KEYS),
    output: pickToken(row.tokens, OUTPUT_KEYS),
    reasoning: pickToken(row.tokens, REASONING_KEYS),
    cacheRead: pickToken(row.tokens, CACHE_READ_KEYS),
    cacheWrite: pickToken(row.tokens, CACHE_WRITE_KEYS),
  };
}

export interface ToolsSummary {
  calls: number;
  succeeded: number;
  failed: number;
  /** 未完成 = calls - succeeded - failed（不小于 0）。 */
  pending: number;
  /** 成功率，0–1。 */
  rate: number;
}

/** 工具统计：只有确有调用（calls > 0）时才算成功；否则视为无数据。 */
export function toolsSummary(data: UsageStats): ToolsSummary | null {
  const t = data.tools?.totals;
  if (!t || !Number.isFinite(t.calls) || t.calls <= 0) return null;
  const succeeded = t.succeeded;
  const failed = t.failed;
  return {
    calls: t.calls,
    succeeded,
    failed,
    pending: Math.max(0, t.calls - succeeded - failed),
    rate: succeeded / t.calls,
  };
}

/** Token 构成 = 输入 + 输出 + 推理；缓存读/写不计入。 */
export function tokenComposition(data: UsageStats): number {
  const t = data.tokens;
  return t.input + t.output + t.reasoning;
}

export type UsageSortKey =
  | 'model'
  | 'provider'
  | 'steps'
  | 'input'
  | 'output'
  | 'reasoning'
  | 'cacheRead'
  | 'cacheWrite'
  | 'cost';

export type SortDir = 'asc' | 'desc';

export interface UsageSort {
  key: UsageSortKey;
  dir: SortDir;
}

/** 默认按 steps 降序（对齐 14 §6.4）。 */
export const DEFAULT_SORT: UsageSort = { key: 'steps', dir: 'desc' };

const SORT_KEYS: UsageSortKey[] = [
  'model',
  'provider',
  'steps',
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
  'cost',
];

export function parseSort(sort: unknown, dir: unknown): UsageSort {
  const key = isSortKey(sort) ? sort : DEFAULT_SORT.key;
  const direction: SortDir = isSortDir(dir) ? dir : DEFAULT_SORT.dir;
  return { key, dir: direction };
}

export function isSortKey(value: unknown): value is UsageSortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}

export function isSortDir(value: unknown): value is SortDir {
  return value === 'asc' || value === 'desc';
}

function comparable(detail: ModelDetail, key: UsageSortKey): number | string {
  switch (key) {
    case 'model':
      return detail.id;
    case 'provider':
      return detail.providerID;
    case 'steps':
      return detail.steps;
    case 'cost':
      return detail.cost;
    case 'input':
      return detail.input ?? -1;
    case 'output':
      return detail.output ?? -1;
    case 'reasoning':
      return detail.reasoning ?? -1;
    case 'cacheRead':
      return detail.cacheRead ?? -1;
    case 'cacheWrite':
      return detail.cacheWrite ?? -1;
  }
}

export function sortModelRows(rows: ModelRow[], sort: UsageSort): ModelRow[] {
  const decorated = rows.map((row, index) => ({ row, index, detail: toModelDetail(row) }));
  decorated.sort((a, b) => {
    const va = comparable(a.detail, sort.key);
    const vb = comparable(b.detail, sort.key);
    let cmp: number;
    if (typeof va === 'string' || typeof vb === 'string') {
      cmp = String(va).localeCompare(String(vb), 'zh-CN');
    } else {
      cmp = va - vb;
    }
    if (cmp !== 0) return sort.dir === 'asc' ? cmp : -cmp;
    // 稳定兜底：同值按 key 升序（与排序方向无关），再按原始顺序，避免行抖动。
    return a.detail.key.localeCompare(b.detail.key) || a.index - b.index;
  });
  return decorated.map((d) => d.row);
}

/** 成功且无任何会话 / 模型 / 活动 = 该范围无数据。 */
export function isUsageEmpty(data: UsageStats): boolean {
  return data.sessions === 0 && data.models.length === 0 && data.activity.length === 0;
}

export interface ActivityPoint {
  date: string;
  /** x 轴短标签（MM-DD）。 */
  label: string;
  steps: number;
}

export function activityPoints(data: UsageStats): ActivityPoint[] {
  return data.activity
    .filter((a): a is { date: string; steps?: number } => typeof a.date === 'string' && a.date.length > 0)
    .map((a) => ({
      date: a.date,
      label: a.date.length >= 10 ? a.date.slice(5) : a.date,
      steps: typeof a.steps === 'number' && Number.isFinite(a.steps) ? a.steps : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** activity[] 是否真的“有活动”：空数组、或所有点 steps 都为 0（无活动）时不画曲线。 */
export function hasActivity(data: UsageStats): boolean {
  return data.activity.some(
    (a) => typeof a.steps === 'number' && Number.isFinite(a.steps) && a.steps > 0,
  );
}
