import { useState } from 'react';
import { toast } from 'sonner';
import type { ButtonProps } from '@/components/ui/button';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { actionCatalog, type ActionName } from '@/lib/contract';
import { useActions } from '@/lib/action-store';
import { ApiError } from '@/lib/api';

export interface ActionButtonProps extends Omit<ButtonProps, 'onClick'> {
  action: ActionName;
  providerIds?: string[];
  accountKey?: string;
  dryRun?: boolean;
  /** 影响对象的人类可读名称（高风险确认时列出）。 */
  affected?: string[];
  targetLabel?: string;
  details?: Array<{ label: string; value: string }>;
  onDone?: () => void;
}

/**
 * 写操作按钮：自带确认框、串行提交、进行中禁用。
 *
 * - 进行中的写任务（同 provider）会禁用按钮，避免连点重复执行。
 * - 完成/失败都刷新只读数据（由 ActionProvider 统一失效查询）。
 */
export function ActionButton({
  action,
  providerIds = [],
  accountKey,
  dryRun,
  affected,
  targetLabel,
  details,
  onDone,
  children,
  variant,
  size,
  disabled,
  ...rest
}: ActionButtonProps) {
  const { run, runningProviderIds, activeGlobal } = useActions();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const meta = actionCatalog[action];

  const hasRunningTarget = providerIds.some((p) => runningProviderIds.has(p));
  const blocked = activeGlobal || hasRunningTarget;
  const blockedReason = activeGlobal
    ? '有全局写任务正在进行，请等待完成'
    : hasRunningTarget
      ? '该 provider 有写任务正在进行'
      : undefined;

  async function handleConfirm() {
    setPending(true);
    try {
      const task = await run({ action, providerIds, accountKey, dryRun });
      toast.success(`${meta.label}已提交`, { description: `任务 ${task.actionId}` });
      setOpen(false);
      onDone?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`${meta.label}失败`, { description: msg });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant={variant ?? (meta.risk === 'high' ? 'outline' : 'secondary')}
        size={size ?? 'sm'}
        disabled={disabled || pending || blocked}
        title={blockedReason}
        onClick={() => setOpen(true)}
        {...rest}
      >
        {children ?? meta.label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`确认${meta.label}？`}
        description={meta.confirm}
        risk={meta.risk}
        affected={affected}
        pending={pending}
        confirmLabel={meta.label}
        details={[
          ...(targetLabel ? [{ label: '目标', value: targetLabel }] : []),
          ...(dryRun ? [{ label: '模式', value: '预览（dry-run，不写配置）' }] : []),
          ...(details ?? []),
        ]}
        onConfirm={handleConfirm}
      />
    </>
  );
}
