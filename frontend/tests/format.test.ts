import { describe, expect, it } from 'vitest';
import {
  DASH,
  fmtCompact,
  fmtCountdown,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtInt,
  fmtNumber,
  fmtPercent,
  fmtRelative,
  fmtUnit,
} from '../src/lib/format';

/** 固定参考时刻，避免依赖运行时的真实当前时间。 */
const NOW = Date.parse('2026-11-12T03:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('format: 未知值统一显示 —（00 §7）', () => {
  it('所有格式化函数对 null/undefined/非有限数回退 —', () => {
    expect(fmtInt(null)).toBe(DASH);
    expect(fmtInt(undefined)).toBe(DASH);
    expect(fmtInt(Number.NaN)).toBe(DASH);
    expect(fmtInt(Number.POSITIVE_INFINITY)).toBe(DASH);

    expect(fmtNumber(null)).toBe(DASH);
    expect(fmtNumber(undefined)).toBe(DASH);
    expect(fmtNumber(Number.NaN)).toBe(DASH);
    expect(fmtNumber(Number.NEGATIVE_INFINITY)).toBe(DASH);

    expect(fmtCompact(null)).toBe(DASH);
    expect(fmtCompact(undefined)).toBe(DASH);
    expect(fmtCompact(Number.NaN)).toBe(DASH);

    expect(fmtPercent(null)).toBe(DASH);
    expect(fmtPercent(undefined)).toBe(DASH);
    expect(fmtPercent(Number.NaN)).toBe(DASH);

    expect(fmtUnit(null, 'credits')).toBe(DASH);
    expect(fmtUnit(undefined, 'tokens')).toBe(DASH);
    expect(fmtUnit(Number.NaN, 'credits')).toBe(DASH);

    expect(fmtDuration(null)).toBe(DASH);
    expect(fmtDuration(undefined)).toBe(DASH);
    expect(fmtDuration(Number.NaN)).toBe(DASH);

    expect(fmtDateTime(null)).toBe(DASH);
    expect(fmtDateTime(undefined)).toBe(DASH);
    expect(fmtDateTime('')).toBe(DASH);
    expect(fmtDateTime('not-a-date')).toBe(DASH);

    expect(fmtRelative(null, NOW)).toBe(DASH);
    expect(fmtRelative(undefined, NOW)).toBe(DASH);
    expect(fmtRelative('', NOW)).toBe(DASH);
    expect(fmtRelative('not-a-date', NOW)).toBe(DASH);

    expect(fmtCountdown(null, NOW)).toBe(DASH);
    expect(fmtCountdown(undefined, NOW)).toBe(DASH);
    expect(fmtCountdown('', NOW)).toBe(DASH);
    expect(fmtCountdown('not-a-date', NOW)).toBe(DASH);
  });
});

describe('format: 真实 0 是有效值，不等于 —（00 §7）', () => {
  it('0 会显示为 0 而不是占位符', () => {
    expect(fmtInt(0)).toBe('0');
    expect(fmtNumber(0)).toBe('0');
    expect(fmtUnit(0, 'credits')).toBe('0 credits');
    expect(fmtPercent(0)).toBe('0%');
    expect(fmtDuration(0)).toBe('0 ms');
    expect(fmtCompact(0)).not.toBe(DASH);
  });

  it('0 与 null 是两种可区分状态', () => {
    expect(fmtInt(0)).not.toBe(fmtInt(null));
    expect(fmtNumber(0)).not.toBe(fmtNumber(null));
  });
});

describe('fmtInt / fmtNumber / fmtCompact', () => {
  it('整数按 zh-CN 分组，可负、可四舍五入', () => {
    expect(fmtInt(1234567)).toBe(new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(1234567));
    expect(fmtInt(-42)).toBe('-42');
    expect(fmtInt(12.7)).toBe('13');
  });

  it('小数默认最多两位', () => {
    expect(fmtNumber(1234.5678)).toBe('1,234.57');
    expect(fmtNumber(3.14159, 4)).toBe('3.1416');
  });

  it('大数缩写使用 compact 记法且不丢值', () => {
    const compact = (v: number) =>
      new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
    expect(fmtCompact(1200)).toBe(compact(1200));
    expect(fmtCompact(1200000)).toBe(compact(1200000));
  });
});

