import { describe, expect, it } from 'vitest';
import { gatewayProviderSnapSchema } from '@/lib/contract';
import { comboSchema, gatewayStatusEnvelope, gatewayUsageSchema, type GatewayUsage } from '@/lib/schemas';
import {
  comboReadiness,
  comboSteps,
  cooldownKindLabel,
  cooldownState,
  gatewayDayPoints,
  gatewayModelRows,
  gatewayProviderRows,
  gatewayTotals,
  schedulerLanes,
} from '@/features/gateway/gateway-model';

function sampleUsage(): GatewayUsage {
  return gatewayUsageSchema.parse({
    days: 7,
    requests: 100,
    errors: 5,
    inputTokens: 1200,
    outputTokens: 300,
    byDay: [
      { day: '2026-11-12', requests: 30, errors: 0, inputTokens: 400, outputTokens: 100, avgDurationMs: 200 },
      { day: '2026-11-11', requests: 10, errors: 2, inputTokens: 100, outputTokens: 20, avgDurationMs: 100 },
      { requests: 1 },
    ],
    byProvider: [
      { provider: 'trae-local', requests: 60, errors: 1, inputTokens: 800, outputTokens: 200 },
      { provider: 'zcode', requests: 40, errors: 4, inputTokens: 400, outputTokens: 100 },
    ],
    byModel: [
      { model: 'glm-5.3', requests: 70, errors: 2, inputTokens: 900, outputTokens: 200 },
      { model: 'other', requests: 30, errors: 3, inputTokens: 300, outputTokens: 100 },
    ],
  });
}

describe('gateway-model 聚合', () => {
  it('按天排序、计算错误率并过滤空日期', () => {
    const points = gatewayDayPoints(sampleUsage());
    expect(points.map((p) => p.day)).toEqual(['2026-11-11', '2026-11-12']);
    expect(points[0].errorRate).toBeCloseTo(0.2, 6);
    expect(points[1].label).toBe('11-12');
    expect(points[1].errorRate).toBe(0);
  });

  it('provider / model Top 按请求降序，占比以总量为分母', () => {
    const usage = sampleUsage();
    const providers = gatewayProviderRows(usage);
    expect(providers.map((p) => p.label)).toEqual(['trae-local', 'zcode']);
    expect(providers[0].share).toBeCloseTo(0.6, 6);
    const models = gatewayModelRows(usage);
    expect(models[0].label).toBe('glm-5.3');
    expect(models[0].share).toBeCloseTo(0.7, 6);
  });

  it('平均耗时按请求数加权，请求为 0 时错误率为 null', () => {
    const totals = gatewayTotals(sampleUsage());
    expect(totals.avgDurationMs).toBeCloseTo((200 * 30 + 100 * 10) / 40, 6);
    expect(totals.errorRate).toBeCloseTo(0.05, 6);
    const empty = gatewayTotals(gatewayUsageSchema.parse({ requests: 0, errors: 0 }));
    expect(empty.errorRate).toBeNull();
    expect(empty.avgDurationMs).toBeNull();
  });
});

describe('gateway-model 调度 lane', () => {
  const now = 1_700_000_000_000;
  const p1 = gatewayProviderSnapSchema.parse({
    id: 'trae-local',
    running: true,
    weight: 10,
    inFlight: 2,
    successRate: 0.99,
    cooldownUntil: now + 60_000,
    cooldownKind: 'rate_limit',
    sticky: 2,
  });
  const p2 = gatewayProviderSnapSchema.parse({
    id: 'zcode',
    running: true,
    weight: 5,
    inFlight: 1,
    successRate: 0.5,
    cooldownUntil: now - 1,
  });
  const p3 = gatewayProviderSnapSchema.parse({ id: 'off', running: false, weight: 0 });

  it('冷却中优先于运行状态，权重/负载按本批最大值归一', () => {
    const lanes = schedulerLanes([p1, p2, p3], now);
    expect(lanes[0]).toMatchObject({ id: 'trae-local', status: 'cooling', weightPct: 100, loadPct: 100 });
    expect(lanes[0].cooldown.kind).toBe('rate_limit');
    expect(lanes[1].cooldown.active).toBe(false);
    expect(lanes[1].status).toBe('busy');
    expect(lanes[2].status).toBe('stopped');
    expect(lanes[2].weightPct).toBe(0);
  });

  it('冷却缺失或过期时不显示倒计时', () => {
    expect(cooldownState(p2, now).active).toBe(false);
    expect(cooldownState(p3, now).iso).toBeNull();
    expect(cooldownKindLabel('upstream_5xx')).toBe('上游 5xx');
    expect(cooldownKindLabel('mystery')).toBe('mystery');
    expect(cooldownKindLabel(null)).toBe('未知原因');
  });
});

describe('gateway-model 降级链', () => {
  const now = 1_700_000_000_000;
  const providers = [
    gatewayProviderSnapSchema.parse({ id: 'trae-local', running: true }),
    gatewayProviderSnapSchema.parse({ id: 'zcode', running: false }),
    gatewayProviderSnapSchema.parse({
      id: 'codearts',
      running: true,
      cooldownUntil: now + 30_000,
      cooldownKind: 'billing',
    }),
  ];
  const combo = comboSchema.parse({
    name: 'fast',
    models: ['trae-local/glm-5.3-flash', 'zcode/glm-5.3', 'codearts/gpt-5.1', 'bare-model'],
    strategy: 'fallback',
  });

  it('逐环标注就绪 / 离线 / 冷却 / 未知', () => {
    const steps = comboSteps(combo, providers, now);
    expect(steps.map((s) => s.status)).toEqual(['ready', 'offline', 'cooldown', 'unknown']);
    expect(steps[2].cooldownKind).toBe('billing');
    expect(steps[3].provider).toBeNull();
    expect(steps[3].model).toBe('bare-model');
  });

  it('整体可用性按已知成员汇总，全未知不谎称可用', () => {
    const steps = comboSteps(combo, providers, now);
    expect(comboReadiness(steps)).toMatchObject({ ready: 1, total: 4, status: 'partial' });
    const unknown = comboSchema.parse({ name: 'u', models: ['nope/model'] });
    expect(comboReadiness(comboSteps(unknown, providers, now)).status).toBe('unknown');
    expect(comboReadiness([]).status).toBe('down');
  });
});