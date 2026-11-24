import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import type { UsageRange, UsageStats } from '@/lib/contract';
import { DASH, fmtCompact, fmtDateTime, fmtInt, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  activityPoints,
  hasActivity,
  hasDailyTokens,
  rangeLabel,
  rangeTickGap,
} from './usage-model';

type ChartMode = 'steps' | 'tokens';

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return DASH;
  return fmtDateTime(new Date(ms).toISOString());
}

function tooltipStyle() {
  return {
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
  } as const;
}

/**
 * 每日活动面积图。
 *
 * - steps 直接来自 `activity[].steps`；
 * - Token 模式只在 activity 真的带按日 Token 字段时可用，绝不把总量平摊成假曲线；
 * - x 轴密度按 24h / 7d / 30d / all 调整。
 */
export function ActivityChart({ data, range }: { data: UsageStats; range: UsageRange }) {
  const [mode, setMode] = useState<ChartMode>('steps');
  const points = activityPoints(data);
  const dailyTokens = hasDailyTokens(data);
  const active = hasActivity(data);
  const from = data.range?.from ?? 0;
  const to = data.range?.to ?? 0;
  const rangeText =
    range === 'all'
      ? `全部历史${to ? ` → ${fmtMs(to)}` : ''}`
      : from && to
        ? `${fmtMs(from)} → ${fmtMs(to)}`
        : rangeLabel(range);
  const costText = data.cost > 0 ? fmtNumber(data.cost) : '—（OpenCode 未上报）';
  const effectiveMode: ChartMode = mode === 'tokens' && dailyTokens ? 'tokens' : 'steps';

  return (
    <Card>
      <CardHeader>
        <CardTitle>每日活动</CardTitle>
        <CardDescription>
          逐日 steps（OpenCode 会话步骤）· 活跃 {fmtInt(data.activeDays)} 天 · 连续{' '}
          {fmtInt(data.streak)} 天
        </CardDescription>
        <CardAction>
          <div className="text-right text-[11px] leading-tight text-muted-foreground">
            <div>范围：{rangeText}</div>
            <div>
              OpenCode 上报成本 <span className="tabular-nums text-foreground">{costText}</span>
            </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          role="group"
          aria-label="图表口径"
          className="inline-flex w-fit items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs"
        >
          <button
            type="button"
            aria-pressed={effectiveMode === 'steps'}
            onClick={() => setMode('steps')}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              effectiveMode === 'steps'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            steps
          </button>
          <button
            type="button"
            aria-pressed={effectiveMode === 'tokens'}
            disabled={!dailyTokens}
            title={dailyTokens ? '按日 Token 堆叠' : 'OpenCode 未返回按日 Token，不能用总量伪造趋势'}
            onClick={() => setMode('tokens')}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
              effectiveMode === 'tokens'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            tokens
          </button>
        </div>

        {points.length === 0 || !active ? (
          <Empty
            icon={<TrendingUp />}
            title="该时间范围内没有活动数据"
            description={`范围：${rangeText}。activity 为空或所有日期 steps 均为 0，不绘制曲线。`}
          />
        ) : (
          <>
            <div
              className="h-64 w-full"
              role="img"
              aria-label={effectiveMode === 'steps' ? '每日 steps 面积图' : '每日 Token 堆叠面积图'}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="usage-activity-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--info)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--info)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="usage-token-input" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--info)" stopOpacity={0.42} />
                      <stop offset="100%" stopColor="var(--info)" stopOpacity={0.06} />
                    </linearGradient>
                    <linearGradient id="usage-token-output" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--success)" stopOpacity={0.42} />
                      <stop offset="100%" stopColor="var(--success)" stopOpacity={0.06} />
                    </linearGradient>
                    <linearGradient id="usage-token-reasoning" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--warning)" stopOpacity={0.42} />
                      <stop offset="100%" stopColor="var(--warning)" stopOpacity={0.06} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    minTickGap={rangeTickGap(range)}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    width={48}
                    tickFormatter={(value) => fmtCompact(Number(value))}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    allowDecimals={false}
                    domain={[0, 'auto']}
                  />
                  <Tooltip
                    cursor={{ stroke: 'var(--border)' }}
                    contentStyle={tooltipStyle()}
                    labelFormatter={(label, payload) => {
                      const point = payload?.[0]?.payload as { date?: string } | undefined;
                      return `日期 ${point?.date ?? String(label)}`;
                    }}
                    formatter={(value, name) => [
                      effectiveMode === 'steps' ? fmtInt(Number(value)) : fmtInt(Number(value)),
                      effectiveMode === 'steps' ? 'steps' : String(name),
                    ]}
                  />
                  {effectiveMode === 'steps' ? (
                    <Area
                      type="monotone"
                      dataKey="steps"
                      name="steps"
                      stroke="var(--info)"
                      strokeWidth={2}
                      fill="url(#usage-activity-fill)"
                      isAnimationActive="auto"
                      dot={points.length === 1 ? { r: 3 } : false}
                      activeDot={{ r: 3 }}
                    />
                  ) : (
                    <>
                      <Area
                        type="monotone"
                        dataKey="input"
                        name="输入"
                        stackId="tokens"
                        stroke="var(--info)"
                        strokeWidth={1.5}
                        fill="url(#usage-token-input)"
                        isAnimationActive="auto"
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="output"
                        name="输出"
                        stackId="tokens"
                        stroke="var(--success)"
                        strokeWidth={1.5}
                        fill="url(#usage-token-output)"
                        isAnimationActive="auto"
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="reasoning"
                        name="推理"
                        stackId="tokens"
                        stroke="var(--warning)"
                        strokeWidth={1.5}
                        fill="url(#usage-token-reasoning)"
                        isAnimationActive="auto"
                        dot={false}
                      />
                    </>
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {effectiveMode === 'steps'
                ? 'steps 是 OpenCode 会话步骤，不等于 HTTP 请求数；值为 0 的日期保留在 x 轴上。'
                : 'Token 仅含输入 / 输出 / 推理；缓存读写另计，不在此堆叠中。'}
            </p>
            <ul className="sr-only">
              {points.map((p) => (
                <li key={p.date}>
                  {p.date}：{fmtInt(p.steps)} steps
                  {p.tokenTotal !== null ? `；${fmtInt(p.tokenTotal)} tokens` : ''}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}