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
  /** 按日 Token：只有 API 真的给出时才不是 null（activity 是宽松透传）。 */
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** 入 + 出 + 推；全未知时为 null。 */
  tokenTotal: number | null;
}

const DAILY_INPUT_KEYS = ['input', 'inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens', 'tokens.input'];
const DAILY_OUTPUT_KEYS = [
  'output',
  'outputTokens',
  'output_tokens',
  'completion_tokens',
  'completionTokens',
  'tokens.output',
];
const DAILY_REASONING_KEYS = [
  'reasoning',
  'reasoningTokens',
  'reasoning_tokens',
  'reasoning_output_tokens',
  'tokens.reasoning',
];
const DAILY_CACHE_READ_KEYS = [
  'cacheRead',
  'cache_read',
  'cacheReadTokens',
  'cache_read_tokens',
  'cached_tokens',
  'tokens.cache.read',
  'tokens.cache_read',
];
const DAILY_CACHE_WRITE_KEYS = [
  'cacheWrite',
  'cache_write',
  'cacheWriteTokens',
  'cache_write_tokens',
  'tokens.cache.write',
  'tokens.cache_write',
];

function readNumericPathLoose(value: unknown, path: string): number | null {
  const parts = path.split('.');
  let cur: unknown = value;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

function pickLoose(value: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = readNumericPathLoose(value, key);
    if (v !== null) return v;
  }
  return null;
}

