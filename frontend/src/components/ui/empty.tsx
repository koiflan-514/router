import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyProps extends ComponentProps<'div'> {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 视觉尺寸：compact 用于卡片内的小空态。 */
  size?: 'compact' | 'default';
}

/**
 * Empty / EmptyState：查询成功但没有数据时使用；不等于查询失败。
 * 只用 1px 虚线描边，不加阴影（空态不该比内容更"响"）。
 */
export function Empty({ icon, title, description, action, className, size = 'default', ...props }: EmptyProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-stroke-2 bg-surface-2/40 text-center',
        size === 'compact' ? 'gap-1.5 px-4 py-6' : 'gap-2 px-6 py-10',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div aria-hidden className="text-text-tertiary [&_svg]:size-6">
          {icon}
        </div>
      ) : null}
      <div className="text-ramp-14 font-medium text-text-primary">{title}</div>
      {description ? (
        <div className="max-w-md text-ramp-12 leading-relaxed text-text-secondary">{description}</div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/**
 * EmptyState：Empty 的别名，名称与 Fluent 术语对齐，便于新代码引用。
 * 与 Empty 完全同构（同一实现，不复制样式）。
 */
export const EmptyState = Empty;
