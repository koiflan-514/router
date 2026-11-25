import { describe, expect, it } from 'vitest';
import { quotaRowSchema } from '@/lib/contract';
import { quotaCoverageStats } from '@/features/overview/overview-model';

/**
 * 额度覆盖副标题的三态（数据真实性回归）。
 *
 * `/api/quota` 在真实模式首次约 24s 才返回，加载中曾把副标题写成
 * 「额度接口未返回来源」——用假结论描述真实状态。这里锁定：
 * 加载中 / 失败 / 成功但 0 行 三种情况文案互不相同，且数值字段不被伪造。
 */

function row(raw: Record<string, unknown>) {
  return quotaRowSchema.parse({ provider: 'x', title: 'X', ...raw });
}

describe('quotaCoverageStats 三态副标题', () => {
  it('加载中且无数据：显「正在读取额度…」，不谎称未返回来源，计数仍为 0', () => {
    const s = quotaCoverageStats(null, { loading: true });
    expect(s.sub).toBe('正在读取额度…');
    expect(s.sub).not.toContain('未返回来源');
    expect(s.total).toBe(0);
    expect(s.available).toBe(0);
    expect(s.unavailable).toBe(0);
    expect(s.errors).toBe(0);
  });

  it('失败且无数据：显「额度数据读取失败」', () => {
    const s = quotaCoverageStats(null, { error: true });
    expect(s.sub).toBe('额度数据读取失败');
    expect(s.available).toBe(0);
    expect(s.total).toBe(0);
  });

  it('成功但 0 行：保持「额度接口未返回来源」，available 仍为 0（不伪造）', () => {
    const s = quotaCoverageStats({ providers: [] });
    expect(s.sub).toBe('额度接口未返回来源');
    expect(s.available).toBe(0);
    expect(s.total).toBe(0);
    expect(s.unavailable).toBe(0);
    expect(s.errors).toBe(0);
  });

  it('有数据时仍按计数展示，loading/error 不覆盖已有数据', () => {
    const payload = {
      providers: [
        row({ provider: 'a', title: 'A' }),
        row({ provider: 'b', title: 'B', available: false }),
        row({ provider: 'c', title: 'C', error: '采集失败' }),
      ],
    };
    const plain = quotaCoverageStats(payload);
    expect(plain).toEqual({ available: 2, total: 3, unavailable: 1, errors: 1, sub: plain.sub });
    expect(plain.sub).toBe('可查 2 / 3 家 · 不可用 1 · 采集失败 1');
    // 成功后刷新失败（stale）：保留真实计数，不退化成报错。
    expect(quotaCoverageStats(payload, { error: true }).sub).toBe(plain.sub);
    expect(quotaCoverageStats(payload, { loading: true }).sub).toBe(plain.sub);
  });

  it('兼容旧调用：不传 opts 时行为不变', () => {
    expect(quotaCoverageStats(null).sub).toBe('额度接口未返回来源');
  });
});
