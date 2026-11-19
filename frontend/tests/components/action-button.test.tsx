import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/lib/contract';
import { ActionButton } from '@/components/shared/action-button';
import { ApiError } from '@/lib/api';
import { toast } from 'sonner';

/**
 * ActionButton：写操作按钮。
 * 这里 mock 掉 `@/lib/action-store` 的 `useActions`，只验证组件自身职责：
 * 打开确认框、提交时把参数原样交给 run、运行中/全局写任务时禁用。
 */

const state = vi.hoisted(() => ({
  run: vi.fn(),
  runningProviderIds: new Set<string>(),
  activeGlobal: false,
}));

vi.mock('@/lib/action-store', () => ({
  useActions: () => ({
    run: state.run,
    runningProviderIds: state.runningProviderIds,
    activeGlobal: state.activeGlobal,
    tasks: [],
    busy: false,
    lastError: null,
    dismiss: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    actionId: 'act-1',
    action: 'Start',
    providerIds: ['p1'],
    accountKey: 'acct-1',
    startedAt: '2026-01-05T04:00:00Z',
    finishedAt: null,
    exitCode: null,
    status: 'queued',
    stdout: '',
    stderr: '',
    truncated: false,
    refreshStatus: 'pending',
    ...overrides,
  };
}

function renderButton(props: React.ComponentProps<typeof ActionButton>) {
  const user = userEvent.setup();
  render(<ActionButton {...props} />);
  return { user };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  state.run.mockReset();
  state.run.mockResolvedValue(makeTask());
  state.runningProviderIds = new Set<string>();
  state.activeGlobal = false;
});

describe('ActionButton', () => {
  it('点击按钮打开确认框并展示目标与 dry-run 模式', async () => {
    const { user } = renderButton({
      action: 'Start',
      providerIds: ['p1'],
      targetLabel: 'trae-local',
      dryRun: true,
    });

    await user.click(screen.getByRole('button', { name: '启动' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('确认启动？')).toBeInTheDocument();
    expect(within(dialog).getByText('启动该反代进程')).toBeInTheDocument();
    expect(within(dialog).getByText('trae-local')).toBeInTheDocument();
    expect(within(dialog).getByText('预览（dry-run，不写配置）')).toBeInTheDocument();
    expect(state.run).not.toHaveBeenCalled();
  });

  it('确认时以 action/providerIds/accountKey/dryRun 调用 run', async () => {
    const onDone = vi.fn();
    const { user } = renderButton({
      action: 'Start',
      providerIds: ['p1', 'p2'],
      accountKey: 'acct-1',
      dryRun: true,
      onDone,
    });

    await user.click(screen.getByRole('button', { name: '启动' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '启动' }));

    await waitFor(() =>
      expect(state.run).toHaveBeenCalledWith({
        action: 'Start',
        providerIds: ['p1', 'p2'],
        accountKey: 'acct-1',
        dryRun: true,
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('提交期间确认框按钮禁用并显示「执行中…」', async () => {
    let resolveRun: (t: Task) => void = () => {};
    state.run.mockReturnValue(
      new Promise<Task>((resolve) => {
        resolveRun = resolve;
      }),
    );
    const { user } = renderButton({ action: 'Start', providerIds: ['p1'] });

    await user.click(screen.getByRole('button', { name: '启动' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '启动' }));

    const pending = await within(dialog).findByRole('button', { name: '执行中…' });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();

    resolveRun(makeTask());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('runningProviderIds 含目标 provider 时按钮禁用', () => {
    state.runningProviderIds = new Set(['p1']);
    renderButton({ action: 'Start', providerIds: ['p1', 'p2'] });

    const button = screen.getByRole('button', { name: '启动' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', '该 provider 有写任务正在进行');
  });

  it('runningProviderIds 不含目标时不因他人任务禁用', () => {
    state.runningProviderIds = new Set(['other']);
    renderButton({ action: 'Start', providerIds: ['p1'] });
    expect(screen.getByRole('button', { name: '启动' })).toBeEnabled();
  });

  it('activeGlobal 时按钮禁用并给出全局任务原因', () => {
    state.activeGlobal = true;
    renderButton({ action: 'EnableAll', providerIds: ['p1'] });

    const button = screen.getByRole('button', { name: '全部启用' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', '有全局写任务正在进行，请等待完成');
  });

  it('disabled 属性生效（只读/无权限场景）', () => {
    renderButton({ action: 'Start', providerIds: ['p1'], disabled: true });
    expect(screen.getByRole('button', { name: '启动' })).toBeDisabled();
  });

  it('run 失败时保留确认框并显示失败提示', async () => {
    state.run.mockRejectedValue(
      new ApiError({
        code: 'READ_ONLY',
        message: '桥接拒绝写操作（403）',
        retryable: false,
        status: 403,
      }),
    );
    const { user } = renderButton({ action: 'Start', providerIds: ['p1'] });

    await user.click(screen.getByRole('button', { name: '启动' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '启动' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '启动' })).toBeEnabled();
  });
});