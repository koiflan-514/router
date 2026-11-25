import { StaleNotice } from '@/components/shared/states';
import { TimeText } from '@/components/shared/status';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/cn';

export interface DataSource {
  label: string;
  lastSuccessAt: string | null;
  stale: boolean;
  /**
   * 最近一次请求是否失败。失败且没有成功过时，`—` 会被读成「还没查」，
   * 因此改显「失败」——「未成功」与「从未查询」必须能区分开。
   */
  failed?: boolean;
  /** 失败原因，挂在 `title` 上（不展开长文案，避免撑高时间条）。 */
  error?: string | null;
}

/** 顶部数据时间条：逐源显示最近成功时间；有旧数据但刷新失败/超阈值时用 StaleNotice。 */
export function DataSourceBar({ sources, className }: { sources: DataSource[]; className?: string }) {
  const staleList = sources.filter((s) => s.stale);
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Card className="shadow-none">
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5 text-[11px] text-text-secondary">
          <span className="font-medium text-text-primary">数据时间</span>
          {sources.map((s) => (
            <span
              key={s.label}
              className="inline-flex items-center gap-1"
              data-source={s.label}
              data-source-state={s.failed ? 'error' : s.lastSuccessAt ? 'ok' : 'pending'}
            >
              <span>{s.label}</span>
              {s.failed && !s.lastSuccessAt ? (
                <span className="font-medium text-destructive" title={s.error ?? '读取失败'}>
                  失败
                </span>
              ) : (
                <TimeText iso={s.lastSuccessAt} className="tabular-nums text-text-primary" />
              )}
              {s.failed && s.lastSuccessAt ? (
                <span className="text-warning" title={s.error ?? '刷新失败'}>
                  （刷新失败）
                </span>
              ) : null}
            </span>
          ))}
        </CardContent>
      </Card>
      {staleList.map((s) => (
        <StaleNotice key={s.label} lastSuccessAt={s.lastSuccessAt} />
      ))}
    </div>
  );
}
