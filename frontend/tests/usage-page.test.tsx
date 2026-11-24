import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import usageFixture from '../fixtures/usage.json';
import { usageStatsSchema } from '@/lib/contract';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useUsage: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ range: '7d' }),
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock('@/lib/query', () => ({
  useUsage: mocks.useUsage,
}));

vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Passthrough,
    AreaChart: Passthrough,
    PieChart: Passthrough,
    Pie: Passthrough,
    Cell: () => null,
    Area: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

import { UsagePage } from '@/features/usage/UsagePage';

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

describe('UsagePage 冒烟', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染 KPI、Token 构成、工具可靠性与模型表', () => {
    mocks.useUsage.mockReturnValue(res(usageStatsSchema.parse(usageFixture.data)));
    render(<UsagePage />);
    expect(screen.getByRole('heading', { name: '用量' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeEnabled();
    expect(screen.getAllByText('Token 构成').length).toBeGreaterThan(0);
    expect(screen.getByText('工具可靠性')).toBeInTheDocument();
    expect(screen.getByText('模型 / Provider')).toBeInTheDocument();
    expect(screen.getByText('glm-5.3-flash')).toBeInTheDocument();
  });

  it('空数据给明确空状态而不是 0 曲线', () => {
    mocks.useUsage.mockReturnValue(res(usageStatsSchema.parse({})));
    render(<UsagePage />);
    expect(screen.getByText('该时间范围内没有用量数据')).toBeInTheDocument();
  });
});