import { describe, expect, it } from 'vitest';
import { usageStatsSchema } from '@/lib/contract';

/**
 * `toUsageStats` 的 models 归一化（真实数据覆盖）。
 *
 * 真实 `opencode` 的 session.stats 给出 `models: [{ model: { id, providerID, variant }, ... }]`，
 * 而前端契约要求扁平 `{ id, providerID, ... }`。桥接此前直接透传，导致真实模式下
 * `/api/usage` 判定 CONTRACT_INVALID。这里钉住两种形状都能通过契约。
 */

const RUNTIME = '../server/normalize.mjs';
const { toUsageStats } = (await import(RUNTIME)) as {
  toUsageStats: (raw: unknown, opts: { range: string; from: number; to: number }) => unknown;
};

const args = { range: '7d', from: 1_700_000_000_000, to: 1_700_600_000_000 };

describe('toUsageStats（models 形状）', () => {
  it('真实嵌套形状 model.{id,providerID,variant} 会被摊平并通过契约', () => {
    const raw = {
      sessions: 3,
      prompts: 4,
      steps: 100,
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 7, write: 0 } },
      activity: [{ date: '2026-11-24', steps: 100 }],
      models: [
        {
          model: { id: 'deepseek-v41-flash', providerID: 'dumate', variant: 'default' },
          steps: 60,
          tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 4, write: 0 } },
          cost: 0,
        },
        {
          model: { id: 'deepseek-v41-flash', providerID: 'dumate', variant: 'high' },
          steps: 40,
          tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 3, write: 0 } },
          cost: 0,
        },
      ],
    };
    const out = toUsageStats(raw, args);
    const parsed = usageStatsSchema.parse(out);

    // 同一 provider/model 的两个 variant 合并成一行，steps 与 tokens 相加。
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({ id: 'deepseek-v41-flash', providerID: 'dumate', steps: 100 });
    expect(parsed.models[0].tokens?.input).toBe(10);
    // 缓存读写摊平为数字键（契约是 record<string, number>）。
    expect(parsed.models[0].tokens?.cacheRead).toBe(7);
    expect(parsed.models[0].tokens?.cacheWrite).toBe(0);
  });

  it('扁平形状（样例/旧夹具）原样生效', () => {
    const raw = {
      sessions: 1,
      steps: 2,
      models: [{ id: 'glm-5.3-flash', providerID: 'trae-local', steps: 120, cost: 0.7 }],
    };
    const parsed = usageStatsSchema.parse(toUsageStats(raw, args));
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].id).toBe('glm-5.3-flash');
    expect(parsed.models[0].cost).toBe(0.7);
  });

  it('空 id 的模型行被丢弃，不编造占位模型', () => {
    const raw = {
      sessions: 0,
      steps: 0,
      models: [{ model: { providerID: 'x' }, steps: 5 }, { id: '', steps: 1 }],
    };
    const parsed = usageStatsSchema.parse(toUsageStats(raw, args));
    expect(parsed.models).toEqual([]);
  });

  it('数值字段非有限数时兜底为 0（不产生 NaN，契约不失败）', () => {
    const raw = { sessions: null, steps: undefined, tokens: { input: NaN }, models: null };
    const parsed = usageStatsSchema.parse(toUsageStats(raw, args));
    expect(parsed.sessions).toBe(0);
    expect(parsed.steps).toBe(0);
    expect(parsed.tokens.input).toBe(0);
    expect(parsed.models).toEqual([]);
    expect(Number.isFinite(parsed.subagents)).toBe(true);
  });
});
