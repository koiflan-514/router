import { quotaBucketSchema, type QuotaBucket, type QuotaRow } from '@/lib/contract';
import { DASH } from '@/lib/format';

/**
 * 额度页的呈现模型（只做归一化，不改契约语义）。
 *
 * 三层分组：provider → 账号（若有） → 额度桶。
 * - `days`（凭证天数）单独成桶，**不并入** credits 汇总（00 §7）。
 * - 未知一律 `—`；`0`、`null`、失败、未查询分别呈现。
 */

export interface QuotaAccountLayer {
  /** 稳定标识：优先 key，其次 uid。 */
  id: string;
  /** 脱敏展示名。 */
  label: string;
  /** 账号引用（可能为空）。 */
  account: string | null;
  available: boolean;
  reason?: string;
  detail?: string;
  error: string | null;
  buckets: QuotaBucket[];
}

export interface QuotaProviderLayer {
  provider: string;
  kind: string;
  title: string;
  available: boolean;
  reason?: string;
  detail?: string;
  error: string | null;
  serviceRunning?: boolean;
  fetchedAt: string | null;
  /** provider 级账号引用（无账号层时展示）。 */
  account: string | null;
  checkin?: QuotaRow['checkin'];
  /** 账号层；为空时直接展示 `buckets`。 */
  accounts: QuotaAccountLayer[];
  buckets: QuotaBucket[];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 逐条宽松解析额度桶；解析失败的条目跳过，不让整页失败。 */
export function parseBuckets(raw: unknown): QuotaBucket[] {
  if (!Array.isArray(raw)) return [];
  const out: QuotaBucket[] = [];
  for (const item of raw) {
    const parsed = quotaBucketSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function normalizeQuotaRow(row: QuotaRow): QuotaProviderLayer {
  const rawAccounts = Array.isArray(row.accounts) ? row.accounts : [];
  const accountLayers: QuotaAccountLayer[] = [];
  const extraBuckets: QuotaBucket[] = [];

  rawAccounts.forEach((entry, i) => {
    const e = entry as Record<string, unknown>;
    const inner = parseBuckets(e.buckets);
    const asBucket = quotaBucketSchema.safeParse(entry);
    // 误把额度桶放在 accounts[] 里：按桶处理，避免凭空造出账号层。
    if (!inner.length && asBucket.success) {
      extraBuckets.push(asBucket.data);
      return;
    }
    accountLayers.push({
      id: asString(e.key) ?? asString(e.uid) ?? asString(e.account) ?? `acct-${i}`,
      label: asString(e.name) ?? asString(e.account) ?? asString(e.key) ?? `账号 ${i + 1}`,
      account: asString(e.account) ?? asString(e.name),
      available: e.available === false ? false : true,
      reason: asString(e.reason) ?? undefined,
      detail: asString(e.detail) ?? undefined,
      error: asString(e.error),
      buckets: inner,
    });
  });

  return {
    provider: row.provider,
    kind: row.kind,
    title: row.title,
    available: row.available,
    reason: row.reason,
    detail: row.detail,
    error: row.error ?? null,
    serviceRunning: row.serviceRunning,
    fetchedAt: row.fetchedAt ?? null,
    account: asString(row.account),
    checkin: row.checkin,
    accounts: accountLayers,
    buckets: [...(row.buckets ?? []), ...extraBuckets],
  };
}

/** `days` 单位（凭证 / 续期天数）不画百分比条。 */
export function isDaysBucket(bucket: QuotaBucket): boolean {
  const unit = (bucket.unit ?? '').toLowerCase();
  return unit === 'days' || unit === 'day' || bucket.unit === '天';
}

export function isWorkBuddyProvider(provider: string, kind: string): boolean {
  return provider === 'workbuddy' || provider === 'workbuddy-global' || kind === 'workbuddy';
}

/** WorkBuddy 的桶用"凭证有效期 / 续期有效期"表述，不写成 credits。 */
export function workbuddyBucketLabel(bucket: QuotaBucket): string {
  if (bucket.label) return bucket.label;
  if (bucket.id === 'renewal') return '续期有效期';
  return '凭证有效期';
}

/**
 * 到期日：优先 `resetDate`；缺失时用「采集时间 + 剩余天数」推算（标注为推算）。
 * 返回 RFC3339 UTC 字符串或 null。
 */
export function bucketExpiryIso(bucket: QuotaBucket, baseIso: string | null | undefined): string | null {
  if (bucket.resetDate) return bucket.resetDate;
  const days = bucket.remaining;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return null;
  const base = baseIso ? Date.parse(baseIso) : NaN;
  if (!Number.isFinite(base)) return null;
  return new Date(base + days * 86_400_000).toISOString();
}

export function isDerivedExpiry(bucket: QuotaBucket): boolean {
  return !bucket.resetDate;
}

/** UTC 绝对时间（WorkBuddy 凭证到期展示用；避免把本地时间当 UTC）。 */
export function fmtUtcDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function bucketListOf(row: QuotaProviderLayer): QuotaBucket[] {
  return row.accounts.length ? row.accounts.flatMap((a) => a.buckets) : row.buckets;
}

export function rowHasIssue(row: QuotaProviderLayer): boolean {
  if (!row.available || row.error) return true;
  if (row.checkin?.supported && row.checkin.claimable) return true;
  return bucketListOf(row).some(
    (b) =>
      (typeof b.expiring === 'number' && b.expiring > 0) ||
      (!isDaysBucket(b) && b.remaining === 0),
  );
}

export interface QuotaSummary {
  /** 可查来源数（available=true）。 */
  sources: number;
  /** 来源总数（含不可用）。 */
  total: number;
  /** 需处理提醒（逐条文案）。 */
  alerts: string[];
}

export function summarizeQuota(rows: QuotaProviderLayer[]): QuotaSummary {
  const alerts: string[] = [];
  let sources = 0;
  for (const row of rows) {
    if (row.available) sources += 1;
    if (!row.available) {
      alerts.push(`${row.title} 不可用${row.reason ? `：${row.reason}` : ''}`);
    }
    if (row.error) alerts.push(`${row.title} 采集失败`);
    if (row.checkin?.supported && row.checkin.claimable) alerts.push(`${row.title} 有可领取签到`);
    const buckets = bucketListOf(row);
    if (buckets.some((b) => typeof b.expiring === 'number' && b.expiring > 0)) {
      alerts.push(`${row.title} 有即将过期额度`);
    }
    if (buckets.some((b) => !isDaysBucket(b) && b.remaining === 0)) {
      alerts.push(`${row.title} 额度已耗尽`);
    }
  }
  return { sources, total: rows.length, alerts };
}

/**
 * 数据来源标注（FR-129）：网关 balance / CLI 回退 / 混合。
 * 未知取值不谎称已知：保留原文并明确标为“未知来源”。
 */
export function sourceLabel(source: unknown): string {
  if (source === 'gateway-balance') return '网关 balance';
  if (source === 'cli-fallback' || source === 'cli') return 'CLI 回退';
  if (source === 'mixed') return '网关 balance + CLI 混合';
  if (typeof source === 'string' && source.trim()) return `未知来源（${source.trim()}）`;
  return DASH;
}

export interface BucketGauge {
  /** 0–100；总量缺失或剩余未知时为 null，绝不伪造进度。 */
  pct: number | null;
  remaining: number | null;
  total: number | null;
  used: number | null;
  unit: string;
  hasTotal: boolean;
  hasRemaining: boolean;
}

/** 额度桶的可视化数值。只有 total > 0 且 remaining 是有限数时才给 pct。 */
export function bucketGauge(bucket: QuotaBucket): BucketGauge {
  const total = typeof bucket.total === 'number' && Number.isFinite(bucket.total) ? bucket.total : null;
  const remaining =
    typeof bucket.remaining === 'number' && Number.isFinite(bucket.remaining) ? bucket.remaining : null;
  const hasTotal = total !== null && total > 0;
  const pct =
    hasTotal && remaining !== null ? Math.max(0, Math.min(100, (remaining / total) * 100)) : null;
  let used: number | null = null;
  if (typeof bucket.used === 'number' && Number.isFinite(bucket.used)) used = bucket.used;
  else if (hasTotal && remaining !== null) used = Math.max(0, total - remaining);
  return {
    pct,
    remaining,
    total,
    used,
    unit: bucket.unit || '',
    hasTotal,
    hasRemaining: remaining !== null,
  };
}

export type BucketStatus = 'days' | 'exhausted' | 'expiring' | 'low' | 'ok' | 'unknown';
export type QuotaRowStatus = 'unavailable' | 'error' | 'issue' | 'ok';

/** 单个桶的状态：天数桶单独；先判耗尽，再判即将过期，再判低余额。 */
export function bucketStatus(bucket: QuotaBucket): BucketStatus {
  if (isDaysBucket(bucket)) return 'days';
  const gauge = bucketGauge(bucket);
  if (gauge.remaining === 0) return 'exhausted';
  if (typeof bucket.expiring === 'number' && bucket.expiring > 0) return 'expiring';
  if (gauge.pct !== null && gauge.pct <= 20) return 'low';
  if (gauge.pct !== null) return 'ok';
  return 'unknown';
}

export function rowStatus(row: QuotaProviderLayer): QuotaRowStatus {
  if (!row.available) return 'unavailable';
  if (row.error) return 'error';
  if (rowHasIssue(row)) return 'issue';
  return 'ok';
}

const ROW_STATUS_RANK: Record<QuotaRowStatus, number> = {
  error: 4,
  unavailable: 3,
  issue: 2,
  ok: 1,
};

export function rowIssueCount(row: QuotaProviderLayer): number {
  let count = 0;
  if (!row.available) count += 1;
  if (row.error) count += 1;
  if (row.checkin?.supported && row.checkin.claimable) count += 1;
  for (const bucket of bucketListOf(row)) {
    const status = bucketStatus(bucket);
    if (status === 'exhausted' || status === 'expiring' || status === 'low') count += 1;
  }
  return count;
}

export type QuotaFilter = 'all' | 'available' | 'unavailable' | 'issue';

export function filterQuotaRows(rows: QuotaProviderLayer[], filter: QuotaFilter): QuotaProviderLayer[] {
  if (filter === 'all') return rows;
  if (filter === 'available') return rows.filter((row) => row.available);
  if (filter === 'unavailable') return rows.filter((row) => !row.available);
  return rows.filter(rowHasIssue);
}

export function countQuotaFilters(rows: QuotaProviderLayer[]): Record<QuotaFilter, number> {
  return {
    all: rows.length,
    available: rows.filter((row) => row.available).length,
    unavailable: rows.filter((row) => !row.available).length,
    issue: rows.filter(rowHasIssue).length,
  };
}

export type QuotaSortKey = 'severity' | 'title' | 'fetched';

export interface QuotaSort {
  key: QuotaSortKey;
  dir: SortDirLike;
}

type SortDirLike = 'asc' | 'desc';

export const DEFAULT_QUOTA_SORT: QuotaSort = { key: 'severity', dir: 'desc' };

function compareQuotaRow(a: QuotaProviderLayer, b: QuotaProviderLayer, key: QuotaSortKey): number {
  if (key === 'title') return a.title.localeCompare(b.title, 'zh-CN');
  if (key === 'fetched') {
    const ta = a.fetchedAt ? Date.parse(a.fetchedAt) : NaN;
    const tb = b.fetchedAt ? Date.parse(b.fetchedAt) : NaN;
    const va = Number.isFinite(ta) ? ta : -1;
    const vb = Number.isFinite(tb) ? tb : -1;
    return va - vb;
  }
  const ra = ROW_STATUS_RANK[rowStatus(a)];
  const rb = ROW_STATUS_RANK[rowStatus(b)];
  if (ra !== rb) return ra - rb;
  const ia = rowIssueCount(a);
  const ib = rowIssueCount(b);
  if (ia !== ib) return ia - ib;
  return a.title.localeCompare(b.title, 'zh-CN');
}

/** 稳定排序：同值时按 provider 名称兜底，避免行抖动。 */
export function sortQuotaRows(rows: QuotaProviderLayer[], sort: QuotaSort): QuotaProviderLayer[] {
  return [...rows].sort((a, b) => {
    const cmp = compareQuotaRow(a, b, sort.key);
    if (cmp !== 0) return sort.dir === 'asc' ? cmp : -cmp;
    return a.provider.localeCompare(b.provider) || a.title.localeCompare(b.title, 'zh-CN');
  });
}

export interface QuotaCoverage {
  available: number;
  total: number;
  /** available / total；total=0 时为 null（不是 0%）。 */
  ratio: number | null;
}

export function quotaCoverage(rows: QuotaProviderLayer[]): QuotaCoverage {
  const available = rows.filter((row) => row.available).length;
  return { available, total: rows.length, ratio: rows.length ? available / rows.length : null };
}

export function accountCount(row: QuotaProviderLayer): number {
  return row.accounts.length;
}

export function checkinBadge(checkin: QuotaRow['checkin']): {
  label: string;
  variant: 'success' | 'warning' | 'muted' | 'info';
} | null {
  if (!checkin) return null;
  if (checkin.supported && checkin.claimable) {
    const reward = typeof checkin.rewardCredits === 'number' ? ` +${checkin.rewardCredits}` : '';
    return { label: `签到可领${reward}`, variant: 'warning' };
  }
  if (checkin.supported && checkin.claimed) return { label: '今日已签到', variant: 'success' };
  if (checkin.supported) return { label: '签到不可领', variant: 'muted' };
  return { label: '不支持签到', variant: 'muted' };
}
