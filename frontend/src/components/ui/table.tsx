import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * 表格。外层滚动容器可键盘聚焦（横向内容超出时可用方向键滚动），
 * 并提供可读的区域名；需要更精确的名称时传 `containerProps={{ 'aria-label': '…' }}`。
 */
export function Table({
  className,
  containerProps,
  ...props
}: ComponentProps<'table'> & { containerProps?: ComponentProps<'div'> }) {
  const {
    className: containerClassName,
    tabIndex = 0,
    role = 'region',
    'aria-label': ariaLabel,
    ...restContainer
  } = containerProps ?? {};

  return (
    <div
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel ?? '数据表格，可横向滚动'}
      className={cn(
        'relative w-full overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        containerClassName,
      )}
      {...restContainer}
    >
      <table className={cn('w-full caption-bottom text-[13px]', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('[&_tr]:border-b', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<'tfoot'>) {
  return <tfoot className={cn('border-t bg-muted/40 font-medium', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn('border-b border-border transition-colors hover:bg-muted/40', className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground whitespace-nowrap',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2 align-middle', className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('mt-2 text-xs text-muted-foreground', className)} {...props} />;
}