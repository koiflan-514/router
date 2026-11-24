import { Activity, ArrowLeftRight } from 'lucide-react';
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
import type { GatewayUsage } from '@/lib/schemas';
import { fmtCompact, fmtInt } from '@/lib/format';
import { gatewayDayPoints } from './gateway-model';

function tooltipStyle() {
  return {
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
  } as const;
}

/** 网关每日请求 / 错误。两条线量级不同，用左右双轴而不是强行堆叠。 */
export function GatewayTrafficChart({ usage, days }: { usage: GatewayUsage; days: number }) {
  const points = gatewayDayPoints(usage);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>每日请求 / 错误</CardTitle>
        <CardDescription>
          近 {days} 天网关转发的 HTTP 请求；错误为转发失败计数
        </CardDescription>
      </CardHeader>
      <CardContent>
        {points.length === 0 ? (
          <Empty
            icon={<Activity />}
            title="没有按天网关用量"
            description="该窗口没有读到任何按天分片；不是 0 请求的意思，可刷新或换窗口。"
          />
        ) : (
          <>
            <div className="h-60 w-full" role="img" aria-label="网关每日请求与错误面积图">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="gw-requests" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--info)" stopOpacity={0.32} />
                      <stop offset="100%" stopColor="var(--info)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="gw-errors" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--destructive)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    minTickGap={16}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="requests"
                    width={48}
                    tickFormatter={(value) => fmtCompact(Number(value))}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    yAxisId="errors"
                    orientation="right"
                    width={40}
                    tickFormatter={(value) => fmtCompact(Number(value))}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle()}
                    cursor={{ stroke: 'var(--border)' }}
                    labelFormatter={(label, payload) => {
                      const point = payload?.[0]?.payload as { day?: string } | undefined;
                      return `日期 ${point?.day ?? String(label)}`;
                    }}
                    formatter={(value, name) => [fmtInt(Number(value)), name === 'requests' ? '请求' : '错误']}
                  />
                  <Area
                    yAxisId="requests"
                    type="monotone"
                    dataKey="requests"
                    name="requests"
                    stroke="var(--info)"
                    strokeWidth={2}
                    fill="url(#gw-requests)"
                    isAnimationActive="auto"
                    dot={points.length === 1 ? { r: 3 } : false}
                  />
                  <Area
                    yAxisId="errors"
                    type="monotone"
                    dataKey="errors"
                    name="errors"
                    stroke="var(--destructive)"
                    strokeWidth={1.5}
                    fill="url(#gw-errors)"
                    isAnimationActive="auto"
                    dot={points.length === 1 ? { r: 3 } : false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-sm bg-info" />
                请求（左轴）
              </span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-sm bg-destructive" />
                错误（右轴）
              </span>
            </div>
            <ul className="sr-only">
              {points.map((point) => (
                <li key={point.day}>
                  {point.day}：{fmtInt(point.requests)} 请求，{fmtInt(point.errors)} 错误
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 网关每日输入 / 输出 Token 堆叠面积图。 */
export function GatewayTokenChart({ usage, days }: { usage: GatewayUsage; days: number }) {
  const points = gatewayDayPoints(usage);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>每日 Token</CardTitle>
        <CardDescription>近 {days} 天输入 / 输出 Token（网关从上游 usage 采集，无推理与缓存写）</CardDescription>
      </CardHeader>
      <CardContent>
        {points.length === 0 ? (
          <Empty
            icon={<ArrowLeftRight />}
            title="没有按天 Token"
            description="按天分片为空时不绘图，也不会把总量平摊到每一天。"
          />
        ) : (
          <>
            <div className="h-60 w-full" role="img" aria-label="网关每日输入输出 Token 堆叠面积图">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="gw-token-input" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--info)" stopOpacity={0.38} />
                      <stop offset="100%" stopColor="var(--info)" stopOpacity={0.04} />
                    </linearGradient>
                    <linearGradient id="gw-token-output" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--success)" stopOpacity={0.38} />
                      <stop offset="100%" stopColor="var(--success)" stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    minTickGap={16}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    width={48}
                    tickFormatter={(value) => fmtCompact(Number(value))}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle()}
                    cursor={{ stroke: 'var(--border)' }}
                    labelFormatter={(label, payload) => {
                      const point = payload?.[0]?.payload as { day?: string } | undefined;
                      return `日期 ${point?.day ?? String(label)}`;
                    }}
                    formatter={(value, name) => [fmtInt(Number(value)), String(name)]}
                  />
                  <Area
                    type="monotone"
                    dataKey="inputTokens"
                    name="输入"
                    stackId="tokens"
                    stroke="var(--info)"
                    strokeWidth={1.5}
                    fill="url(#gw-token-input)"
                    isAnimationActive="auto"
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="outputTokens"
                    name="输出"
                    stackId="tokens"
                    stroke="var(--success)"
                    strokeWidth={1.5}
                    fill="url(#gw-token-output)"
                    isAnimationActive="auto"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-sm bg-info" />
                输入
              </span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-sm bg-success" />
                输出
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}