import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Sparkline：纯 SVG 迷你趋势线（无图表库依赖）。
 *
 * - 只画传入的真实数值点，不插值、不补假数据；
 * - 少于 2 个点时不画线，返回空占位（避免「看起来有趋势」的误导）；
 * - 默认 `aria-hidden`（作为 KPI 卡片的装饰），传 `label` 时改为可读图（role="img"）。
 */
export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  /** 线色；默认 accent。 */
  stroke?: string;
  /** 面积填充；默认同线色的浅色渐变。 */
  fill?: boolean;
  /** 传入可访问名后，SVG 会暴露给读屏（否则 aria-hidden）。 */
  label?: string;
  /** 读屏摘要；缺省用 label + 起止值。 */
  description?: string;
  /** 高亮最后一个点。 */
  dot?: boolean;
}

function buildPath(values: number[], width: number, height: number, pad: number) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;
  return values.map((v, i) => {
    const x = pad + i * step;
    // min 在上（SVG 坐标向下为正）
    const y = pad + innerH - ((v - min) / span) * innerH;
    return [x, y] as const;
  });
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  className,
  stroke = 'var(--accent-rest)',
  fill = true,
  label,
  description,
  dot = false,
}: SparklineProps) {
  const gid = useId().replace(/[:]/g, '');
  const values = data.filter((v) => Number.isFinite(v));
  const accessible = label
    ? { role: 'img' as const, 'aria-label': label }
    : { 'aria-hidden': true as const };

  if (values.length < 2) {
    return (
      <span
        {...accessible}
        aria-label={label && description ? `${label}：${description}` : accessible['aria-label']}
        className={cn(
          'inline-flex items-center justify-center rounded-sm bg-surface-2 text-[10px] text-text-tertiary',
          className,
        )}
        style={{ width, height }}
      >
        {label && description ? '数据不足' : null}
      </span>
    );
  }

  const pad = 2;
  const pts = buildPath(values, width, height, pad);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(2)},${height - pad} L${pts[0][0].toFixed(2)},${height - pad} Z`;
  const last = pts[pts.length - 1];
  const summary =
    description ??
    `共 ${values.length} 个点，从 ${values[0]} 到 ${values[values.length - 1]}，峰值 ${Math.max(...values)}`;

  return (
    <svg
      {...accessible}
      aria-label={label ? (description ? `${label}：${summary}` : label) : undefined}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('overflow-visible', className)}
      preserveAspectRatio="none"
    >
      {fill ? (
        <>
          <defs>
            <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#spark-${gid})`} />
        </>
      ) : null}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {dot ? <circle cx={last[0]} cy={last[1]} r={2} fill={stroke} /> : null}
    </svg>
  );
}

/**
 * RingGauge：环形进度（纯 SVG，带 stroke-dasharray）。
 *
 * 语义：`value` 0–100；`null` 表示无法计算（不渲染弧线，只显示占位文本），
 * 避免把「未知」画成 0%。环形本身 aria-hidden，文字摘要始终可读。
 */
export interface RingGaugeProps {
  value: number | null;
  /** 中心主文本；缺省为百分比。 */
  display?: ReactNode;
  /** 中心下方说明。 */
  caption?: ReactNode;
  size?: number;
  thickness?: number;
  /** 数值对应的颜色（阈值由调用方决定，组件不猜）。 */
  color?: string;
  className?: string;
  /** 可访问名，例如「健康度」。 */
  label?: string;
}

export function RingGauge({
  value,
  display,
  caption,
  size = 96,
  thickness = 8,
  color = 'var(--accent-rest)',
  className,
  label,
}: RingGaugeProps) {
  const known = value !== null && Number.isFinite(value);
  const pct = known ? Math.max(0, Math.min(100, value)) : 0;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  const text = known ? `${Math.round(pct)}%` : '—';
  return (
    <div
      className={cn('inline-flex flex-col items-center gap-1', className)}
      role="group"
      aria-label={label}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} aria-hidden focusable="false" className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--stroke-1)"
            strokeWidth={thickness}
          />
          {known ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={thickness}
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={offset}
              className="transition-[stroke-dashoffset] duration-[250ms] ease-[cubic-bezier(0.2,0,0,1)]"
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-ramp-20 font-semibold tabular-nums leading-none">{display ?? text}</span>
          {caption ? <span className="mt-1 text-[11px] text-text-secondary">{caption}</span> : null}
        </div>
      </div>
      {/* 文本摘要：读屏与色觉障碍用户都能拿到数值，不只依赖弧线长度。 */}
      <span className="sr-only">
        {label ? `${label}：` : ''}
        {known ? `${Math.round(pct)}%` : '无法计算'}
      </span>
    </div>
  );
}
