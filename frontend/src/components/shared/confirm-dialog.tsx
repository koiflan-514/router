import { useId, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  details?: Array<{ label: string; value: ReactNode }>;
  /** 高风险操作必须列出受影响对象。 */
  affected?: string[];
  risk?: 'normal' | 'high';
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: () => void;
}

/** 统一确认框：默认焦点在"取消"，高风险时列出受影响名单。 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  details,
  affected,
  risk = 'normal',
  confirmLabel = '确认',
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const baseId = useId();
  const detailsId = `${baseId}-details`;
  const affectedId = `${baseId}-affected`;
  const hasDetails = Boolean(details?.length);
  // affected 为空时不渲染空框，也不进描述关联。
  const hasAffected = risk === 'high' && Boolean(affected?.length);
  // Radix 会把自身的 descriptionId 追加到这个值后面（去重），这里只负责关联详情/影响名单。
  const describedBy = [hasDetails ? detailsId : null, hasAffected ? affectedId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={describedBy || undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {title}
            {risk === 'high' ? <Badge variant="destructive">高风险</Badge> : null}
          </DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {hasDetails ? (
          <dl
            id={detailsId}
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs"
          >
            {details?.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="break-words">{d.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {hasAffected ? (
          <div id={affectedId} className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <div className="mb-1 font-medium text-destructive">
              将影响以下 {affected?.length ?? 0} 项：
            </div>
            <ul className="list-inside list-disc text-muted-foreground">
              {affected?.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <DialogFooter>
          {/* 默认焦点在取消：危险操作不能靠一个 Enter 绕过阅读 */}
          <Button variant="outline" autoFocus onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button
            variant={risk === 'high' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? '执行中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
