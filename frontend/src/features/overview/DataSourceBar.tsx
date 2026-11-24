import { StaleNotice } from '@/components/shared/states';
import { TimeText } from '@/components/shared/status';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/cn';

export interface DataSource {
  label: string;
  lastSuccessAt: string | null;
  stale: boolean;
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
            <span key={s.label} className="inline-flex items-center gap-1">
              <span>{s.label}</span>
              <TimeText iso={s.lastSuccessAt} className="tabular-nums text-text-primary" />
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
