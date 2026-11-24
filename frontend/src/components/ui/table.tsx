import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * 表格。外层滚动容器可键盘聚焦（横向内容超出时可用方向键滚动），
 * 并提供可读的区域名；需要更精确的名称时传 `containerProps={{ 'aria-label': '…' }}`。
 *
 * Fluent 观感：表头用 surface-2 底槽 + secondary 文字，行分隔线为 stroke-1，
 * 悬停/选中只做 layer 变化（不整行高亮 accent 饱和色）。
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
        'relative w-full overflow-x-auto rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        containerClassName,
      )}
      {...restContainer}
    >
      <table className={cn('w-full caption-bottom border-collapse text-ramp-12', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      className={cn('[&_tr]:border-b [&_tr]:border-stroke-1 [&_tr:hover]:bg-transparent', className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<'tfoot'>) {
  return <tfoot className={cn('border-t border-stroke-1 bg-surface-2 font-medium', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'border-b border-stroke-1 transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-accent-subtle data-[selected=true]:bg-accent-selected',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-8 bg-surface-2 px-2.5 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-text-secondary whitespace-nowrap first:rounded-tl-lg last:rounded-tr-lg',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-2.5 py-1.5 align-middle', className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('mt-2 text-[11px] text-text-secondary', className)} {...props} />;
}
