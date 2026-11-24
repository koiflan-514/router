import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Surface / Layer：Fluent 表面。
 *
 * - `layer-1`：卡片级（surface-1 + 1px stroke + shadow-2），对应 Fluent Card。
 * - `layer-2`：内嵌块 / 工具条（surface-2，无阴影）。
 * - `acrylic`：浮层（半透明 + backdrop-filter）。
 */
export type SurfaceLevel = 1 | 2 | 3;

const LEVEL_CLASS: Record<SurfaceLevel, string> = {
  1: 'layer-1',
  2: 'layer-2',
  3: 'bg-surface-3 border border-stroke-1 shadow-8 rounded-xl',
};

export interface SurfaceProps extends ComponentProps<'div'> {
  level?: SurfaceLevel;
  /** 使用 Acrylic 材质（半透明 + 模糊），常用于抽屉/弹层内部容器。 */
  acrylic?: boolean;
  /** 内边距档位。 */
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const PAD_CLASS = {
  none: '',
  sm: 'p-2',
  md: 'p-3',
  lg: 'p-4',
} as const;

export function Surface({
  level = 1,
  acrylic = false,
  padding = 'md',
  className,
  ...props
}: SurfaceProps) {
  return (
    <div
      className={cn(LEVEL_CLASS[level], PAD_CLASS[padding], acrylic && 'acrylic', className)}
      {...props}
    />
  );
}

/** Layer 是 Surface 的轻量别名，便于在语义上区分「层」与「面」。 */
export function Layer({ level = 1, ...props }: SurfaceProps) {
  return <Surface level={level} padding="none" {...props} />;
}

export interface SectionHeaderProps extends Omit<ComponentProps<'div'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** 标题层级；区块默认 h2（页面本身有一个 h1）。 */
  as?: 'h2' | 'h3' | 'h4';
  actions?: ReactNode;
  icon?: ReactNode;
  density?: 'compact' | 'comfortable';
}

/** 区块标题：标题 + 说明 + 右侧操作，统一区块节奏。 */
export function SectionHeader({
  title,
  description,
  as: Heading = 'h2',
  actions,
  icon,
  density = 'comfortable',
  className,
  ...props
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-3',
        density === 'compact' ? 'gap-y-0.5' : 'gap-y-1',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <Heading
          className={cn(
            'flex items-center gap-2 font-semibold leading-tight',
            density === 'compact' ? 'text-ramp-14' : 'text-ramp-16',
          )}
        >
          {icon ? <span aria-hidden className="text-accent-rest [&_svg]:size-4">{icon}</span> : null}
          {title}
        </Heading>
        {description ? (
          <p className="text-[12px] text-text-secondary">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export interface ToolbarProps extends ComponentProps<'div'> {
  /** 右侧附加区域（计数、刷新等）。 */
  trailing?: ReactNode;
  /** 使用 layer-2 背景（默认 true）；无需背景时设 false。 */
  surface?: boolean;
}

/**
 * Toolbar：筛选/排序/操作条的流体容器。
 *
 * 采用 wrap + gap，窄屏自动折行；不固定高度，避免内容被截断。
 */
export function Toolbar({ trailing, surface = true, className, children, ...props }: ToolbarProps) {
  // 显式取值：避免 aria-label={undefined} 覆盖默认名，也避免 role 重复展开。
  const { role = 'toolbar', ['aria-label']: ariaLabel = '筛选与操作', ...rest } = props;
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg px-2 py-2',
        surface && 'layer-2',
        className,
      )}
      {...rest}
    >
      {children}
      {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
    </div>
  );
}
