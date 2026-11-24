import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Fluent Button。
 *
 * - default（accent）是唯一高强调按钮；其次 outline / secondary；
 * - hover 用 layer 变化（accent-hover 加深一档），不做高饱和发光；
 * - focus 用 Fluent focus rectangle（2px accent + 2px offset）。
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-ramp-14 font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-accent-rest text-primary-foreground shadow-2 hover:bg-accent-hover active:bg-accent-pressed',
        destructive:
          'bg-destructive text-destructive-foreground shadow-2 hover:opacity-90 active:opacity-100',
        outline:
          'border border-stroke-2 bg-transparent text-text-primary hover:bg-accent-subtle hover:border-stroke-2 active:bg-accent-selected',
        secondary:
          'border border-stroke-1 bg-surface-2 text-text-primary shadow-2 hover:bg-accent-subtle active:bg-accent-selected',
        ghost:
          'text-text-primary hover:bg-accent-subtle active:bg-accent-selected',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-[12px]',
        lg: 'h-10 rounded-lg px-6 text-ramp-14',
        icon: 'size-9',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
