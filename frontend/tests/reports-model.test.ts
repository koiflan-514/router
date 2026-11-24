import { describe, expect, it } from 'vitest';
import usageFixture from '../fixtures/usage.json';
import quotaFixture from '../fixtures/quota.json';
import providersFixture from '../fixtures/providers.json';
import gatewayStatusFixture from '../fixtures/gateway-status.json';
import { providerStatusSchema, quotaRowSchema, usageStatsSchema } from '@/lib/contract';
import { gatewayStatusEnvelope, gatewayUsageSchema } from '@/lib/schemas';
import {
  buildReportModel,
  csvEscape,
  reportCsv,
  reportJson,
  type ReportSourceStatus,
} from '@/features/reports/reports-model';

const NOW = Date.parse('2026-11-12T04:00:00.000Z');

function sources(overrides: Partial<Record<ReportSourceStatus['key'], ReportSourceStatus['state']>> = {}) {
  return [
    { key: 'usage', label: 'OpenCode 用量', state: overrides.usage ?? 'ok' },
    { key: 'quota', label: '额度', state: overrides.quota ?? 'ok' },
    { key: 'providers', label: 'Provider 状态', state: overrides.providers ?? 'ok' },
    { key: 'gatewayUsage', label: '网关用量', state: overrides.gatewayUsage ?? 'ok' },
    { key: 'gatewayStatus', label: '网关调度', state: overrides.gatewayStatus ?? 'ok' },
  ] satisfies ReportSourceStatus[];
}

function fixtureModel() {
  const usage = usageStatsSchema.parse(usageFixture.data);
  const quotaRows = quotaRowSchema.array().parse(quotaFixture.data.providers);
  const providers = providerStatusSchema.array().parse(providersFixture.data);
  const gatewayStatus = gatewayStatusEnvelope.parse(gatewayStatusFixture.data);
  const gatewayUsage = gatewayUsageSchema.parse({
    days: 7,
    requests: 192,
    errors: 3,
    inputTokens: 612200,
    outputTokens: 149200,
    byDay: [
      { day: '2026-11-11', requests: 128, errors: 3, inputTokens: 411200, outputTokens: 98200, avgDurationMs: 1840 },
      { day: '2026-11-12', requests: 64, errors: 0, inputTokens: 201000, outputTokens: 51000, avgDurationMs: 1610 },
    ],
    byProvider: [
      { provider: 'trae-local', requests: 120, errors: 1, inputTokens: 370000, outputTokens: 90000 },
      { provider: 'qoder-cn', requests: 72, errors: 2, inputTokens: 242200, outputTokens: 59200 },
    ],
    byModel: [{ model: 'glm-5.3-flash', requests: 192, errors: 3, inputTokens: 612200, outputTokens: 149200 }],
  });
  return buildReportModel({
    range: '7d',
    usage,
    quotaRows,
    providers,
    gatewayUsage,
    gatewayStatus,
    gatewayDays: 7,
    sources: sources(),
    now: NOW,
  });
}

describe('reports-model 派生', () => {
  it('汇总 OpenCode 口径、网关请求与额度覆盖，不互相相加', () => {
    const model = fixtureModel();
    expect(model.generatedAt).toBe('2026-11-12T04:00:00.000Z');
    expect(model.rangeLabel).toBe('近 7 天');
    expect(model.usage.sessions).toBe(12);
    expect(model.usage.steps).toBe(320);
    expect(model.usage.tokens.composition).toBe(411200 + 98200 + 5400);
    expect(model.usage.tools?.rate).toBeCloseTo(200 / 210, 6);
    expect(model.gateway.totals.requests).toBe(192);
    expect(model.gateway.totals.errorRate).toBeCloseTo(3 / 192, 6);
    expect(model.quota.coverage).toEqual({ available: 3, total: 4, ratio: 0.75 });
    expect(model.quota.workbuddyDays[0]).toMatchObject({ provider: 'workbuddy', days: 29 });
  });

  it('provider / 模型排名与 steps 占比来自 models[]', () => {
    const model = fixtureModel();
    expect(model.usage.providerRows.map((row) => row.provider)).toEqual(['trae-local', 'zcode']);
    expect(model.usage.providerRows[0].steps).toBe(120);
    expect(model.usage.providerRows[0].share).toBeCloseTo(120 / 180, 6);
    expect(model.usage.topModel?.id).toBe('glm-5.3-flash');
    expect(model.usage.modelRows).toHaveLength(2);
  });

  it('结论只在有数据时生成，并标明口径', () => {
    const model = fixtureModel();
    const text = model.conclusions.map((c) => c.text).join('\n');
    expect(text).toContain('12 个会话');
    expect(text).toContain('最忙模型');
    expect(text).toContain('网关近 7 天转发 192 个请求');
    expect(text).toContain('额度覆盖 3/4');
    expect(text).toContain('凭证有效期剩余 29 天');
    expect(text).toContain('未提供按日 Token');
    expect(text).not.toContain('HTTP 请求数 320');
  });

  it('空数据只给一句明确空状态，不编造告警', () => {
    const model = buildReportModel({
      range: '7d',
      usage: null,
      quotaRows: [],
      providers: [],
      gatewayUsage: null,
      gatewayStatus: null,
      gatewayDays: 7,
      sources: sources({ usage: 'empty', quota: 'empty', providers: 'empty', gatewayUsage: 'empty', gatewayStatus: 'empty' }),
      now: NOW,
    });
    expect(model.conclusions).toHaveLength(1);
    expect(model.conclusions[0].text).toContain('没有足够数据');
    expect(model.quota.alerts).toEqual([]);
    expect(model.usage.providerRows).toEqual([]);
    expect(model.gateway.totals.requests).toBe(0);
  });

  it('数据源失败进入结论，而不是把缺失当 0', () => {
    const model = buildReportModel({
      range: '7d',
      usage: null,
      quotaRows: [],
      providers: [],
      gatewayUsage: null,
      gatewayStatus: null,
      gatewayDays: 7,
      sources: sources({ usage: 'error', quota: 'error' }),
      now: NOW,
    });
    expect(model.conclusions[0].tone).toBe('warning');
    expect(model.conclusions[0].text).toContain('OpenCode 用量、额度读取失败');
  });
});

describe('reports 导出', () => {
  it('CSV 含 BOM、明细 section 且正确转义', () => {
    const model = fixtureModel();
    const csv = reportCsv(model);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('section,name,provider');
    expect(csv).toContain('usage_daily,2026-11-11');
    expect(csv).toContain('usage_model,glm-5.3-flash');
    expect(csv).toContain('gateway_provider,trae-local');
    expect(csv).toContain('quota_bucket,workbuddy/credential');
    expect(csvEscape('a,"b"')).toBe('"a,""b"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
  });

  it('JSON 汇总可解析且含来源状态、结论与额度覆盖', () => {
    const model = fixtureModel();
    const parsed = JSON.parse(reportJson(model));
    expect(parsed.generatedAt).toBe('2026-11-12T04:00:00.000Z');
    expect(parsed.sources).toHaveLength(5);
    expect(parsed.quota.coverage.available).toBe(3);
    expect(parsed.usage.dailyTokensAvailable).toBe(false);
    expect(parsed.gateway.totals.requests).toBe(192);
    expect(parsed.conclusions.length).toBeGreaterThan(0);
  });
});