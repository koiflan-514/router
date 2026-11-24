import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

/** Fluent Drawer：Acrylic 材质 + 单侧描边 + shadow-flyout。 */
const sheetVariants = cva(
  'acrylic fixed z-50 flex flex-col gap-3 overflow-y-auto p-4 shadow-flyout outline-none transition ease-[cubic-bezier(0.2,0,0,1)]',
  {
    variants: {
      side: {
        right:
          'inset-y-0 right-0 h-full w-full max-w-md border-y-0 border-r-0 border-l [animation:sheet-in-right_.25s_cubic-bezier(0.2,0,0,1)]',
        left:
          'inset-y-0 left-0 h-full w-full max-w-xs border-y-0 border-l-0 border-r [animation:sheet-in-left_.25s_cubic-bezier(0.2,0,0,1)]',
        bottom:
          'inset-x-0 bottom-0 max-h-[85vh] border-x-0 border-b-0 border-t [animation:sheet-in-bottom_.25s_cubic-bezier(0.2,0,0,1)]',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export function SheetContent({
  className,
  children,
  side,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & VariantProps<typeof sheetVariants>) {
  // 与 DialogContent 相同：Radix 会把 SheetDescription 的 id 合并进 aria-describedby。
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-[color-mix(in_oklab,var(--text-primary)_28%,transparent)] backdrop-blur-[2px] [animation:panel-overlay-in_.15s_cubic-bezier(0.2,0,0,1)]" />
      <SheetPrimitive.Content className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        <SheetPrimitive.Close
          type="button"
          aria-label="关闭"
          className="absolute right-3 top-3 rounded-[4px] p-1 text-text-secondary outline-none transition-colors duration-150 hover:bg-accent-subtle hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X aria-hidden className="size-4" />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-6', className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      className={cn('font-display text-ramp-16 font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description className={cn('text-ramp-12 text-text-secondary', className)} {...props} />
  );
}
