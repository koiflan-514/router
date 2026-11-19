import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

/**
 * ConfirmDialog：统一确认框。
 * 关键约束（见 docs/09-testing.md §2.2）：默认焦点在"取消"；高风险必须列出受影响名单；
 * pending 期间两个按钮都禁用，避免连点重复执行。
 */

afterEach(() => {
  cleanup();
});

function setup(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  const props = {
    open: true,
    onOpenChange,
    title: '确认启动？',
    description: '启动该反代进程',
    onConfirm,
    ...overrides,
  };
  render(<ConfirmDialog {...props} />);
  return { user, onOpenChange, onConfirm };
}

describe('ConfirmDialog', () => {
  it('打开后默认焦点在「取消」按钮', async () => {
    setup();
    const dialog = await screen.findByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  it('risk="high" 时渲染高风险徽标与受影响名单', async () => {
    setup({
      risk: 'high',
      affected: ['trae-local', 'qoder-cn', 'codearts'],
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('高风险')).toBeInTheDocument();
    expect(within(dialog).getByText('将影响以下 3 项：')).toBeInTheDocument();
    for (const id of ['trae-local', 'qoder-cn', 'codearts']) {
      expect(within(dialog).getByText(id)).toBeInTheDocument();
    }
  });

  it('risk 为 normal 时不渲染受影响名单', async () => {
    setup({ affected: ['trae-local'] });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/将影响以下/)).not.toBeInTheDocument();
  });

  it('details 以 label/value 渲染', async () => {
    setup({
      details: [
        { label: '目标', value: 'trae-local' },
        { label: '模式', value: '预览（dry-run，不写配置）' },
      ],
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('目标')).toBeInTheDocument();
    expect(within(dialog).getByText('trae-local')).toBeInTheDocument();
    expect(within(dialog).getByText('预览（dry-run，不写配置）')).toBeInTheDocument();
  });

  it('pending 时两个按钮都禁用，确认文案变为「执行中…」', async () => {
    setup({ pending: true });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    const confirm = within(dialog).getByRole('button', { name: '执行中…' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: '确认' })).not.toBeInTheDocument();
  });

  it('点「取消」回调 onOpenChange(false)，不触发 onConfirm', async () => {
    const { user, onOpenChange, onConfirm } = setup();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('点确认按钮触发 onConfirm', async () => {
    const { user, onConfirm } = setup({ confirmLabel: '启动' });
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '启动' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Esc 关闭时回调 onOpenChange(false)', async () => {
    const { user, onOpenChange } = setup();
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});