import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { gatewayStatusEnvelope } from '@/lib/schemas';

/**
 * 调度快照的「成功率」必须是三态：有样本 → 百分比 + 进度条；
 * 无样本（successRate=0 且 lastUsedAt=0）→ `—` + 「尚无调用样本」，绝不能画成 0.0%。
 */

const mocks = vi.hoisted(() => ({
  useGatewayStatus: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock('@/lib/query', () => ({
  useGatewayStatus: mocks.useGatewayStatus,
}));

import { ActionProvider } from '@/lib/action-store';
import { SchedulerPage } from '@/features/gateway/SchedulerPage';

const NOW = Date.now();

/** ActionProvider 需要 QueryClient；写操作不参与本断言。 */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ActionProvider>
        <SchedulerPage />
      </ActionProvider>
    </QueryClientProvider>,
  );
}

function installProviders() {
  const data = gatewayStatusEnvelope.parse({
    ok: true,
    version: '1.0.0',
    pid: 1,
    uptimeSec: 60,
    providers: [
      // 有样本且健康
      { id: 'trae-local', running: true, successRate: 0.984, lastUsedAt: NOW - 60_000 },
      // 有样本但全失败：真的 0%，必须显示 0.0% 而不是「无样本」
      { id: 'qoder-cn', running: true, successRate: 0, lastUsedAt: NOW - 120_000 },
      // 从未被调用：无样本
      { id: 'zcode', running: true, weight: 7.5, successRate: 0, lastUsedAt: 0 },
    ],
  });
  mocks.useGatewayStatus.mockReturnValue({
    data,
    lastSuccessAt: null,
    error: null,
    stale: false,
    loading: false,
    refetch: vi.fn(),
  });
  return data;
}

/** 找到含有指定 provider chip 的卡片。 */
function laneCard(id: string): HTMLElement {
  const card = screen.getByTitle(new RegExp(`\\(${id}\\)`)).closest('[class*="rounded"]');
  if (!(card instanceof HTMLElement)) throw new Error(`找不到 ${id} 的 lane 卡片`);
  return card;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('调度快照成功率三态', () => {
  it('无样本 lane 显示 — 与「尚无调用样本」，不出现 0.0% 也不画进度条', () => {
    installProviders();
    renderPage();

    const card = laneCard('zcode');
    expect(card).toHaveTextContent('—');
    expect(card).toHaveTextContent('尚无调用样本');
    expect(card).not.toHaveTextContent('0.0%');
    expect(card).not.toHaveTextContent('成功率 0.0%');
    // 该卡片只剩权重 / 并发两个进度条，没有成功率进度条。
    expect(card.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(card.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toMatch(/^权重/);
    // 全页唯一可能出现的 0.0% 来自有样本的 qoder-cn 卡片，绝不在无样本卡片里。
    expect(laneCard('qoder-cn').querySelector('[role="progressbar"][aria-label="成功率 0.0%"]')).not.toBeNull();
    expect(card.querySelector('[role="progressbar"][aria-label="成功率 0.0%"]')).toBeNull();
    expect(card.querySelector('[aria-label="成功率 0.0%"]')).toBeNull();
  });

  it('有样本的 lane 保留百分比与进度条：全失败仍是 0.0%', () => {
    installProviders();
    renderPage();

    const trae = laneCard('trae-local');
    expect(trae).toHaveTextContent('98.4%');
    expect(trae).not.toHaveTextContent('尚无调用样本');

    const qoder = laneCard('qoder-cn');
    expect(qoder).toHaveTextContent('0.0%');
    expect(qoder).not.toHaveTextContent('尚无调用样本');
    expect(screen.getByRole('progressbar', { name: '成功率 0.0%' })).toBeInTheDocument();
  });

  it('无样本提示带解释性 title，避免被读成持续失败', () => {
    installProviders();
    renderPage();

    const dash = laneCard('zcode').querySelector('[title*="调用样本"]');
    expect(dash).not.toBeNull();
    expect(dash?.getAttribute('title')).toBe('网关未记录到该上游的调用样本；0% 并不代表持续失败');
  });
});
