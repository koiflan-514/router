import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** Fluent 文本框：surface-2 底 + 1px stroke；聚焦时底部 accent 指示线 + focus rectangle。 */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full rounded-[4px] border border-stroke-2 bg-surface-2 px-2.5 py-1 text-ramp-14 text-text-primary outline-none transition-[border-color,background-color] duration-150 placeholder:text-text-tertiary',
        'hover:border-accent-rest/50 focus-visible:border-accent-rest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
