import { TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import type { UsageRange, UsageStats } from '@/lib/contract';
import { DASH, fmtCompact, fmtDateTime, fmtInt, fmtNumber } from '@/lib/format';
import { activityPoints, hasActivity, rangeLabel } from './usage-model';

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return DASH;
  return fmtDateTime(new Date(ms).toISOString());
}

/**
 * 每日活动面积图（Recharts v3）。
 * 数据只来自 `activity[]`；空数组显示空状态，绝不生成随机曲线（14 §6.3）。
 */
export function ActivityChart({ data, range }: { data: UsageStats; range: UsageRange }) {
  const points = activityPoints(data);
  const from = data.range?.from ?? 0;
  const to = data.range?.to ?? 0;
  const rangeText =
    range === 'all'
      ? `全部历史${to ? ` → ${fmtMs(to)}` : ''}`
      : from && to
        ? `${fmtMs(from)} → ${fmtMs(to)}`
        : rangeLabel(range);
  const costText = data.cost > 0 ? fmtNumber(data.cost) : '—（OpenCode 未上报）';

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
      <CardContent>
        {points.length === 0 || !hasActivity(data) ? (
          <Empty
            icon={<TrendingUp />}
            title="该时间范围内没有活动数据"
            description={`范围：${rangeText}。activity 为空或所有日期 steps 均为 0，不绘制曲线。`}
          />
        ) : (
          <>
            <div className="h-60 w-full" role="img" aria-label="每日 steps 面积图">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="usage-activity-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--info)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--info)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    minTickGap={8}
                  />
                  <YAxis
                    width={44}
                    tickFormatter={(value) => fmtCompact(Number(value))}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    isAnimationActive="auto"
                    cursor={{ stroke: 'var(--border)' }}
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--popover)',
                      color: 'var(--popover-foreground)',
                    }}
                    labelFormatter={(label, payload) => {
                      const point = payload?.[0]?.payload as { date?: string } | undefined;
                      return `日期 ${point?.date ?? String(label)}`;
                    }}
                    formatter={(value) => [fmtInt(Number(value as number)), 'steps']}
                  />
                  <Area
                    type="monotone"
                    dataKey="steps"
                    name="steps"
                    stroke="var(--info)"
                    strokeWidth={2}
                    fill="url(#usage-activity-fill)"
                    isAnimationActive="auto"
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {/* FR-168：关键数值提供文本等价，不只存在于图形中。 */}
            <ul className="sr-only">
              {points.map((p) => (
                <li key={p.date}>
                  {p.date}：{fmtInt(p.steps)} steps
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
