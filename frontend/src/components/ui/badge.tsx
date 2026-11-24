import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Fluent Badge（Pill）：低饱和底色 + 语义文字色，圆角 4px。
 * 状态色只作辅助，必须同时有文字（见 status.tsx）。
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent-rest text-primary-foreground',
        secondary: 'border-stroke-1 bg-surface-2 text-text-secondary',
        outline: 'border-stroke-2 bg-transparent text-text-primary',
        muted: 'border-stroke-1 bg-surface-2 text-text-tertiary',
        success: 'border-success/35 bg-success/12 text-success',
        warning: 'border-warning/40 bg-warning/14 text-warning',
        destructive: 'border-destructive/35 bg-destructive/12 text-destructive',
        info: 'border-info/35 bg-info/12 text-info',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
