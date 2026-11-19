import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderSelect } from '@/components/shared/provider-select';

/**
 * ProviderSelect：Provider 选择器（含"全部"）。
 * Radix Select 依赖 pointer capture / ResizeObserver 等浏览器 API，jsdom 未实现，
 * 这里在测试内补齐 polyfill 后再做真实交互断言（不降级）。
 *
 * 注意：触发器使用动态 aria-label（`选择 provider，当前：<label>`），选项文本后附
 * `sr-only` 的 `（id）`，因此按名称查询用正则匹配前缀。
 */

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.hasPointerCapture !== 'function') proto.hasPointerCapture = () => false;
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = () => {};
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = () => {};
  if (typeof proto.scrollIntoView !== 'function') proto.scrollIntoView = () => {};

  const g = globalThis as unknown as { ResizeObserver?: unknown };
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => {
  cleanup();
});

const PROVIDERS = [
  { id: 'trae-local', title: 'Trae' },
  { id: 'qoder-cn', title: 'Qoder 国内版' },
  { id: 'workbuddy', title: 'WorkBuddy 国内版', overlay: true },
];

describe('ProviderSelect', () => {
  it('触发器带可访问名称，默认显示「全部」', () => {
    render(<ProviderSelect providers={PROVIDERS} value={undefined} onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: '选择 provider，当前：全部' })).toBeInTheDocument();
    expect(screen.getByText('全部')).toBeInTheDocument();
  });

  it('已选具体 provider 时触发器名称反映当前值', () => {
    render(<ProviderSelect providers={PROVIDERS} value="trae-local" onChange={() => {}} />);
    expect(
      screen.getByRole('combobox', { name: '选择 provider，当前：Trae' }),
    ).toBeInTheDocument();
  });

  it('allowAll=false 且未选中时回退到通用名称', () => {
    render(
      <ProviderSelect
        providers={PROVIDERS}
        value={undefined}
        onChange={() => {}}
        allowAll={false}
      />,
    );
    expect(screen.getByRole('combobox', { name: '选择 provider' })).toBeInTheDocument();
  });

  it('展开后渲染「全部」与所有 provider 选项', async () => {
    const user = userEvent.setup();
    render(<ProviderSelect providers={PROVIDERS} value={undefined} onChange={() => {}} />);

    await user.click(screen.getByRole('combobox', { name: /选择 provider/ }));

    expect(await screen.findByRole('option', { name: '全部' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Trae/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Qoder 国内版/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /WorkBuddy 国内版/ })).toBeInTheDocument();
  });

  it('选项附带 sr-only 的 provider id，便于读屏区分同标题来源', async () => {
    const user = userEvent.setup();
    render(<ProviderSelect providers={PROVIDERS} value={undefined} onChange={() => {}} />);

    await user.click(screen.getByRole('combobox', { name: /选择 provider/ }));
    const option = await screen.findByRole('option', { name: /Qoder 国内版（qoder-cn）/ });
    expect(option).toBeInTheDocument();
  });

  it('allowAll=false 时不渲染「全部」', async () => {
    const user = userEvent.setup();
    render(
      <ProviderSelect
        providers={PROVIDERS}
        value={undefined}
        onChange={() => {}}
        allowAll={false}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: /选择 provider/ }));
    expect(await screen.findByRole('option', { name: /Trae/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '全部' })).not.toBeInTheDocument();
  });

  it('自定义 allLabel 生效', async () => {
    const user = userEvent.setup();
    render(
      <ProviderSelect
        providers={PROVIDERS}
        value={undefined}
        onChange={() => {}}
        allLabel="所有来源"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: /选择 provider/ }));
    expect(await screen.findByRole('option', { name: '所有来源' })).toBeInTheDocument();
  });

  it('选择具体 provider 时以 id 调用 onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ProviderSelect providers={PROVIDERS} value={undefined} onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: /选择 provider/ }));
    await user.click(await screen.findByRole('option', { name: /Qoder 国内版/ }));

    expect(onChange).toHaveBeenCalledWith('qoder-cn');
  });

  it('选择「全部」时回调 undefined（而不是哨兵字符串）', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ProviderSelect providers={PROVIDERS} value="trae-local" onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: /选择 provider/ }));
    await user.click(await screen.findByRole('option', { name: '全部' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('overlay 选项附带「叠加」标记', async () => {
    const user = userEvent.setup();
    render(<ProviderSelect providers={PROVIDERS} value={undefined} onChange={() => {}} />);

    await user.click(screen.getByRole('combobox', { name: /选择 provider/ }));
    const option = await screen.findByRole('option', { name: /WorkBuddy 国内版/ });
    expect(option).toHaveTextContent('叠加');
  });
});