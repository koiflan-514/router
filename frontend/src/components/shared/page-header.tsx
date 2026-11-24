import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface BreadcrumbItem {
  label: ReactNode;
  /** 有 href 时渲染为链接；最后一节通常不给 href。 */
  href?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** 页面标题层级；同一页面只应有一个 h1，子区块可用 h2。 */
  as?: 'h1' | 'h2';
  /** 标题上方的小标签（模块/范围），用于 Fluent 的 "eyebrow" 层级。 */
  eyebrow?: ReactNode;
  /** 面包屑；最后一节如果与 title 重复可省略。 */
  breadcrumb?: BreadcrumbItem[];
  /** 密度；compact 收紧标题字号与间距。 */
  density?: 'compact' | 'comfortable';
}

export function PageHeader({
  title,
  description,
  actions,
  className,
  as: Heading = 'h1',
  eyebrow,
  breadcrumb,
  density = 'comfortable',
}: PageHeaderProps) {
  const compact = density === 'compact';
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        {breadcrumb?.length ? (
          <nav aria-label="面包屑">
            <ol className="flex flex-wrap items-center gap-1 text-[11px] text-text-tertiary">
              {breadcrumb.map((item, i) => (
                <li key={`${i}-${typeof item.label === 'string' ? item.label : i}`} className="inline-flex items-center gap-1">
                  {i > 0 ? <ChevronRight aria-hidden className="size-3 opacity-70" /> : null}
                  {item.href ? (
                    <a
                      href={item.href}
                      className="rounded-sm underline-offset-2 outline-none hover:text-text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {item.label}
                    </a>
                  ) : (
                    <span aria-current="page">{item.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : eyebrow ? (
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{eyebrow}</span>
        ) : null}
        <Heading
          className={cn(
            'font-display font-semibold leading-tight tracking-tight text-text-primary',
            compact ? 'text-ramp-16' : 'text-ramp-20',
          )}
        >
          {title}
        </Heading>
        {description ? (
          <p className="max-w-3xl text-[12px] leading-relaxed text-text-secondary">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