describe('fmtPercent / fmtUnit', () => {
  it('比率转百分比并可指定小数位', () => {
    expect(fmtPercent(0.5)).toBe('50%');
    expect(fmtPercent(0.5123)).toBe('51%');
    expect(fmtPercent(0.5123, 1)).toBe('51.2%');
    expect(fmtPercent(1)).toBe('100%');
  });

  it('单位可选，缺省单位时不追加空格', () => {
    expect(fmtUnit(5, 'tokens')).toBe('5 tokens');
    expect(fmtUnit(5, undefined)).toBe('5');
    expect(fmtUnit(5, '')).toBe('5');
  });
});

describe('fmtDateTime', () => {
  it('有效 ISO 使用本地时区格式化', () => {
    const t = Date.parse('2026-11-12T03:00:00.000Z');
    const expected = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(t);
    expect(fmtDateTime('2026-11-12T03:00:00.000Z')).toBe(expected);
    expect(fmtDateTime('2026-11-12T03:00:00.000Z')).not.toBe(DASH);
  });
});

describe('fmtRelative 边界', () => {
  it('未来时间显示绝对时间', () => {
    const future = iso(NOW + 5000);
    expect(fmtRelative(future, NOW)).toBe(fmtDateTime(future));
  });

  it('±1.5 秒内为“刚刚”', () => {
    expect(fmtRelative(iso(NOW - 500), NOW)).toBe('刚刚');
    expect(fmtRelative(iso(NOW - 1499), NOW)).toBe('刚刚');
  });

  it('秒/分/时/天逐级换算', () => {
    expect(fmtRelative(iso(NOW - 1500), NOW)).toBe('2 秒前');
    expect(fmtRelative(iso(NOW - 30_000), NOW)).toBe('30 秒前');
    expect(fmtRelative(iso(NOW - 5 * 60_000), NOW)).toBe('5 分钟前');
    expect(fmtRelative(iso(NOW - 3 * 3_600_000), NOW)).toBe('3 小时前');
    expect(fmtRelative(iso(NOW - 2 * 86_400_000), NOW)).toBe('2 天前');
    expect(fmtRelative(iso(NOW - 29 * 86_400_000), NOW)).toBe('29 天前');
  });

  it('满 30 天后回退为绝对日期', () => {
    const d30 = iso(NOW - 30 * 86_400_000);
    expect(fmtRelative(d30, NOW)).toBe(fmtDate(d30));
    const d40 = iso(NOW - 40 * 86_400_000);
    expect(fmtRelative(d40, NOW)).toBe(fmtDate(d40));
  });
});

describe('fmtDuration', () => {
  it('按毫秒/秒/分/时分级显示', () => {
    expect(fmtDuration(500)).toBe('500 ms');
    expect(fmtDuration(999)).toBe('999 ms');
    expect(fmtDuration(1000)).toBe('1.0 s');
    expect(fmtDuration(1500)).toBe('1.5 s');
    expect(fmtDuration(59_500)).toBe('59.5 s');
    expect(fmtDuration(60_000)).toBe('1 分 0 秒');
    expect(fmtDuration(90_000)).toBe('1 分 30 秒');
    expect(fmtDuration(3_600_000)).toBe('1 小时 0 分');
    expect(fmtDuration(3_660_000)).toBe('1 小时 1 分');
    expect(fmtDuration(7_200_000)).toBe('2 小时 0 分');
  });
});

describe('fmtCountdown', () => {
  it('过去或当前显示“已过期”', () => {
    expect(fmtCountdown(iso(NOW - 1000), NOW)).toBe('已过期');
    expect(fmtCountdown(iso(NOW), NOW)).toBe('已过期');
  });

  it('未来按秒/分/时/天分级', () => {
    expect(fmtCountdown(iso(NOW + 30_000), NOW)).toBe('30 秒');
    expect(fmtCountdown(iso(NOW + 59_000), NOW)).toBe('59 秒');
    expect(fmtCountdown(iso(NOW + 60_000), NOW)).toBe('1 分钟');
    expect(fmtCountdown(iso(NOW + 5 * 60_000), NOW)).toBe('5 分钟');
    expect(fmtCountdown(iso(NOW + 59 * 60_000), NOW)).toBe('59 分钟');
    expect(fmtCountdown(iso(NOW + 3_600_000), NOW)).toBe('1 小时');
    expect(fmtCountdown(iso(NOW + 47 * 3_600_000), NOW)).toBe('47 小时');
    expect(fmtCountdown(iso(NOW + 48 * 3_600_000), NOW)).toBe('2 天');
    expect(fmtCountdown(iso(NOW + 72 * 3_600_000), NOW)).toBe('3 天');
  });
});