export function activityPoints(data: UsageStats): ActivityPoint[] {
  return data.activity
    .filter((a): a is Record<string, unknown> & { date: string } => typeof a.date === 'string' && a.date.length > 0)
    .map((a) => {
      const input = pickLoose(a, DAILY_INPUT_KEYS);
      const output = pickLoose(a, DAILY_OUTPUT_KEYS);
      const reasoning = pickLoose(a, DAILY_REASONING_KEYS);
      const cacheRead = pickLoose(a, DAILY_CACHE_READ_KEYS);
      const cacheWrite = pickLoose(a, DAILY_CACHE_WRITE_KEYS);
      const hasTotal = input !== null || output !== null || reasoning !== null;
      return {
        date: a.date,
        label: a.date.length >= 10 ? a.date.slice(5) : a.date,
        steps: typeof a.steps === 'number' && Number.isFinite(a.steps) ? a.steps : 0,
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        tokenTotal: hasTotal ? (input ?? 0) + (output ?? 0) + (reasoning ?? 0) : null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** activity 是否带有按日 Token；没有时绝不画 Token 趋势（不把总量摊到每天）。 */
export function hasDailyTokens(data: UsageStats): boolean {
  return activityPoints(data).some(
    (p) =>
      (p.input ?? 0) > 0 ||
      (p.output ?? 0) > 0 ||
      (p.reasoning ?? 0) > 0 ||
      (p.cacheRead ?? 0) > 0 ||
      (p.cacheWrite ?? 0) > 0,
  );
}

/** x 轴刻度密度：短范围多刻度，all/30d 自动稀疏，避免标签挤在一起。 */
export function rangeTickGap(range: UsageRange): number {
  if (range === '24h') return 0;
  if (range === '7d') return 8;
  if (range === '30d') return 28;
  return 48;
}

/** activity[] 是否真的“有活动”：空数组、或所有点 steps 都为 0（无活动）时不画曲线。 */
export function hasActivity(data: UsageStats): boolean {
  return data.activity.some(
    (a) => typeof a.steps === 'number' && Number.isFinite(a.steps) && a.steps > 0,
  );
}


export interface TokenBreakdownItem {
  key: 'input' | 'output' | 'reasoning';
  label: string;
  value: number;
  /** 占 Token 构成（入+出+推）的比例；总量为 0 时为 0。 */
  ratio: number;
  colorVar: string;
}

/** Token 构成 = 输入 + 输出 + 推理；缓存读写单列，不并入。 */
export function tokenBreakdown(data: UsageStats): { total: number; items: TokenBreakdownItem[] } {
  const total = tokenComposition(data);
  const raw: Array<Omit<TokenBreakdownItem, 'ratio'>> = [
    { key: 'input', label: '输入', value: data.tokens.input, colorVar: 'var(--info)' },
    { key: 'output', label: '输出', value: data.tokens.output, colorVar: 'var(--success)' },
    { key: 'reasoning', label: '推理', value: data.tokens.reasoning, colorVar: 'var(--warning)' },
  ];
  return {
    total,
    items: raw.map((item) => ({
      ...item,
      ratio: total > 0 ? item.value / total : 0,
    })),
  };
}

export interface CacheEfficiency {
  read: number;
  write: number;
  /** 缓存读 / 输入 Token；输入为 0 或未知时 null。 */
  readRatio: number | null;
  writeRatio: number | null;
}

export function cacheEfficiency(data: UsageStats): CacheEfficiency | null {
  const read = data.tokens.cache?.read ?? 0;
  const write = data.tokens.cache?.write ?? 0;
  if (read <= 0 && write <= 0) return null;
  const input = data.tokens.input;
  return {
    read,
    write,
    readRatio: input > 0 ? read / input : null,
    writeRatio: input > 0 ? write / input : null,
  };
}

/** 倍数的展示位数：<10 给两位（2.56×），≥10 给一位（21.6×，与「两位有效数字」同精度），量级不丢。 */
function timesText(ratio: number): string {
  const value = ratio < 10 ? ratio.toFixed(2) : ratio.toFixed(1);
  return `${value.replace(/\.?0+$/, '')}×`;
}

/**
 * 缓存读/写相对「输入 Token」的展示文案（14 §4：缓存量与输入是**不同量级**的计数，
 * 不是构成比例）。
 *
 * 真实数据里缓存读取常常是输入的上千倍（`2,043,581,874 / 94,817,941 ≈ 2155%`），
 * 写成百分比虽然数学正确，却像错误值；因此：
 * - ratio > 1：倍数表达（`21.6× 输入`）；
 * - 0 < ratio ≤ 1：百分比（`32.0% 输入`）；
 * - ratio === 0：`0.0% 输入`（真的没有缓存命中，不是未知）；
 * - input = 0 / 未知（ratio === null）：`—`，不做除法、不编造比例。
 */
export function cacheRatioText(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  if (ratio > 1) return `${timesText(ratio)} 输入`;
  return `${(ratio * 100).toFixed(1)}% 输入`;
}

/** 导出 CSV：Token 汇总 + 每日活动 + 模型表。字段保留原始数值，不写格式化后的千分位。 */
export function usageCsv(data: UsageStats, models: ModelRow[] = data.models): string {
  const header = [
    'section',
    'date',
    'name',
    'provider',
    'steps',
    'input',
    'output',
    'reasoning',
    'cache_read',
    'cache_write',
    'cost',
  ];
  const rows: Array<Array<string | number | null>> = [header];
  const cacheRead = data.tokens.cache?.read ?? null;
  const cacheWrite = data.tokens.cache?.write ?? null;
  rows.push(['tokens', '', 'input', '', '', data.tokens.input, '', '', '', '', '']);
  rows.push(['tokens', '', 'output', '', '', '', data.tokens.output, '', '', '', '']);
  rows.push(['tokens', '', 'reasoning', '', '', '', '', data.tokens.reasoning, '', '', '']);
  rows.push(['tokens', '', 'cache_read', '', '', '', '', '', cacheRead, '', '']);
  rows.push(['tokens', '', 'cache_write', '', '', '', '', '', '', cacheWrite, '']);
  rows.push(['tokens', '', 'composition', '', '', data.tokens.input, data.tokens.output, data.tokens.reasoning, '', '', '']);
  for (const point of activityPoints(data)) {
    rows.push([
      'daily',
      point.date,
      '',
      '',
      point.steps,
      point.input,
      point.output,
      point.reasoning,
      point.cacheRead,
      point.cacheWrite,
      '',
    ]);
  }
  for (const row of models) {
    const d = toModelDetail(row);
    rows.push(['model', '', d.id, d.providerID, d.steps, d.input, d.output, d.reasoning, d.cacheRead, d.cacheWrite, d.cost]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  return `\uFEFF${csv}\n`;
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 单日数据量极小时仍给可读的 0 基线；极大值交给 Recharts + fmtCompact。 */
export function activityExtent(points: ActivityPoint[]): { min: number; max: number } {
  let max = 0;
  for (const p of points) {
    if (p.steps > max) max = p.steps;
    if ((p.tokenTotal ?? 0) > max) max = p.tokenTotal ?? 0;
  }
  return { min: 0, max };
}
