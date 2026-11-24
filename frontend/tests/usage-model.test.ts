import { describe, expect, it } from 'vitest';
import { usageStatsSchema } from '@/lib/contract';
import {
  activityPoints,
  cacheEfficiency,
  hasDailyTokens,
  isUsageRange,
  modelKey,
  parseRange,
  parseSort,
  rangeTickGap,
  sortModelRows,
  tokenBreakdown,
  tokenComposition,
  toolsSummary,
  toModelDetail,
  usageCsv,
} from '@/features/usage/usage-model';

function sampleUsage() {
  return usageStatsSchema.parse({
    range: { from: 1762308000000, to: 1762912800000 },
    sessions: 12,
    subagents: 3,
    prompts: 48,
    steps: 320,
    tokens: {
      input: 411200,
      output: 98200,
      reasoning: 5400,
      cache: { read: 12000, write: 3000 },
    },
    cost: 1.8421,
    tools: { totals: { calls: 210, succeeded: 200, failed: 8 } },
    activeDays: 6,
    streak: 2,
    activity: [
      {
        date: '2026-11-11',
        steps: 80,
        tokens: { input: 1000, output: 200, reasoning: 30, cache: { read: 40, write: 10 } },
      },
      { date: '2026-11-10', steps: 64, input: 500, output: 100 },
    ],
    models: [
      {
        id: 'glm-5.3-flash',
        providerID: 'trae-local',
        steps: 120,
        tokens: {
          input: 150000,
          output: 40000,
          reasoning: 5000,
          'cache.read': 4000,
          cache_write: 1000,
        },
        cost: 0.7,
      },
      { id: 'glm-5.3,"quoted"', providerID: 'zcode', steps: 60, cost: 0.4 },
      { id: 'no-provider', providerID: '', steps: 140, cost: 0 },
    ],
  });
}

describe('usage-model 范围与排序', () => {
  it('范围默认回退 7d，并识别合法值', () => {
    expect(parseRange('all')).toBe('all');
    expect(parseRange('30d')).toBe('30d');
    expect(parseRange('90d')).toBe('7d');
    expect(parseRange(undefined)).toBe('7d');
    expect(isUsageRange('24h')).toBe(true);
    expect(isUsageRange('8d')).toBe(false);
    expect(parseSort('nope', 'up')).toEqual({ key: 'steps', dir: 'desc' });
  });

  it('x 轴密度随范围变化', () => {
    expect(rangeTickGap('24h')).toBe(0);
    expect(rangeTickGap('7d')).toBe(8);
    expect(rangeTickGap('30d')).toBe(28);
    expect(rangeTickGap('all')).toBeGreaterThan(rangeTickGap('30d'));
  });
});

describe('usage-model 按日活动与 Token', () => {
  it('activity 按日期升序，并按原字段读取按日 Token', () => {
    const points = activityPoints(sampleUsage());
    expect(points.map((p) => p.date)).toEqual(['2026-11-10', '2026-11-11']);
    expect(points[0]).toMatchObject({ label: '11-10', steps: 64, input: 500, output: 100 });
    expect(points[1].tokenTotal).toBe(1230);
    expect(points[1].cacheRead).toBe(40);
    expect(hasDailyTokens(sampleUsage())).toBe(true);
  });

  it('没有按日 Token 时不伪造趋势', () => {
    const data = usageStatsSchema.parse({
      steps: 3,
      activity: [{ date: '2026-11-10', steps: 3 }],
    });
    expect(hasDailyTokens(data)).toBe(false);
    expect(activityPoints(data)[0].tokenTotal).toBeNull();
  });

  it('Token 构成只含入/出/推，缓存读写另计', () => {
    const data = sampleUsage();
    expect(tokenComposition(data)).toBe(411200 + 98200 + 5400);
    const breakdown = tokenBreakdown(data);
    expect(breakdown.items.map((i) => i.key)).toEqual(['input', 'output', 'reasoning']);
    expect(breakdown.items.reduce((sum, item) => sum + item.ratio, 0)).toBeCloseTo(1, 6);
  });

  it('缓存效率以输入为分母，无缓存时返回 null', () => {
    const cache = cacheEfficiency(sampleUsage());
    expect(cache?.readRatio).toBeCloseTo(12000 / 411200, 8);
    expect(cache?.writeRatio).toBeCloseTo(3000 / 411200, 8);
    const noCache = usageStatsSchema.parse({ tokens: { input: 10 } });
    expect(cacheEfficiency(noCache)).toBeNull();
  });
});

describe('usage-model 工具与模型', () => {
  it('工具成功率不会把 calls=0 当成 100%', () => {
    expect(toolsSummary(sampleUsage())).toMatchObject({ calls: 210, succeeded: 200, failed: 8, pending: 2 });
    const empty = usageStatsSchema.parse({ tools: { totals: { calls: 0 } } });
    expect(toolsSummary(empty)).toBeNull();
  });

  it('模型键与详情读取别名，未知字段保持 null', () => {
    const data = sampleUsage();
    const detail = toModelDetail(data.models[0]);
    expect(modelKey(data.models[0])).toBe('trae-local/glm-5.3-flash');
    expect(detail.input).toBe(150000);
    expect(detail.cacheWrite).toBe(1000);
    expect(toModelDetail(data.models[1]).input).toBeNull();
  });

  it('排序稳定，null 数值排在后面', () => {
    const data = sampleUsage();
    const rows = sortModelRows(data.models, { key: 'input', dir: 'desc' });
    expect(rows[0].id).toBe('glm-5.3-flash');
    expect(rows.slice(1).every((row) => toModelDetail(row).input === null)).toBe(true);
  });
});

describe('usage CSV 导出', () => {
  it('含 BOM、三类 section，并正确转义引号与逗号', () => {
    const data = sampleUsage();
    const csv = usageCsv(data, sortModelRows(data.models, { key: 'steps', dir: 'desc' }));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('section,date,name,provider,steps');
    expect(csv).toContain('tokens,,composition');
    expect(csv).toContain('daily,2026-11-11');
    expect(csv).toContain('model,,glm-5.3-flash,trae-local');
    expect(csv).toContain('"glm-5.3,""quoted"""');
  });
});