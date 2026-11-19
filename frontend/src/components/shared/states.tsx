import { Loader2, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { ResourceView } from '@/lib/contract';
import { fmtRelative } from '@/lib/format';

export function LoadingState({ label = '正在读取…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: { code: string; message: string; retryable: boolean } | null;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
    >
      <div className="flex items-center gap-2 font-medium text-destructive">
        <TriangleAlert aria-hidden className="size-4" />
        读取失败{error?.code ? `（${error.code}）` : ''}
      </div>
      <div className="text-muted-foreground">{error?.message ?? '未知错误'}</div>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

/** 旧数据还在、但最近刷新失败时的提示（不是错误，也不清空数据）。 */
export function StaleNotice({ lastSuccessAt }: { lastSuccessAt: string | null }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <TriangleAlert aria-hidden className="size-3.5" />
      数据已过期（最近成功：{fmtRelative(lastSuccessAt)}），显示的是上一份结果
    </div>
  );
}

export interface DataStateProps<T> {
  res: ResourceView<T>;
  children: (data: T) => ReactNode;
  onRetry?: () => void;
  loadingLabel?: string;
  /** 判定"查询成功但没有数据" */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
}

/** 统一处理 加载 / 失败 / 空 / stale 四种状态，再渲染真实内容。 */
export function DataState<T>({ res, children, onRetry, loadingLabel, isEmpty, empty }: DataStateProps<T>) {
  if (res.data === null) {
    if (res.error) return <ErrorState error={res.error} onRetry={onRetry} />;
    return <LoadingState label={loadingLabel} />;
  }
  if (isEmpty?.(res.data)) {
    return (
      <>
        {res.stale ? <StaleNotice lastSuccessAt={res.lastSuccessAt} /> : null}
        {empty ?? (
          <div role="status" className="p-6 text-sm text-muted-foreground">
            没有可展示的数据
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {res.stale ? (
        <div className="mb-3">
          <StaleNotice lastSuccessAt={res.lastSuccessAt} />
        </div>
      ) : null}
      {children(res.data)}
    </>
  );
}
