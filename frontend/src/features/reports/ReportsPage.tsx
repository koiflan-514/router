import { useMemo } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  Printer,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/page-header';
import { MetricCard } from '@/components/shared/metric-card';
import { LoadingState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { useGatewayStatus, useGatewayUsage, useProviders, useQuota, useUsage } from '@/lib/query';
import { DASH, fmtCompact, fmtDateTime, fmtInt, fmtPercent, fmtNumber, todayLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { isUsageEmpty, isUsageRange, parseRange } from '@/features/usage/usage-model';
import { RangeSwitch } from '@/features/usage/RangeSwitch';
import {
  buildReportModel,
  reportCsv,
  reportJson,
  type ReportModel,
  type ReportSourceState,
  type ReportSourceStatus,
} from './reports-model';
import { ReportActivityChart } from './ReportsCharts';
import {
  GatewaySnapshotCard,
  ModelTopTable,
  ProviderMatrixCard,
  ProviderTopTable,
  QuotaSnapshotCard,
} from './ReportsTables';

const SOURCE_VARIANT: Record<ReportSourceState, 'success' | 'warning' | 'destructive' | 'muted' | 'info'> = {
  ok: 'success',
  stale: 'warning',
  error: 'destructive',
  loading: 'info',
  empty: 'muted',
};

const SOURCE_TEXT: Record<ReportSourceState, string> = {
  ok: '正常',
  stale: '旧数据',
  error: '失败',
  loading: '加载中',
  empty: '空',
};

function sourceState<T>(
  res: { data: T | null; error: unknown | null; loading: boolean; stale: boolean },
  isEmpty?: (data: T) => boolean,
): ReportSourceState {
  if (res.data === null) return res.error ? 'error' : 'loading';
  if (res.stale) return 'stale';
  if (isEmpty?.(res.data)) return 'empty';
  return 'ok';
}

function reportGatewayDays(range: ReturnType<typeof parseRange>): number {
  if (range === '24h') return 1;
  if (range === '7d') return 7;
  if (range === '30d') return 30;
  // 网关按自然日分片，桥接上限 90 天；全部历史只能用 90 天近似，并在页面明示。
  return 90;
}

function ConclusionIcon({ tone }: { tone: ReportModel['conclusions'][number]['tone'] }) {
  if (tone === 'success') return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />;
  if (tone === 'warning') return <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />;
  if (tone === 'destructive') return <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
  return <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" />;
}

function Exports({ model, disabled }: { model: ReportModel; disabled: boolean }) {
  function download(content: string, type: string, filename: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function onCsv() {
    try {
      download(
        reportCsv(model),
        'text/csv;charset=utf-8',
        `router-report-${model.range}-${todayLocal()}.csv`,
      );
      toast.success('报表 CSV 已导出', { description: 'KPI、按日、provider、模型、额度桶明细' });
    } catch (err) {
      toast.error('导出 CSV 失败', { description: (err as Error).message });
    }
  }

  function onJson() {
    try {
      download(
        reportJson(model),
        'application/json;charset=utf-8',
        `router-report-${model.range}-${todayLocal()}.json`,
      );
      toast.success('报表 JSON 已导出', { description: '汇总结构，含来源状态与结论' });
    } catch (err) {
      toast.error('导出 JSON 失败', { description: (err as Error).message });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <Button size="sm" variant="outline" onClick={onCsv} disabled={disabled}>
        <Download className="size-4" />
        CSV 明细
      </Button>
      <Button size="sm" variant="outline" onClick={onJson} disabled={disabled}>
        <FileJson className="size-4" />
        JSON 汇总
      </Button>
      <Button size="sm" variant="outline" onClick={() => window.print()}>
        <Printer className="size-4" />
        打印
      </Button>
    </div>
  );
}

/**
 * 报表页（路由 `/reports`，导航由外壳提供）。
 *
 * 只消费现有五个只读查询，不新增后端；所有数字都带来源与口径，
 * 加载/空/错误/旧数据分别呈现，导出为客户端 Blob。
 */
export function ReportsPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const range = parseRange(search.range);
  const rangeInvalid =
    typeof search.range === 'string' && search.range !== '' && !isUsageRange(search.range);
  const gatewayDays = reportGatewayDays(range);

  const navigate = useNavigate() as unknown as (opts: {
    to: string;
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
    replace?: boolean;
  }) => void;

  const usageRes = useUsage(range);
  const quotaRes = useQuota();
  const providersRes = useProviders();
  const gatewayUsageRes = useGatewayUsage(gatewayDays);
  const gatewayStatusRes = useGatewayStatus();

  const sources = useMemo<ReportSourceStatus[]>(
    () => [
      {
        key: 'usage',
        label: 'OpenCode 用量',
        state: sourceState(usageRes, isUsageEmpty),
        detail: usageRes.error?.message,
      },
      {
        key: 'quota',
        label: '额度',
        state: sourceState(quotaRes, (data) => data.providers.length === 0),
        detail: quotaRes.error?.message,
      },
      {
        key: 'providers',
        label: 'Provider 状态',
        state: sourceState(providersRes, (data) => data.length === 0),
        detail: providersRes.error?.message,
      },
      {
        key: 'gatewayUsage',
        label: '网关用量',
        state: sourceState(gatewayUsageRes, (data) => data.requests === 0 && data.byDay.length === 0),
        detail: gatewayUsageRes.error?.message,
      },
      {
        key: 'gatewayStatus',
        label: '网关调度',
        state: sourceState(gatewayStatusRes, (data) => data.providers.length === 0),
        detail: gatewayStatusRes.error?.message,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      usageRes.data,
      usageRes.error,
      usageRes.loading,
      usageRes.stale,
      quotaRes.data,
      quotaRes.error,
      quotaRes.loading,
      quotaRes.stale,
      providersRes.data,
      providersRes.error,
      providersRes.loading,
      providersRes.stale,
      gatewayUsageRes.data,
      gatewayUsageRes.error,
      gatewayUsageRes.loading,
      gatewayUsageRes.stale,
      gatewayStatusRes.data,
      gatewayStatusRes.error,
      gatewayStatusRes.loading,
      gatewayStatusRes.stale,
    ],
  );

  const report = useMemo(
    () =>
      buildReportModel({
        range,
        usage: usageRes.data,
        quotaRows: quotaRes.data?.providers ?? null,
        providers: providersRes.data,
        gatewayUsage: gatewayUsageRes.data,
        gatewayStatus: gatewayStatusRes.data,
        gatewayDays,
        sources,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      range,
      gatewayDays,
      usageRes.data,
      quotaRes.data,
      providersRes.data,
      gatewayUsageRes.data,
      gatewayStatusRes.data,
      sources,
    ],
  );

  function changeRange(next: ReturnType<typeof parseRange>) {
    navigate({
      to: '/reports',
      search: (prev) => ({ ...prev, range: next }),
      replace: true,
    });
  }

  function refreshAll() {
    usageRes.refetch();
    quotaRes.refetch();
    providersRes.refetch();
    gatewayUsageRes.refetch();
    gatewayStatusRes.refetch();
  }

  const usageReady = usageRes.data !== null;
  const usage = report.usage;
  const gatewayReady = gatewayUsageRes.data !== null;
  const quotaReady = quotaRes.data !== null;
  const anyData =
    usageReady || gatewayReady || quotaReady || providersRes.data !== null || gatewayStatusRes.data !== null;
  const sourceErrors = sources.filter((source) => source.state === 'error');
  const sourceEmpty = sources.filter((source) => source.state === 'empty');
  const allLoading = sources.every((source) => source.state === 'loading');

  return (
    <div className="reports-page flex flex-col gap-4">
      <style>{`@media print {
        .reports-page { background: #fff !important; }
        .reports-page * { box-shadow: none !important; }
        .reports-page .reports-break { break-inside: avoid; page-break-inside: avoid; }
      }`}</style>

      <PageHeader
        title="报表"
        description={
          <>
            跨 OpenCode 用量、额度、Provider 与网关的只读汇总。口径严格分开：steps ≠ HTTP 请求，
            cost ≠ 积分余额，额度不跨厂商求和。明细页：
            <Link to="/usage" className="ml-1 text-primary underline-offset-4 hover:underline">
              用量
            </Link>
            {' · '}
            <Link to="/quota" className="text-primary underline-offset-4 hover:underline">
              额度
            </Link>
            {' · '}
            <Link to="/gateway/usage" className="text-primary underline-offset-4 hover:underline">
              网关用量
            </Link>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <RangeSwitch value={range} onChange={changeRange} />
            <Button size="sm" variant="outline" onClick={refreshAll}>
              <RefreshCw className="size-4" />
              刷新全部
            </Button>
          </div>
        }
      />

      {rangeInvalid ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
          <Badge variant="warning">URL 参数已回退默认值</Badge>
          <span>range 仅支持 24h / 7d / 30d / all；已按近 7 天展示。</span>
        </div>
      ) : null}

      {sourceErrors.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" />
          {sourceErrors.map((source) => `${source.label}：${source.detail ?? '读取失败'}`).join('；')}
        </div>
      ) : null}

      {allLoading ? (
        <LoadingState label="正在汇总 OpenCode 用量、额度、Provider 与网关数据…" />
      ) : !anyData ? (
        <Empty
          title="还没有可汇总的数据"
          description="五个只读数据源都没有返回数据；空状态不等于 0 消耗。可稍后刷新。"
        />
      ) : null}

      <Card className="reports-break">
        <CardHeader>
          <CardTitle>报告摘要</CardTitle>
          <CardDescription>
            范围 <span className="text-foreground">{report.rangeLabel}</span> · 生成时间{' '}
            <span className="tabular-nums text-foreground">{fmtDateTime(report.generatedAt)}</span> ·
            网关窗口近 {gatewayDays} 天
          </CardDescription>
          <CardAction>
            <Exports model={report} disabled={!anyData} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">数据源</span>
            {sources.map((source) => (
              <Badge key={source.key} variant={SOURCE_VARIANT[source.state]} title={source.detail}>
                {source.label}：{SOURCE_TEXT[source.state]}
              </Badge>
            ))}
            {sourceEmpty.length ? (
              <span className="text-[11px] text-muted-foreground">
                （空 = 查询成功但没有数据，不代表 0）
              </span>
            ) : null}
          </div>

          {allLoading ? (
            <p className="text-xs text-muted-foreground">等待数据源返回后生成结论…</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-xs">
              {report.conclusions.map((conclusion, i) => (
                <li key={`${conclusion.text}-${i}`} className="flex items-start gap-2">
                  <ConclusionIcon tone={conclusion.tone} />
                  <span
                    className={cn(
                      conclusion.tone === 'warning'
                        ? 'text-warning'
                        : conclusion.tone === 'destructive'
                          ? 'text-destructive'
                          : conclusion.tone === 'success'
                            ? 'text-success'
                            : 'text-muted-foreground',
                    )}
                  >
                    {conclusion.text}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {report.range === 'all' ? (
            <p className="text-[11px] text-muted-foreground">
              网关用量按自然日分片，桥接上限 90 天；选择「全部历史」时网关部分只覆盖近 90 天，页面已明确标注。
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="会话 / 步骤"
          value={
            <span className="tabular-nums">
              {usageReady ? fmtInt(usage.sessions) : DASH} / {usageReady ? fmtInt(usage.steps) : DASH}
            </span>
          }
          sub={`提示 ${usageReady ? fmtInt(usage.prompts) : DASH} · 网关请求 ${
            gatewayReady ? fmtInt(report.gateway.totals.requests) : DASH
          }（独立口径）`}
          hint="steps ≠ HTTP 请求数"
        />
        <MetricCard
          label="Token 构成"
          value={usageReady ? fmtCompact(usage.tokens.composition) : DASH}
          sub={
            <span className="tabular-nums">
              入 {usageReady ? fmtCompact(usage.tokens.input) : DASH} · 出{' '}
              {usageReady ? fmtCompact(usage.tokens.output) : DASH} · 推{' '}
              {usageReady ? fmtCompact(usage.tokens.reasoning) : DASH}
            </span>
          }
          hint={`缓存读 ${usageReady ? fmtCompact(usage.tokens.cacheRead) : DASH} · 缓存写 ${
            usageReady ? fmtCompact(usage.tokens.cacheWrite) : DASH
          }（另计）`}
        />
        <MetricCard
          label="上报成本"
          value={usageReady && usage.cost > 0 ? fmtNumber(usage.cost) : DASH}
          sub={usageReady && usage.cost > 0 ? 'OpenCode 上报值' : '—（OpenCode 未上报）'}
          hint="不等于积分余额，不折算、不跨厂商求和"
        />
        <MetricCard
          label="活跃 / 连续"
          value={
            <span className="tabular-nums">
              {usageReady ? fmtInt(usage.activeDays) : DASH} / {usageReady ? fmtInt(usage.streak) : DASH}
            </span>
          }
          sub="活跃天数 / 连续活跃天数"
          hint="原样展示，不做趋势推断"
        />
        <MetricCard
          label="工具成功率"
          value={usageReady && usage.tools ? fmtPercent(usage.tools.rate, 1) : DASH}
          sub={
            usageReady && usage.tools
              ? `成功 ${fmtInt(usage.tools.succeeded)} · 失败 ${fmtInt(usage.tools.failed)} · 未完成 ${fmtInt(usage.tools.pending)}`
              : '无工具调用数据'
          }
          hint="不代表模型请求成功率"
          tone={usage.tools && usage.tools.rate < 0.8 ? 'warning' : 'default'}
        />
        <MetricCard
          label="额度覆盖"
          value={
            quotaReady && report.quota.coverage.ratio !== null
              ? fmtPercent(report.quota.coverage.ratio, 0)
              : DASH
          }
          sub={`${quotaReady ? report.quota.coverage.available : DASH} / ${
            quotaReady ? report.quota.coverage.total : DASH
          } 家可查`}
          hint="只统计来源可用性，不跨厂商求和"
          tone={report.quota.alerts.length ? 'warning' : 'default'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="reports-break xl:col-span-2">
          <ReportActivityChart
            points={usage.daily}
            dailyTokens={usage.dailyTokensAvailable}
            range={range}
          />
        </div>
        <div className="reports-break">
          <ProviderTopTable rows={usage.providerRows} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="reports-break xl:col-span-2">
          <ModelTopTable rows={usage.modelRows} />
        </div>
        <div className="reports-break">
          <GatewaySnapshotCard gateway={report.gateway} available={gatewayReady} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="reports-break">
          <ProviderMatrixCard rows={report.providers} />
        </div>
        <div className="reports-break">
          <QuotaSnapshotCard
            coverage={report.quota.coverage}
            alerts={report.quota.alerts}
            providers={report.quota.providers}
            workbuddyDays={report.quota.workbuddyDays}
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground print:text-black">
        导出：CSV 含 KPI、OpenCode 按日 / provider / 模型、网关按日与 Provider、额度桶与 Provider 状态；
        JSON 为结构化汇总。所有导出都在浏览器内生成，不上传任何数据。
      </p>
    </div>
  );
}