import { describe, expect, it } from 'vitest';
import { quotaRowSchema } from '@/lib/contract';
import {
  bucketGauge,
  bucketStatus,
  checkinBadge,
  countQuotaFilters,
  filterQuotaRows,
  isDaysBucket,
  isWorkBuddyProvider,
  normalizeQuotaRow,
  quotaCoverage,
  rowIssueCount,
  rowStatus,
  sortQuotaRows,
  summarizeQuota,
  workbuddyBucketLabel,
} from '@/features/quota/quota-model';

function layer(raw: Record<string, unknown>) {
  return normalizeQuotaRow(quotaRowSchema.parse({ provider: 'x', title: 'X', ...raw }));
}

describe('quota-model 归一化', () => {
  it('账号层与 provider 桶分开，误放的桶不会变成账号', () => {
    const row = layer({
      provider: 'qoder-cn',
      title: 'Qoder 国内版',
      buckets: [{ id: 'top', label: '总', remaining: 5, total: 10, unit: 'credits' }],
      accounts: [
        { key: 'acc-1', name: '账号一', account: 'u1', buckets: [{ id: 'a', label: 'A', remaining: 2, total: 4, unit: 'credits' }] },
        { id: 'orphan', label: '放错的桶', remaining: 1, total: 2, unit: 'credits' },
      ],
    });
    expect(row.accounts).toHaveLength(1);
    expect(row.accounts[0].label).toBe('账号一');
    expect(row.buckets.map((b) => b.id)).toEqual(['top', 'orphan']);
  });

  it('WorkBuddy days 桶单独识别，不并入 credits', () => {
    const bucket = quotaRowSchema.parse({
      provider: 'workbuddy',
      title: 'WorkBuddy',
      buckets: [{ id: 'credential', label: '', remaining: 29, unit: 'days' }],
    }).buckets?.[0];
    expect(bucket).toBeDefined();
    if (!bucket) return;
    expect(isDaysBucket(bucket)).toBe(true);
    expect(workbuddyBucketLabel(bucket)).toBe('凭证有效期');
    expect(isWorkBuddyProvider('workbuddy-global', '')).toBe(true);
  });
});

describe('quota-model 数值与状态', () => {
  it('缺失总量时不画假进度', () => {
    const bucket = quotaRowSchema.parse({
      provider: 'trae-local',
      title: 'Trae',
      buckets: [{ id: 'credits', label: '积分余额', remaining: 1200, total: null, unit: 'credits' }],
    }).buckets?.[0];
    if (!bucket) throw new Error('missing');
    const gauge = bucketGauge(bucket);
    expect(gauge.pct).toBeNull();
    expect(gauge.remaining).toBe(1200);
    expect(gauge.used).toBeNull();
    expect(bucketStatus(bucket)).toBe('unknown');
  });

  it('耗尽 / 即将过期 / 低余额分别有状态', () => {
    const exhausted = quotaRowSchema.parse({
      provider: 'p',
      title: 'P',
      buckets: [{ id: 'a', label: 'A', remaining: 0, total: 100, unit: 'credits' }],
    }).buckets?.[0];
    const expiring = quotaRowSchema.parse({
      provider: 'p',
      title: 'P',
      buckets: [{ id: 'b', label: 'B', remaining: 50, total: 100, unit: 'credits', expiring: 5 }],
    }).buckets?.[0];
    const low = quotaRowSchema.parse({
      provider: 'p',
      title: 'P',
      buckets: [{ id: 'c', label: 'C', remaining: 10, total: 100, unit: 'credits' }],
    }).buckets?.[0];
    if (!exhausted || !expiring || !low) throw new Error('missing');
    expect(bucketStatus(exhausted)).toBe('exhausted');
    expect(bucketStatus(expiring)).toBe('expiring');
    expect(bucketStatus(low)).toBe('low');
    expect(bucketGauge(low).pct).toBe(10);
  });

  it('行状态按不可用 > 采集失败 > 需处理 > 正常', () => {
    const unavailable = layer({ available: false });
    const failed = layer({ error: 'boom' });
    const issue = layer({
      buckets: [{ id: 'a', label: 'A', remaining: 0, total: 5, unit: 'credits' }],
    });
    const ok = layer({
      buckets: [{ id: 'a', label: 'A', remaining: 5, total: 5, unit: 'credits' }],
    });
    expect(rowStatus(unavailable)).toBe('unavailable');
    expect(rowStatus(failed)).toBe('error');
    expect(rowStatus(issue)).toBe('issue');
    expect(rowStatus(ok)).toBe('ok');
    expect(rowIssueCount(issue)).toBe(1);
  });
});

describe('quota-model 筛选、排序与汇总', () => {
  it('状态筛选与计数一致', () => {
    const rows = [
      layer({ provider: 'a', title: 'A', available: true }),
      layer({ provider: 'b', title: 'B', available: false }),
      layer({
        provider: 'c',
        title: 'C',
        available: true,
        buckets: [{ id: 'x', label: 'X', remaining: 0, total: 10, unit: 'credits' }],
      }),
    ];
    expect(countQuotaFilters(rows)).toEqual({ all: 3, available: 2, unavailable: 1, issue: 2 });
    expect(filterQuotaRows(rows, 'unavailable').map((r) => r.provider)).toEqual(['b']);
    expect(filterQuotaRows(rows, 'issue').map((r) => r.provider)).toEqual(['b', 'c']);
  });

  it('问题优先排序，同状态按名称兜底', () => {
    const rows = [
      layer({ provider: 'ok', title: 'A 正常', available: true }),
      layer({ provider: 'down', title: 'B 不可用', available: false }),
      layer({ provider: 'warn', title: 'C 耗尽', available: true, buckets: [{ id: 'x', label: 'X', remaining: 0, total: 1, unit: 'credits' }] }),
    ];
    const sorted = sortQuotaRows(rows, { key: 'severity', dir: 'desc' });
    expect(sorted.map((r) => r.provider)).toEqual(['down', 'warn', 'ok']);
  });

  it('汇总只给告警，不跨厂商求和', () => {
    const rows = [
      layer({ provider: 'a', title: 'A', available: false, reason: '无接口' }),
      layer({
        provider: 'b',
        title: 'B',
        available: true,
        checkin: { supported: true, claimable: true, rewardCredits: 100 },
        buckets: [{ id: 'x', label: 'X', remaining: 0, total: 1, unit: 'credits' }],
      }),
    ];
    const summary = summarizeQuota(rows);
    expect(summary.sources).toBe(1);
    expect(summary.total).toBe(2);
    expect(summary.alerts.some((a) => a.includes('A 不可用'))).toBe(true);
    expect(summary.alerts.some((a) => a.includes('B 有可领取签到'))).toBe(true);
    expect(summary.alerts.some((a) => a.includes('B 额度已耗尽'))).toBe(true);
    expect(quotaCoverage(rows)).toEqual({ available: 1, total: 2, ratio: 0.5 });
  });

  it('签到 badge 区分可领 / 已签 / 不支持', () => {
    expect(checkinBadge({ supported: true, claimable: true, rewardCredits: 50 })?.variant).toBe('warning');
    expect(checkinBadge({ supported: true, claimed: true })?.label).toBe('今日已签到');
    expect(checkinBadge({ supported: false })?.label).toBe('不支持签到');
    expect(checkinBadge(undefined)).toBeNull();
  });
});