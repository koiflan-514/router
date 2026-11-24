import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RingGauge } from '@/components/shared/charts';

/**
 * RingGauge：未知值不得画成 0%；环形 aria-hidden，数值摘要始终对读屏可读。
 */
afterEach(() => {
  cleanup();
});

describe('RingGauge', () => {
  it('显示四舍五入的百分比', () => {
    render(<RingGauge value={73.4} label="健康度" />);
    expect(screen.getByText('73%')).toBeInTheDocument();
  });

  it('值被夹在 0–100 之间', () => {
    const { rerender } = render(<RingGauge value={-20} label="健康度" />);
    expect(screen.getByText('0%')).toBeInTheDocument();
    rerender(<RingGauge value={180} label="健康度" />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('value=null 时不画弧线，显示 `—` 与「无法计算」', () => {
    const { container } = render(<RingGauge value={null} label="健康度" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/无法计算/)).toBeInTheDocument();
    // 只剩背景圆环一个 circle
    expect(container.querySelectorAll('circle')).toHaveLength(1);
  });

  it('SVG 对读屏隐藏，文本摘要带 label 前缀', () => {
    const { container } = render(<RingGauge value={50} label="健康度" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toContain('健康度：50%');
  });

  it('自定义 display 覆盖中心文本', () => {
    render(<RingGauge value={42} display="4/9" />);
    expect(screen.getByText('4/9')).toBeInTheDocument();
    // 中心可见文本被覆盖，但 sr-only 摘要仍保留真实百分比（读屏不失信息）。
    expect(screen.getByText('42%')).toHaveClass('sr-only');
  });

  it('渲染 caption', () => {
    render(<RingGauge value={10} caption="四项均值" />);
    expect(screen.getByText('四项均值')).toBeInTheDocument();
  });
});
