import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SectionHeader, Surface, Toolbar } from '@/components/shared/surface';

afterEach(() => {
  cleanup();
});

describe('Toolbar', () => {
  it('默认是 toolbar 角色且带默认可访问名', () => {
    render(<Toolbar>内容</Toolbar>);
    const el = screen.getByRole('toolbar');
    expect(el).toHaveAttribute('aria-label', '筛选与操作');
    expect(el).toHaveTextContent('内容');
  });

  it('可覆盖 aria-label', () => {
    render(<Toolbar aria-label="provider 筛选">x</Toolbar>);
    expect(screen.getByRole('toolbar')).toHaveAttribute('aria-label', 'provider 筛选');
  });

  it('trailing 渲染在右侧容器', () => {
    render(<Toolbar trailing={<span>共 9 条</span>}>前置</Toolbar>);
    const trailing = screen.getByText('共 9 条');
    expect(trailing.parentElement).toHaveClass('ml-auto');
  });
});

describe('Surface', () => {
  it('level=1 使用 layer-1 表面类', () => {
    const { container } = render(<Surface>卡片</Surface>);
    expect(container.firstElementChild).toHaveClass('layer-1');
  });

  it('level=2 使用 layer-2，acrylic 可叠加', () => {
    const { container } = render(
      <Surface level={2} acrylic>
        内嵌
      </Surface>,
    );
    expect(container.firstElementChild).toHaveClass('layer-2');
    expect(container.firstElementChild).toHaveClass('acrylic');
  });

  it('padding=none 不附加内边距类', () => {
    const { container } = render(<Surface padding="none">x</Surface>);
    expect(container.firstElementChild?.className).not.toContain('p-3');
  });
});

describe('SectionHeader', () => {
  it('默认渲染 h2 标题与说明', () => {
    render(<SectionHeader title="健康度" description="四项均值" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('健康度');
    expect(screen.getByText('四项均值')).toBeInTheDocument();
  });

  it('as 控制标题层级', () => {
    render(<SectionHeader as="h3" title="子区块" density="compact" />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('子区块');
  });

  it('actions 渲染在标题旁', () => {
    render(<SectionHeader title="额度 Top" actions={<a href="/quota">额度页</a>} />);
    expect(screen.getByRole('link', { name: '额度页' })).toBeInTheDocument();
  });
});
