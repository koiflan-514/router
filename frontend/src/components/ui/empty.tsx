import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyProps extends ComponentProps<'div'> {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

/** 空状态：查询成功但没有数据时使用；不等于查询失败。 */
export function Empty({ icon, title, description, action, className, ...props }: EmptyProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div aria-hidden className="text-muted-foreground [&_svg]:size-6">
          {icon}
        </div>
      ) : null}
      <div className="text-sm font-medium">{title}</div>
      {description ? <div className="max-w-md text-xs text-muted-foreground">{description}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
