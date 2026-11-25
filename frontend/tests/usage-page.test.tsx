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

  it('缓存读取超过输入 100% 时用倍数表达，绝对 token 数保留', () => {
    // 真实截图里的数字：读取 2,043,581,874 ≈ 输入 94,817,941 的 21.55 倍。
    mocks.useUsage.mockReturnValue(
      res(
        usageStatsSchema.parse({
          sessions: 19,
          steps: 17_402,
          tokens: {
            input: 94_817_941,
            output: 5_686_134,
            reasoning: 4_963_048,
            cache: { read: 2_043_581_874, write: 0 },
          },
        }),
      ),
    );
    render(<UsagePage />);
    // 比例文案不再出现 2155.3% 这种像错误值的百分比。
    expect(screen.queryByText(/2155/)).not.toBeInTheDocument();
    expect(screen.getAllByText('21.6× 输入').length).toBeGreaterThan(0);
    // 绝对数原样展示（不截断、不舍入成 0）。
    expect(screen.getAllByText('2,043,581,874').length).toBeGreaterThan(0);
    // 缓存写为 0 是真实值：显示 0.0%。
    expect(screen.getAllByText('0.0% 输入').length).toBeGreaterThan(0);
  });

  it('输入 Token 为 0 时缓存比例显示 —（不除零）', () => {
    mocks.useUsage.mockReturnValue(
      res(
        usageStatsSchema.parse({
          sessions: 1,
          steps: 2,
          tokens: { input: 0, cache: { read: 500, write: 20 } },
        }),
      ),
    );
    render(<UsagePage />);
    // 缓存卡片自身说明分母为 0；比例位是 DASH，不伪造 0% 或倍数。
    expect(screen.getAllByText(/输入 Token 为 0，无法计算比例/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/× 输入/)).not.toBeInTheDocument();
  });
});