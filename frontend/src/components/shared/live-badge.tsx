import { CircleCheck, Info, TriangleAlert, Wifi, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * LiveBadge：实时状态胶囊（网关可达 / 只读 / 演示 / 未知）。
 *
 * 状态不只用颜色表达：始终有图标 + 文本，`aria-label` 给出完整语义，
 * 圆点仅作装饰（aria-hidden）。
 */
export type LiveTone = 'live' | 'idle' | 'warning' | 'danger' | 'info';
export type LiveKind = 'gateway' | 'readonly' | 'demo' | 'unknown';

const KNOWN_LABEL: Record<LiveKind, ReactNode> = {
  gateway: '网关',
  readonly: '只读',
  demo: '演示',
  unknown: '未知',
};

const TONE_CLASS: Record<LiveTone, string> = {
  live: 'border-success/40 bg-success/12 text-success',
  idle: 'border-stroke-1 bg-surface-2 text-text-secondary',
  warning: 'border-warning/45 bg-warning/14 text-warning',
  danger: 'border-destructive/45 bg-destructive/12 text-destructive',
  info: 'border-info/40 bg-info/12 text-info',
};

const TONE_DOT: Record<LiveTone, string> = {
  live: 'bg-success',
  idle: 'bg-text-tertiary',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
};

export interface LiveBadgeProps {
  label?: ReactNode;
  tone?: LiveTone;
  /** 语义预设：决定默认图标；不影响 label。 */
  kind?: LiveKind;
  /** 悬浮补充说明（tooltip title）。 */
  hint?: string;
  /** 是否显示脉冲点（仅 tone=live 生效）。 */
  pulse?: boolean;
  className?: string;
  icon?: ReactNode;
}

function defaultIcon(kind: LiveKind | undefined, tone: LiveTone) {
  if (kind === 'gateway') return tone === 'live' ? <Wifi aria-hidden /> : <WifiOff aria-hidden />;
  if (kind === 'readonly') return <Info aria-hidden />;
  if (kind === 'demo') return <Info aria-hidden />;
  if (tone === 'live') return <CircleCheck aria-hidden />;
  if (tone === 'warning' || tone === 'danger') return <TriangleAlert aria-hidden />;
  return null;
}

export function LiveBadge({
  label,
  tone = 'idle',
  kind,
  hint,
  pulse = false,
  className,
  icon,
}: LiveBadgeProps) {
  const text = label ?? (kind ? KNOWN_LABEL[kind] : '');
  const glyph = icon ?? defaultIcon(kind, tone);
  return (
    <span
      role="status"
      aria-label={typeof text === 'string' ? text : undefined}
      title={hint}
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        TONE_CLASS[tone],
        className,
      )}
    >
      {pulse && tone === 'live' ? (
        <span aria-hidden className="relative flex size-2">
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', TONE_DOT[tone])} />
          <span className={cn('relative inline-flex size-2 rounded-full', TONE_DOT[tone])} />
        </span>
      ) : tone === 'idle' ? null : (
        <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      )}
      {glyph ? <span aria-hidden className="[&_svg]:size-3">{glyph}</span> : null}
      <span>{text}</span>
    </span>
  );
}
