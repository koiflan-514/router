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
