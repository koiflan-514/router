import { Toaster as Sonner } from 'sonner';

/** 全局通知容器（sonner）。 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{ classNames: { toast: 'text-sm' } }}
    />
  );
}
