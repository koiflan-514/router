import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MetricCard } from '@/components/shared/metric-card';
import { LiveBadge } from '@/components/shared/live-badge';

afterEach(() => {
  cleanup();
});

describe('MetricCard（旧用法兼容）', () => {
  it('渲染 label / value / sub / hint，并以 label 作为可访问名', () => {
    render(<MetricCard label="会话" value="42" sub="子会话 3" hint="来源：OpenCode" />);
    const group = screen.getByRole('group', { name: '会话' });
    expect(group).toHaveTextContent('42');
    expect(screen.getByText('子会话 3')).toBeInTheDocument();
    expect(screen.getByText('来源：OpenCode')).toBeInTheDocument();
  });

  it('不传 spark/trend 时不渲染 trend 图标与描述', () => {
    const { container } = render(<MetricCard label="x" value="1" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[id]')).not.toBeNull(); // 只有 label 的 id
  });
});

describe('MetricCard（Fluent 增强）', () => {
  it('spark 数据足够时渲染 SVG 趋势', () => {
    const { container } = render(<MetricCard label="用量" value="10" spark={[1, 2, 3]} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('spark 少于 2 点时不渲染 SVG', () => {
    const { container } = render(<MetricCard label="用量" value="10" spark={[1]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('trend 上升显示 + 值与说明', () => {
    render(
      <MetricCard label="漂移" value="2" trend={{ value: 3, label: '较上一周期', intent: 'down-good' }} />,
    );
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('较上一周期')).toBeInTheDocument();
  });

  it('trend 下降使用负号 U+2212', () => {
    render(<MetricCard label="漂移" value="2" trend={{ value: -2 }} />);
    expect(screen.getByText('−2')).toBeInTheDocument();
  });

  it('trend percent 格式追加百分号', () => {
    render(<MetricCard label="x" value="1" trend={{ value: 12, format: 'percent' }} />);
    expect(screen.getByText('+12%')).toBeInTheDocument();
  });

  it('trend 为 0 时显示持平（无正负号）', () => {
    render(<MetricCard label="x" value="1" trend={{ value: 0 }} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('trend/spark 生成 sr-only 文本摘要，并挂到 aria-describedby', () => {
    render(
      <MetricCard label="用量" value="1" spark={[1, 2]} trend={{ value: 1 }} sparkLabel="近 7 天会话步骤" />,
    );
    const group = screen.getByRole('group', { name: '用量' });
    const descId = group.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    const desc = document.getElementById(descId!);
    expect(desc?.textContent).toContain('近 7 天会话步骤');
    expect(desc?.textContent).toContain('上升 1');
  });

  it('density=compact 收紧数值字号', () => {
    const { container } = render(<MetricCard label="x" value="1" density="compact" />);
    const num = container.querySelector('[data-density="compact"]');
    expect(num).toHaveTextContent('1');
    expect(num?.className).toContain('text-[20px]');
  });

  it('density 默认为 comfortable（28px ramp）', () => {
    const { container } = render(<MetricCard label="x" value="9" />);
    const num = container.querySelector('[data-density="comfortable"]');
    expect(num).toHaveTextContent('9');
    expect(num?.className).toContain('text-[28px]');
  });

  it('accessory 渲染在标题旁', () => {
    render(<MetricCard label="x" value="1" accessory={<span data-testid="acc">A</span>} />);
    expect(screen.getByTestId('acc')).toBeInTheDocument();
  });
});

describe('LiveBadge', () => {
  it('role=status，文本即状态；live 前缀不带圆点装饰以外的信息', () => {
    render(<LiveBadge label="网关可达" tone="live" kind="gateway" pulse />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-label', '网关可达');
    expect(el).toHaveTextContent('网关可达');
  });

  it('kind 提供默认文案', () => {
    render(<LiveBadge kind="readonly" tone="warning" />);
    expect(screen.getByRole('status')).toHaveTextContent('只读');
  });

  it('hint 映射到 title', () => {
    render(<LiveBadge label="演示" tone="info" hint="demo 模式：数据来自固定夹具" />);
    expect(screen.getByRole('status')).toHaveAttribute('title', 'demo 模式：数据来自固定夹具');
  });
});
