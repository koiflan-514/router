import { Link, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { MetricCard } from '@/components/shared/metric-card';
import { DataState } from '@/components/shared/states';
import { Empty } from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useGatewayUsage } from '@/lib/query';
import { DASH, fmtCompact, fmtDuration, fmtInt } from '@/lib/format';
import { GatewayUnreachable, InfoNote, isUnreachable } from './gateway-shared';

const DAY_OPTIONS = [
  { value: 1, label: '近 1 天' },
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
] as const;

type UsageRow = Record<string, unknown>;

function pickNum(row: UsageRow, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pickStr(row: UsageRow, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

/** 网关用量：天数进 URL，与"OpenCode 用量"口径不同。 */
export function GatewayUsagePage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const rawDays =
    typeof search.days === 'number' ? search.days : typeof search.days === 'string' ? Number(search.days) : NaN;
  const days = DAY_OPTIONS.some((o) => o.value === rawDays) ? (rawDays as 1 | 7 | 30) : 7;

  const res = useGatewayUsage(days);

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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard label="请求数" value={fmtInt(data.requests)} sub="网关转发的 HTTP 请求" />
              <MetricCard
                label="失败数"
                value={fmtInt(data.errors)}
                tone={data.errors > 0 ? 'warning' : 'default'}
                sub="转发失败计数，与 provider 离线是两回事"
              />
              <MetricCard label="输入 Token" value={fmtInt(data.inputTokens)} sub={fmtCompact(data.inputTokens)} />
              <MetricCard label="输出 Token" value={fmtInt(data.outputTokens)} sub={fmtCompact(data.outputTokens)} />
            </div>

            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-medium text-muted-foreground">按天</h2>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>日期</TableHead>
                      <TableHead className="text-right">请求</TableHead>
                      <TableHead className="text-right">失败</TableHead>
                      <TableHead className="text-right">输入 Token</TableHead>
                      <TableHead className="text-right">输出 Token</TableHead>
                      <TableHead className="text-right">平均耗时</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byDay.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                          没有按天明细
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.byDay.map((row, i) => (
                        <TableRow key={`${pickStr(row, 'day') || i}`}>
                          <TableCell className="font-mono">{pickStr(row, 'day') || DASH}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'requests'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'errors'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'inputTokens'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'outputTokens'))}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {pickNum(row, 'avgDurationMs') == null
                              ? DASH
                              : fmtDuration(pickNum(row, 'avgDurationMs'))}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-medium text-muted-foreground">按 Provider</h2>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead className="text-right">请求</TableHead>
                      <TableHead className="text-right">失败</TableHead>
                      <TableHead className="text-right">输入 Token</TableHead>
                      <TableHead className="text-right">输出 Token</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byProvider.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                          没有按 provider 聚合
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.byProvider.map((row, i) => (
                        <TableRow key={`${pickStr(row, 'provider') || i}`}>
                          <TableCell className="font-mono">{pickStr(row, 'provider') || DASH}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'requests'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'errors'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'inputTokens'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'outputTokens'))}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>

            {data.byModel.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-xs font-medium text-muted-foreground">按模型</h2>
                <div className="overflow-hidden rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>模型</TableHead>
                        <TableHead className="text-right">请求</TableHead>
                        <TableHead className="text-right">失败</TableHead>
                        <TableHead className="text-right">输入 Token</TableHead>
                        <TableHead className="text-right">输出 Token</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byModel.map((row, i) => (
                        <TableRow key={`${pickStr(row, 'model') || pickStr(row, 'id') || i}`}>
                          <TableCell className="font-mono">
                            {pickStr(row, 'model') || pickStr(row, 'id') || DASH}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'requests'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'errors'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'inputTokens'))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(pickNum(row, 'outputTokens'))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}
          </div>
        )}
      </DataState>
    </div>
  );
}
