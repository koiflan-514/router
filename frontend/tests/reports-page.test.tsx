import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import usageFixture from '../fixtures/usage.json';
import quotaFixture from '../fixtures/quota.json';
import providersFixture from '../fixtures/providers.json';
import gatewayStatusFixture from '../fixtures/gateway-status.json';
import { providerStatusSchema, quotaRowSchema, usageStatsSchema } from '@/lib/contract';
import { gatewayUsageSchema } from '@/lib/schemas';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useUsage: vi.fn(),
  useQuota: vi.fn(),
  useProviders: vi.fn(),
  useGatewayUsage: vi.fn(),
  useGatewayStatus: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ range: '7d' }),
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock('@/lib/query', () => ({
  useUsage: mocks.useUsage,
  useQuota: mocks.useQuota,
  useProviders: mocks.useProviders,
  useGatewayUsage: mocks.useGatewayUsage,
  useGatewayStatus: mocks.useGatewayStatus,
}));

vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Passthrough,
    AreaChart: Passthrough,
    Area: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

import { ReportsPage } from '@/features/reports/ReportsPage';

function res<T>(data: T) {
  return {
    data,
    lastSuccessAt: '2026-11-12T03:00:00.000Z',
    error: null,
    stale: false,
    loading: false,
    refetch: vi.fn(),
  };
}

function installFixtures() {
  const usage = usageStatsSchema.parse(usageFixture.data);
  const providers = providerStatusSchema.array().parse(providersFixture.data);
  const quotaRows = quotaRowSchema.array().parse(quotaFixture.data.providers);
  mocks.useUsage.mockReturnValue(res(usage));
  mocks.useQuota.mockReturnValue(res({ fetchedAt: quotaFixture.data.fetchedAt, providers: quotaRows }));
  mocks.useProviders.mockReturnValue(res(providers));
  mocks.useGatewayUsage.mockReturnValue(
    res(
      gatewayUsageSchema.parse({
        days: 7,
        requests: 192,
        errors: 3,
        inputTokens: 612200,
        outputTokens: 149200,
        byDay: [
          { day: '2026-11-11', requests: 128, errors: 3, inputTokens: 411200, outputTokens: 98200 },
          { day: '2026-11-12', requests: 64, errors: 0, inputTokens: 201000, outputTokens: 51000 },
        ],
        byProvider: [{ provider: 'trae-local', requests: 192, errors: 3, inputTokens: 612200, outputTokens: 149200 }],
        byModel: [],
      }),
    ),
  );
  mocks.useGatewayStatus.mockReturnValue(res(gatewayStatusFixture.data));
}

describe('ReportsPage 冒烟', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    installFixtures();
  });

  it('渲染报告摘要、来源状态、KPI 与导出按钮', () => {
    render(<ReportsPage />);
    expect(screen.getByRole('heading', { name: '报表' })).toBeInTheDocument();
    expect(screen.getByText('报告摘要')).toBeInTheDocument();
    expect(screen.getByText('近 7 天')).toBeInTheDocument();
    expect(screen.getAllByText(/OpenCode 用量：正常/).length).toBeGreaterThan(0);
    expect(screen.getByText(/最忙模型/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /CSV 明细/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /JSON 汇总/ })).toBeEnabled();
    expect(screen.getByText('Provider 状态矩阵')).toBeInTheDocument();
    expect(screen.getByText('额度快照')).toBeInTheDocument();
  });

  it('切换时间范围写回 /reports?range', () => {
    render(<ReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const call = mocks.navigate.mock.calls[0][0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe('/reports');
    expect(call.search({ range: '7d' })).toMatchObject({ range: '30d' });
  });
});