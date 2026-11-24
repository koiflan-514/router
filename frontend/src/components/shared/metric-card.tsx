import { useId, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { Sparkline } from './charts';

export type MetricTone = 'default' | 'success' | 'warning' | 'destructive' | 'info';

export interface MetricTrend {
  /** 变化量；单位由调用方说明（计数/百分比点）。正负号决定箭头方向。 */
  value: number;
  /** 补充说明，例如「较上一周期」。 */
  label?: string;
  /** 增长是好事还是坏事；默认 neutral（只显示方向，不判断好恶）。 */
  intent?: 'neutral' | 'up-good' | 'down-good';
  /** 数值展示方式：绝对值或百分比。 */
  format?: 'delta' | 'percent';
}

export interface MetricCardProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  hint?: ReactNode;
  tone?: MetricTone;
  className?: string;
  /** 迷你趋势数据（真实数值点，不做插值）。少于 2 点显示占位。 */
  spark?: number[];
  /** 趋势说明；与 spark 可独立使用。 */
  trend?: MetricTrend;
  /** 密度：compact 收紧内边距与数值字号。 */
  density?: 'compact' | 'comfortable';
  /** 卡内右上角辅助内容（图标/徽标）。 */
  accessory?: ReactNode;
  /** 点击整卡（只读页不要传）。 */
  onClick?: () => void;
  /** 可访问的趋势摘要；缺省由 spark/trend 自动生成。 */
  sparkLabel?: string;
}

const TONE_TEXT: Record<MetricTone, string> = {
  default: 'text-text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  info: 'text-info',
};

const SPARK_STROKE: Record<MetricTone, string> = {
  default: 'var(--accent-rest)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  destructive: 'var(--destructive)',
  info: 'var(--info)',
};

function trendText(trend: MetricTrend): string {
  const sign = trend.value > 0 ? '+' : trend.value < 0 ? '−' : '';
  const abs = Math.abs(trend.value);
  const num = trend.format === 'percent' ? `${abs}%` : `${abs}`;
  return `${sign}${num}`;
}

function trendTone(trend: MetricTrend): string {
  if (trend.value === 0) return 'text-text-tertiary';
  const up = trend.value > 0;
  const intent = trend.intent ?? 'neutral';
  if (intent === 'up-good') return up ? 'text-success' : 'text-destructive';
  if (intent === 'down-good') return up ? 'text-destructive' : 'text-success';
  return 'text-text-secondary';
}

/**
 * MetricCard：KPI 瓦片。
 *
 * 兼容旧用法（label/value/sub/hint/tone/className）；以下均为可选增强：
 * `spark` 迷你趋势、`trend` 数值变化、`density` 密度、`accessory` 角标。
 */
export function MetricCard({
  label,
  value,
  sub,
  hint,
  tone = 'default',
  className,
  spark,
  trend,
  density = 'comfortable',
  accessory,
  onClick,
  sparkLabel,
}: MetricCardProps) {
  const labelId = useId();
  const compact = density === 'compact';
  const TrendIcon = !trend ? null : trend.value > 0 ? ArrowUpRight : trend.value < 0 ? ArrowDownRight : Minus;
  const hasSpark = Array.isArray(spark) && spark.filter((n) => Number.isFinite(n)).length >= 2;
  const trendSummary = trend
    ? `${trend.value === 0 ? '持平' : trend.value > 0 ? '上升' : '下降'} ${Math.abs(trend.value)}${
        trend.format === 'percent' ? '%' : ''
      }${trend.label ? `（${trend.label}）` : ''}`
    : null;
  const descId = useId();

  return (
    <Card
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hasSpark || trend ? descId : undefined}
      onClick={onClick}
      className={cn(
        'group relative overflow-hidden transition-shadow duration-150 ease-[cubic-bezier(0.2,0,0,1)]',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      <CardHeader className={cn('flex flex-row items-start justify-between gap-2', compact ? 'p-3 pb-1' : 'p-4 pb-2')}>
        <CardTitle id={labelId} className="text-ramp-12 font-medium text-text-secondary">
          {label}
        </CardTitle>
        {accessory ? <span className="text-text-tertiary [&_svg]:size-4">{accessory}</span> : null}
      </CardHeader>
      <CardContent className={cn(compact ? 'px-3 pb-2.5 pt-0' : 'px-4 pb-4 pt-0')}>
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div
              data-density={density}
              className={cn(
                'font-display font-semibold tabular-nums leading-none tracking-tight',
                // type ramp：20px / 28px（Fluent Display 字重）
                compact ? 'text-[20px]' : 'text-[28px]',
                TONE_TEXT[tone],
              )}
            >
              {value}
            </div>
            {trend ? (
              <div className={cn('inline-flex items-center gap-1 text-[11px] tabular-nums', trendTone(trend))}>
                {TrendIcon ? <TrendIcon aria-hidden className="size-3" /> : null}
                <span>{trendText(trend)}</span>
                {trend.label ? <span className="text-text-tertiary">{trend.label}</span> : null}
              </div>
            ) : null}
          </div>
          {hasSpark ? (
            <Sparkline
              data={spark ?? []}
              width={compact ? 64 : 88}
              height={compact ? 24 : 32}
              stroke={SPARK_STROKE[tone]}
              dot
              className="shrink-0 opacity-90"
            />
          ) : null}
        </div>
        {sub ? <div className="mt-1.5 text-[12px] text-text-secondary">{sub}</div> : null}
        {hint ? <div className="mt-1 text-[11px] text-text-tertiary">{hint}</div> : null}
        {hasSpark || trend ? (
          <span id={descId} className="sr-only">
            {[sparkLabel ?? (hasSpark ? `趋势：共 ${spark?.length} 个数据点` : null), trendSummary]
              .filter(Boolean)
              .join('；')}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}
