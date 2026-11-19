import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthBadge, DriftBadges, StatusDot } from '@/components/shared/status';
import type { AuthState, DriftKind } from '@/lib/contract';
import { DASH } from '@/lib/format';

/** 状态组件：状态不能只靠颜色，必须有可读文本（docs/09-testing.md §2.2）。 */

afterEach(() => {
  cleanup();
});

function renderWithTooltip(node: React.ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);
}

describe('AuthBadge：五种认证状态文案', () => {
  const cases: Array<[AuthState, string]> = [
    ['valid', '正常'],
    ['expiring', '即将到期'],
    ['expired', '已过期'],
    ['missing', '缺少凭证'],
    ['unknown', '未知'],
  ];

  it.each(cases)('state=%s 显示「%s」', (state, text) => {
    renderWithTooltip(
      <AuthBadge auth={{ ok: state === 'valid', state, expiresAt: null, label: '' }} />,
    );
    const badge = screen.getByText(text);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('aria-label', `认证：${text}`);
  });

  it('aria-label 带上 label 文本', () => {
    renderWithTooltip(
      <AuthBadge
        auth={{ ok: true, state: 'valid', expiresAt: null, label: 'example-user@example.test' }}
      />,
    );
    expect(screen.getByLabelText('认证：正常，example-user@example.test')).toBeInTheDocument();
  });
});

describe('DriftBadges：三种漂移文案', () => {
  const cases: Array<[DriftKind, string]> = [
    ['stopped', '已启用未运行'],
    ['notSynced', '未写入客户端'],
    ['stillRunning', '已关闭仍在运行'],
  ];

  it.each(cases)('drift=%s 显示「%s」', (kind, text) => {
    render(<DriftBadges drift={[kind]} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('多种漂移同时渲染', () => {
    render(<DriftBadges drift={['stopped', 'notSynced', 'stillRunning']} />);
    for (const [, text] of cases) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('无漂移时显示 `—` 而不是空白', () => {
    render(<DriftBadges drift={[]} />);
    expect(screen.getByText(DASH)).toBeInTheDocument();
  });
});

describe('StatusDot：运行状态文案', () => {
  it('up=true 显示运行中', () => {
    render(<StatusDot up />);
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('up=false 显示已停止', () => {
    render(<StatusDot up={false} />);
    expect(screen.getByText('已停止')).toBeInTheDocument();
  });

  it('传入 label 时优先显示 label', () => {
    render(<StatusDot up label="端口 7863" />);
    expect(screen.getByText('端口 7863')).toBeInTheDocument();
    expect(screen.queryByText('运行中')).not.toBeInTheDocument();
  });

  it('颜色圆点对读屏隐藏，状态只由文本表达', () => {
    const { container } = render(<StatusDot up />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});