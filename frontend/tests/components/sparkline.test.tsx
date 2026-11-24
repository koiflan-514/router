import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Sparkline } from '@/components/shared/charts';

/**
 * Sparkline：只画真实数据点；少于 2 点不画线（避免「看起来有趋势」的误导）。
 * 默认 decorative（aria-hidden），传 label 时暴露为 role="img"。
 */
afterEach(() => {
  cleanup();
});

function svg(container: HTMLElement) {
  return container.querySelector('svg');
}

describe('Sparkline', () => {
  it('>=2 个点时渲染 SVG 折线', () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5]} />);
    expect(svg(container)).not.toBeNull();
    const paths = container.querySelectorAll('path');
    // 面积 + 折线
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });

  it('默认对读屏隐藏（装饰）', () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} />);
    expect(svg(container)).toHaveAttribute('aria-hidden', 'true');
    expect(svg(container)).not.toHaveAttribute('role');
  });

  it('传 label 时暴露为 role="img" 且包含文本摘要', () => {
    const { container } = render(<Sparkline data={[1, 2, 4]} label="近 7 天步骤" />);
    const el = svg(container);
    expect(el).toHaveAttribute('role', 'img');
    expect(el?.getAttribute('aria-label')).toContain('近 7 天步骤');
  });

  it('description 覆盖默认摘要并出现在 aria-label 中', () => {
    const { container } = render(
      <Sparkline data={[2, 8]} label="用量" description="共 2 天，峰值 8" />,
    );
    expect(svg(container)?.getAttribute('aria-label')).toBe('用量：共 2 天，峰值 8');
  });

  it('<2 个点时不渲染 SVG，显示占位', () => {
    const { container } = render(<Sparkline data={[5]} />);
    expect(svg(container)).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('<2 个点且带说明时给出「数据不足」', () => {
    const { container } = render(<Sparkline data={[]} label="趋势" description="无数据点" />);
    expect(svg(container)).toBeNull();
    expect(container.textContent).toContain('数据不足');
  });

  it('过滤非有限数值（NaN/Infinity 不参与画线）', () => {
    const { container } = render(<Sparkline data={[1, Number.NaN, Infinity, 4]} />);
    expect(svg(container)).not.toBeNull();
  });

  it('dot=true 时高亮最后一个点', () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} dot />);
    expect(container.querySelector('circle')).not.toBeNull();
  });

  it('宽度/高度体现在 viewBox 上', () => {
    const { container } = render(<Sparkline data={[1, 2]} width={200} height={40} />);
    expect(svg(container)?.getAttribute('viewBox')).toBe('0 0 200 40');
  });
});
