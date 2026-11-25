import { useMemo } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { MetricCard } from '@/components/shared/metric-card';
import { DataState } from '@/components/shared/states';
import { ProviderChip } from '@/components/shared/status';
import { Empty } from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useGatewayUsage } from '@/lib/query';
import { DASH, fmtCompact, fmtDuration, fmtInt, fmtPercent } from '@/lib/format';
import { providerTitle } from '@/lib/provider';
import { GatewayUnreachable, InfoNote, isUnreachable } from './gateway-shared';
import { GatewayTokenChart, GatewayTrafficChart } from './GatewayUsageCharts';
import {
  gatewayDayPoints,
  gatewayModelRows,
  gatewayProviderRows,
  gatewayTotals,
  type GatewayAggRow,
} from './gateway-model';

const DAY_OPTIONS = [
  { value: 1, label: '近 1 天' },
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
] as const;

function errorTone(rate: number | null): 'default' | 'warning' | 'destructive' {
  if (rate === null) return 'default';
  if (rate >= 0.1) return 'destructive';
  if (rate > 0) return 'warning';
  return 'default';
}

/** Provider / 模型 Top 表。占比条只在总量 > 0 时出现。 */
function AggTable({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: GatewayAggRow[];
  kind: 'provider' | 'model';
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>按请求数降序；占比以本窗口总请求数为分母</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty
            title={`没有按 ${kind === 'provider' ? 'provider' : '模型'} 聚合`}
            description="网关该窗口没有对应维度数据；不补 0 行。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{kind === 'provider' ? 'Provider' : '模型'}</TableHead>
                <TableHead className="text-right">请求</TableHead>
                <TableHead className="text-right">错误</TableHead>
                <TableHead className="text-right">输入</TableHead>
                <TableHead className="text-right">输出</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="min-w-44">
                    <div className="flex flex-col gap-1">
                      {kind === 'provider' ? (
                        <ProviderChip id={row.label} title={providerTitle(row.label)} compact />
                      ) : (
                        <span className="font-mono">{row.label}</span>
                      )}
                      {row.share !== null ? (
                        <div className="flex items-center gap-2">
                          <Progress
                            value={row.share * 100}
                            className="h-1 w-24"
                            aria-label={`${row.label} 请求占比`}
                          />
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {fmtPercent(row.share, 1)}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.requests)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.errors)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.inputTokens)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.outputTokens)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** 网关用量：天数进 URL，与"OpenCode 用量"口径不同。 */
export function GatewayUsagePage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const rawDays =
    typeof search.days === 'number' ? search.days : typeof search.days === 'string' ? Number(search.days) : NaN;
  const days = DAY_OPTIONS.some((o) => o.value === rawDays) ? (rawDays as 1 | 7 | 30) : 7;

  const res = useGatewayUsage(days);
  const totals = useMemo(() => (res.data ? gatewayTotals(res.data) : null), [res.data]);
  const providerRows = useMemo(() => (res.data ? gatewayProviderRows(res.data) : []), [res.data]);
  const modelRows = useMemo(() => (res.data ? gatewayModelRows(res.data) : []), [res.data]);
  const dayPoints = useMemo(() => (res.data ? gatewayDayPoints(res.data) : []), [res.data]);

  const tabs = (
    <nav aria-label="统计天数" className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs">
      {DAY_OPTIONS.map((o) => (
        <Link
          key={o.value}
          to="/gateway/usage"
          search={(prev) => ({ ...prev, days: o.value })}
          replace
          className={
            days === o.value
              ? 'rounded-md bg-background px-3 py-1.5 text-foreground shadow-sm'
              : 'rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground'
          }
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );

  const actions = (
    <div className="flex items-center gap-2">
      {tabs}
      <Button size="sm" variant="outline" onClick={res.refetch}>
        <RefreshCw className="size-4" />
        刷新
      </Button>
    </div>
  );

  if (isUnreachable(res.error)) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="网关用量" description={`近 ${days} 天按天/按 provider 聚合。`} actions={actions} />
        <GatewayUnreachable message={res.error?.message} onRetry={res.refetch} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="网关用量"
        description={`近 ${days} 天网关转发的请求与 Token 计数（口径见下方说明）。`}
        actions={actions}
      />

      <InfoNote tone="info">
        口径对比：<strong>/usage</strong> 是 OpenCode 客户端口径（会话 / steps / 上报 cost，步骤不等于请求数）；
        本页是<strong>网关转发</strong>的 HTTP 请求数与 Token 计数（<code>requests/errors/inputTokens/outputTokens</code>）。
        两者单位不同，不互相换算，也不相加。
      </InfoNote>

      <DataState
        res={res}
        loadingLabel="正在读取网关用量…"
        onRetry={res.refetch}
        isEmpty={(d) => d.requests === 0 && d.byDay.length === 0}
        empty={
          <Empty
            title="该窗口没有网关用量"
            description={`近 ${days} 天没有读到任何转发记录。网关没跑过或记录已被清理都会是这种结果。`}
          />
        }
      >
        {(data) => (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <MetricCard label="请求数" value={fmtInt(data.requests)} sub="网关转发的 HTTP 请求" />
              <MetricCard
                label="失败数"
                value={fmtInt(data.errors)}
                tone={data.errors > 0 ? 'warning' : 'default'}
                sub="转发失败计数，与 provider 离线是两回事"
              />
              <MetricCard
                label="错误率"
                value={totals?.errorRate === null || totals?.errorRate === undefined ? DASH : fmtPercent(totals.errorRate, 1)}
                tone={errorTone(totals?.errorRate ?? null)}
                sub="errors / requests；请求为 0 时不计算"
              />
              <MetricCard
                label="输入 Token"
                value={fmtInt(data.inputTokens)}
                sub={fmtCompact(data.inputTokens)}
              />
              <MetricCard
                label="输出 Token"
                value={fmtInt(data.outputTokens)}
                sub={fmtCompact(data.outputTokens)}
              />
              <MetricCard
                label="平均耗时"
                value={totals?.avgDurationMs == null ? DASH : fmtDuration(totals.avgDurationMs)}
                sub="按请求数加权的日均值"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <GatewayTrafficChart usage={data} days={days} />
              <GatewayTokenChart usage={data} days={days} />
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <AggTable title="Provider Top" rows={providerRows} kind="provider" />
              <AggTable title="模型 Top" rows={modelRows} kind="model" />
            </div>

            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-medium text-muted-foreground">按天明细</h2>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>日期</TableHead>
                      <TableHead className="text-right">请求</TableHead>
                      <TableHead className="text-right">失败</TableHead>
                      <TableHead className="text-right">错误率</TableHead>
                      <TableHead className="text-right">输入 Token</TableHead>
                      <TableHead className="text-right">输出 Token</TableHead>
                      <TableHead className="text-right">平均耗时</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dayPoints.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                          没有按天明细
                        </TableCell>
                      </TableRow>
                    ) : (
                      dayPoints.map((row) => (
                        <TableRow key={row.day}>
                          <TableCell className="font-mono">{row.day || DASH}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(row.requests)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(row.errors)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.errorRate === null ? DASH : fmtPercent(row.errorRate, 1)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(row.inputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(row.outputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.avgDurationMs == null ? DASH : fmtDuration(row.avgDurationMs)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
          </div>
        )}
      </DataState>
    </div>
  );
}