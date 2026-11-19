import { useCallback } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { useEnv, useGatewayStatus, useProviders, useQuota, useUsage } from '@/lib/query';
import { DataSourceBar, type DataSource } from './DataSourceBar';
import { AttentionList } from './AttentionList';
import { ProviderDetailSheet } from './ProviderDetailSheet';
import { ProviderFilters, ProviderTable } from './ProviderTable';
import { SummaryStrip } from './SummaryStrip';
import { UsageKpiCards } from './KpiCards';
import {
  buildQuotaIndex,
  filterProviders,
  isSortDir,
  isSortKey,
  sortProviders,
  usageHasData,
} from './overview-model';

/**
 * 总览页（页面 ID `overview`，路由 `/`，FR-101–109）。
 *
 * 结构：数据时间条 → 近 7 天用量 KPI（与 /usage 同源）→ provider 汇总条 →
 * 筛选 → provider 表（四态 + 漂移 + 额度摘要 + 跨页跳转）→ 选中行详情抽屉。
 * 本页只读：不渲染任何写操作控件，异常只给「下一步」跳转。
 */
export function OverviewPage() {
  const env = useEnv();
  const providers = useProviders();
  const quota = useQuota();
  const usage = useUsage('7d');
  const gateway = useGatewayStatus();
  const navigate = useNavigate();

  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const providerParam =
    typeof search.provider === 'string' && search.provider.length > 0 ? search.provider : undefined;
  const q = typeof search.q === 'string' ? search.q : '';
  const sortKey = isSortKey(search.sort) ? search.sort : 'id';
  const sortDir = isSortDir(search.dir) ? search.dir : 'asc';
  // 详情抽屉由 `panel=provider` 打开（对齐 03 界面设计 §2）；`provider` 承担筛选与选中。
  const detailOpen = search.panel === 'provider' && Boolean(providerParam);

  const patch = useCallback(
    (p: Record<string, unknown>) => {
      void navigate({
        to: '/',
        search: (prev) => {
          const next: Record<string, unknown> = { ...(prev as Record<string, unknown>), ...p };
          for (const k of Object.keys(next)) {
            if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k];
          }
          return next;
        },
        replace: true,
      });
    },
    [navigate],
  );

  const onSort = useCallback(
    (key: typeof sortKey) => {
      if (key === sortKey) patch({ sort: key, dir: sortDir === 'asc' ? 'desc' : 'asc' });
      else patch({ sort: key, dir: 'asc' });
    },
    [patch, sortKey, sortDir],
  );

  const refetchAll = useCallback(() => {
    providers.refetch();
    quota.refetch();
    usage.refetch();
    gateway.refetch();
    env.refetch();
  }, [providers, quota, usage, gateway, env]);

  const quotaIndex = buildQuotaIndex(quota.data);
  const providerList = providers.data ?? [];
  const selectedProvider = providerParam
    ? (providerList.find((p) => p.id === providerParam) ?? null)
    : null;

  const sources: DataSource[] = [
    { label: '服务', lastSuccessAt: providers.lastSuccessAt, stale: providers.stale },
    { label: '额度', lastSuccessAt: quota.lastSuccessAt, stale: quota.stale },
    { label: '用量', lastSuccessAt: usage.lastSuccessAt, stale: usage.stale },
    { label: '网关', lastSuccessAt: gateway.lastSuccessAt, stale: gateway.stale },
    { label: '环境', lastSuccessAt: env.lastSuccessAt, stale: env.stale },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="总览"
        description="八个本机反代 + 统一网关的开关 / 进程 / 客户端 / 认证四态，配置漂移与近 7 天用量 KPI。本页只读。"
        actions={
          <Button variant="outline" size="sm" onClick={refetchAll}>
            <RefreshCw className="size-4" aria-hidden />
            刷新
          </Button>
        }
      />

      <DataSourceBar sources={sources} />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">用量指标 · 近 7 天</h2>
          <Link
            to="/usage"
            search={{ range: '7d' }}
            className="rounded text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            在用量页查看详情
          </Link>
        </div>
        <DataState
          res={usage}
          loadingLabel="正在读取用量统计…"
          isEmpty={(d) => !usageHasData(d)}
          empty={
            <Empty
              title="近 7 天没有会话数据"
              description="OpenCode 统计接口返回为空。这是合法空状态，不是查询失败；不会生成随机曲线或假数值。"
            />
          }
        >
          {(data) => <UsageKpiCards usage={data} />}
        </DataState>
      </div>

      <DataState
        res={providers}
        loadingLabel="正在读取 provider 状态…"
        isEmpty={(d) => d.length === 0}
        empty={
          <Empty
            title="桥接没有返回任何 provider"
            description="检查桥接服务与 router.mjs 的 list --json 输出；网关条目应与八家一起出现。"
          />
        }
      >
        {(data) => {
          const rows = sortProviders(filterProviders(data, q, providerParam), sortKey, sortDir);
          return (
            <div className="flex flex-col gap-3">
              <SummaryStrip providers={data} quotaIndex={quotaIndex} />
              <ProviderFilters
                providers={data}
                q={q}
                provider={providerParam}
                onQ={(v) => patch({ q: v })}
                onProvider={(v) => patch({ provider: v, panel: undefined })}
              />
              <Card>
                <CardContent className="p-0">
                  {rows.length ? (
                    <ProviderTable
                      providers={rows}
                      quotaIndex={quotaIndex}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                      onSelect={(id) => patch({ provider: id, panel: 'provider' })}
                      selectedId={providerParam}
                    />
                  ) : (
                    <Empty
                      className="m-4"
                      title="没有匹配的 provider"
                      description="调整关键词或 provider 筛选后重试。"
                    />
                  )}
                </CardContent>
              </Card>
              <AttentionList
                providers={data}
                quotaError={quota.error}
                onRetryQuota={quota.refetch}
                onSelect={(id) => patch({ provider: id, panel: 'provider' })}
              />
            </div>
          );
        }}
      </DataState>

      <ProviderDetailSheet
        provider={selectedProvider}
        quotaIndex={quotaIndex}
        open={detailOpen}
        onOpenChange={(open) => {
          if (!open) patch({ panel: undefined });
        }}
      />
    </div>
  );
}
