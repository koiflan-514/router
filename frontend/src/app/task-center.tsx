import { useState } from 'react';
import { ChevronDown, ListTodo, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Empty } from '@/components/ui/empty';
import { LogView } from '@/components/shared/log-view';
import { useActions } from '@/lib/action-store';
import { actionCatalog, type Task } from '@/lib/contract';
import { fmtDuration, fmtRelative, fmtDateTime } from '@/lib/format';

const STATUS_META: Record<Task['status'], { text: string; variant: 'muted' | 'info' | 'success' | 'destructive' }> = {
  queued: { text: '排队中', variant: 'muted' },
  running: { text: '执行中', variant: 'info' },
  succeeded: { text: '成功', variant: 'success' },
  failed: { text: '失败', variant: 'destructive' },
  cancelled: { text: '已取消', variant: 'muted' },
};

const REFRESH_META: Record<Task['refreshStatus'], string> = {
  pending: '状态待确认',
  confirmed: '状态已确认',
  failed: '命令已完成，状态未确认',
  notRequired: '',
};

function TaskItem({ task, onDismiss }: { task: Task; onDismiss: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const status = STATUS_META[task.status];
  const duration =
    task.finishedAt && task.startedAt
      ? Date.parse(task.finishedAt) - Date.parse(task.startedAt)
      : Date.now() - Date.parse(task.startedAt);
  const output = [task.stdout, task.stderr].filter(Boolean).join('\n');
  return (
    <div className="rounded-md border border-border p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{actionCatalog[task.action]?.label ?? task.action}</span>
            <Badge variant={status.variant}>{status.text}</Badge>
            {task.refreshStatus === 'failed' ? (
              <Badge variant="warning">{REFRESH_META.failed}</Badge>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {task.providerIds.length ? task.providerIds.join('、') : '全局'} · {fmtRelative(task.startedAt)} ·{' '}
            {fmtDuration(duration)}
            {task.exitCode !== null && task.exitCode !== 0 ? ` · 退出码 ${task.exitCode}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {output ? (
            <Button variant="ghost" size="icon-sm" aria-label="查看输出" onClick={() => setOpen((v) => !v)}>
              <ChevronDown className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" aria-label="移除任务" onClick={() => onDismiss(task.actionId)}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{task.actionId}</div>
      {open && output ? (
        <div className="mt-2 max-h-64 overflow-auto rounded border border-border bg-muted/30">
          <LogView text={output} maxLines={400} />
        </div>
      ) : null}
    </div>
  );
}

export function TaskCenter() {
  const { tasks, dismiss } = useActions();
  const [open, setOpen] = useState(false);
  const activeCount = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <ListTodo className="size-4" />
          任务
          {activeCount ? <Badge variant="info">{activeCount}</Badge> : null}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full max-w-md">
        <SheetHeader>
          <SheetTitle>写操作任务</SheetTitle>
          <SheetDescription>
            写任务全局串行；完成后自动重新查询真实状态。"命令已完成，状态未确认"≠失败。
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-2 pr-1">
            {tasks.length === 0 ? (
              <Empty title="还没有任务" description="启停、切号、刷新模型等操作会出现在这里。" />
            ) : (
              tasks
                .slice()
                .reverse()
                .map((t) => <TaskItem key={t.actionId} task={t} onDismiss={dismiss} />)
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export { fmtDateTime };
