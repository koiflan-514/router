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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import type { UsageRange } from '@/lib/contract';
import { DASH, fmtCompact, fmtInt } from '@/lib/format';
import { cn } from '@/lib/cn';
import { rangeTickGap, type ActivityPoint } from '@/features/usage/usage-model';

type Mode = 'steps' | 'tokens';

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
 * 报表趋势：OpenCode 按日 steps，或按日 Token 堆叠（仅当 activity 真的带 Token）。
 * 不把范围总量摊到每天，也不生成随机曲线。
 */
export function ReportActivityChart({
  points,
  dailyTokens,
  range,
}: {
  points: ActivityPoint[];
  dailyTokens: boolean;
  range: UsageRange;
}) {
  const [mode, setMode] = useState<Mode>('steps');
  const effective: Mode = mode === 'tokens' && dailyTokens ? 'tokens' : 'steps';
  const hasSteps = points.some((point) => point.steps > 0);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>OpenCode 用量趋势</CardTitle>
        <CardDescription>
          {effective === 'steps'
            ? '按日 steps（会话步骤，不等于 HTTP 请求数）'
            : '按日输入 / 输出 / 推理 Token；缓存读写另计'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          role="group"
          aria-label="趋势口径"
          className="inline-flex w-fit items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs print:hidden"
        >
          <button
            type="button"
            aria-pressed={effective === 'steps'}
            onClick={() => setMode('steps')}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              effective === 'steps'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            steps
          </button>
          <button
            type="button"
            aria-pressed={effective === 'tokens'}
            disabled={!dailyTokens}
            title={dailyTokens ? '按日 Token' : 'OpenCode 未提供按日 Token'}
            onClick={() => setMode('tokens')}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
              effective === 'tokens'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            tokens
          </button>
        </div>

        {points.length === 0 || !hasSteps ? (
          <Empty
            icon={<TrendingUp />}
            title="该范围没有按日活动"
            description="activity 为空或 steps 全为 0；不画曲线，不推算每日用量。"
          />
        ) : (
          <>
            <div
              className="h-64 w-full"
              role="img"
              aria-label={effective === 'steps' ? '报表每日 steps 面积图' : '报表每日 Token 堆叠面积图'}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="report-steps" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--info)" stopOpacity={0.32} />
                      <stop offset="100%" stopColor="var(--info)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="report-token-input" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--info)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--info)" stopOpacity={0.04} />
                    </linearGradient>
                    <linearGradient id="report-token-output" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--success)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--success)" stopOpacity={0.04} />
                    </linearGradient>
                    <linearGradient id="report-token-reasoning" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--warning)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--warning)" stopOpacity={0.04} />
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
                    contentStyle={tooltipStyle()}
                    cursor={{ stroke: 'var(--border)' }}
                    labelFormatter={(label, payload) => {
                      const point = payload?.[0]?.payload as { date?: string } | undefined;
                      return `日期 ${point?.date ?? String(label)}`;
                    }}
                    formatter={(value, name) => [fmtInt(Number(value)), String(name)]}
                  />
                  {effective === 'steps' ? (
                    <Area
                      type="monotone"
                      dataKey="steps"
                      name="steps"
                      stroke="var(--info)"
                      strokeWidth={2}
                      fill="url(#report-steps)"
                      isAnimationActive="auto"
                      dot={points.length === 1 ? { r: 3 } : false}
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
                        fill="url(#report-token-input)"
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
                        fill="url(#report-token-output)"
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
                        fill="url(#report-token-reasoning)"
                        isAnimationActive="auto"
                        dot={false}
                      />
                    </>
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {effective === 'steps'
                ? `steps 是 OpenCode 会话步骤，不等于网关 HTTP 请求；${points.length} 天活动点。`
                : `按日 Token 仅含输入/输出/推理；缓存读写不并入。${dailyTokens ? '' : `按日 Token 不可用（${DASH}）。`}`}
            </p>
            <ul className="sr-only">
              {points.map((point) => (
                <li key={point.date}>
                  {point.date}：{fmtInt(point.steps)} steps
                  {point.tokenTotal !== null ? `；${fmtInt(point.tokenTotal)} tokens` : ''}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}