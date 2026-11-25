import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProviderTable } from '@/features/overview/ProviderTable';
import { OverviewAside } from '@/features/overview/OverviewAside';
import type { QuotaPayload } from '@/lib/query';
import { providerStatusSchema, usageStatsSchema, type ProviderStatus } from '@/lib/contract';

/**
 * 总览页两处真实性问题的回归：
 * 1. 矩阵「进程·漂移」列在无漂移时不得渲染 `—`（「运行中 —」会被读成进程未知）；
 * 2. 右栏「近 7 天用量」必须区分失败 / 加载中 / 真实空态。
 *
 * jsdom 里没有 Router 上下文，`Link` 换成普通 `<a href>`（不影响被测文案）。
 */
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

function p(partial: Record<string, unknown>): ProviderStatus {
  return providerStatusSchema.parse({
    id: 'demo-provider',
    title: '演示来源',
    on: true,
    up: true,
    models: 3,
    port: 7863,
    pid: 1,
    oc: true,
    auth: { ok: true, state: 'valid', expiresAt: null, label: '' },
    drift: [],
    ...partial,
  });
}

function renderTable(list: ProviderStatus[]) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ProviderTable
        providers={list}
        quotaIndex={new Map()}
        sortKey="id"
        sortDir="asc"
        onSort={() => {}}
        onSelect={() => {}}
      />
    </TooltipProvider>,
  );
}

function renderAside(node: ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);
}

const baseAside = {
  providers: [p({})],
  quota: null as QuotaPayload | null,
  quotaError: false,
  onSelect: () => {},
};

describe('总览矩阵：进程·漂移列', () => {
  it('表头合并为「进程·漂移」，保留排序与 aria-sort', () => {
    renderTable([p({})]);
    const header = screen.getByRole('columnheader', { name: /进程·漂移/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    const button = screen.getByRole('button', { name: '进程·漂移' });
    expect(button).toHaveAttribute('title', '按进程状态排序；漂移徽标并入本列，明细见行详情');
  });

  it('无漂移的行只显示进程状态，不出现「运行中 —」', () => {
    const { container } = renderTable([p({ drift: [] })]);
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(container.textContent).not.toContain('运行中 —');
    // 无漂移也不渲染 DriftBadges 的「无状态漂移」占位。
    expect(screen.queryByRole('img', { name: '无状态漂移' })).not.toBeInTheDocument();
  });

  it('有漂移的行仍渲染徽标与 data-drift，多于 1 项给 +N', () => {
    const { container } = renderTable([
      p({ id: 'drifted', title: '漂移来源', on: true, up: false, drift: ['stopped', 'notSynced'] }),
    ]);
    expect(screen.getByText('已启用未运行')).toBeInTheDocument();
    expect(screen.getByText(/\+1/)).toBeInTheDocument();
    const cell = container.querySelector('[data-drift]');
    expect(cell?.getAttribute('data-drift')).toBe('stopped notSynced');
  });
});

describe('总览右栏：近 7 天用量的三种状态', () => {
  it('失败：显示「用量读取失败：<消息>」与重试链接，不显示「没有 activity」', () => {
    renderAside(
      <OverviewAside {...baseAside} usage={null} usageError="桥接返回 502" usageLoading={false} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-usage-state', 'error');
    expect(alert.textContent).toContain('用量读取失败：桥接返回 502');
    expect(screen.getByRole('link', { name: /去用量页重试/ })).toBeInTheDocument();
    expect(screen.queryByText(/没有 activity 序列/)).not.toBeInTheDocument();
  });

  it('加载中：显示「正在读取用量…」，不显示空态或报错', () => {
    renderAside(<OverviewAside {...baseAside} usage={null} usageError={null} usageLoading />);
    expect(screen.getByText('正在读取用量…')).toBeInTheDocument();
    expect(screen.queryByText(/没有 activity 序列/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('成功但无序列：保留空态文案', () => {
    renderAside(
      <OverviewAside
        {...baseAside}
        usage={usageStatsSchema.parse({ sessions: 0, activity: [] })}
        usageError={null}
        usageLoading={false}
      />,
    );
    expect(screen.getByText(/没有 activity 序列，不绘制趋势线。/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
