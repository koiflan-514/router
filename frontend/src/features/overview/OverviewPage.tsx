import { useCallback } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw, SearchX } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { SectionHeader, Toolbar } from '@/components/shared/surface';
import { DataState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/empty';
import { useEnv, useGatewayStatus, useProviders, useQuota, useUsage } from '@/lib/query';
import { DataSourceBar, type DataSource } from './DataSourceBar';
import { AttentionList } from './AttentionList';
import { OverviewAside } from './OverviewAside';
import { OverviewKpiTiles, Usage7dPanel } from './OverviewKpi';
import { ProviderDetailSheet } from './ProviderDetailSheet';
import { ProviderFilters, ProviderTable } from './ProviderTable';
import { SummaryStrip } from './SummaryStrip';
import { TopologyFlow } from './TopologyFlow';
import { UsageKpiCards } from './KpiCards';
import {
  buildQuotaIndex,
  deriveSummary,
  filterProviders,
  isSortDir,
  isSortKey,
  sortProviders,
  usageHasData,
} from './overview-model';

/**
 * 总览页（页面 ID `overview`，路由 `/`，FR-101–109）。
 *
 * Fluent 布局：
 * 1. 页头（标题 + 只读说明 + 刷新）
 * 2. 四个 KPI 瓦片（运行/漂移/认证/可领取）
 * 3. 服务拓扑流向条（来源 → 网关 → 客户端，纯展示）
 * 4. 主区两栏：左 = provider 矩阵（筛选/排序/详情抽屉），右 = 健康度/额度/用量/待处理
 *    宽屏(≥1280px) 并排，窄屏自动折叠到主区下方
 * 5. 底部：近 7 天用量 KPI（与 /usage 同源）与异常入口
 *
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

  const summary = deriveSummary(providerList);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="概览"
        title="总览"
        description="十三家本机反代 + 统一网关的开关 / 进程 / 客户端 / 认证四态，配置漂移与近 7 天用量。本页只读，操作请前往对应功能页。"
        actions={
          <>
            <Badge variant="outline" className="h-6">
              只读视图
            </Badge>
            <Button variant="secondary" size="sm" onClick={refetchAll}>
              <RefreshCw className="size-4" aria-hidden />
              刷新
            </Button>
          </>
        }
      />

      <DataSourceBar sources={sources} />

      <OverviewKpiTiles
        providers={providerList}
        quota={quota.data}
        usage={usage.data}
      />

      <DataState res={providers} loadingLabel="正在读取 provider 状态…" isEmpty={(d) => d.length === 0} empty={null}>
        {(data) => <TopologyFlow providers={data} />}
      </DataState>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        {/* 主区：provider 矩阵 */}
        <section aria-label="provider 状态矩阵" className="flex min-w-0 flex-col gap-3">
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
                <>
                  <SummaryStrip providers={data} quotaIndex={quotaIndex} />
                  <div className="layer-1 flex flex-col overflow-hidden">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-stroke-1 px-3 py-2">
                      <SectionHeader
                        as="h3"
                        density="compact"
                        title="Provider 矩阵"
                        description={`已启用 ${summary.enabled} / ${summary.total} · 漂移 ${summary.drifted} · 认证告警 ${summary.authIssues}`}
                        className="min-w-0 flex-1"
                      />
                      <ProviderFilters
                        providers={data}
                        q={q}
                        provider={providerParam}
                        onQ={(v) => patch({ q: v })}
                        onProvider={(v) => patch({ provider: v, panel: undefined })}
                      />
                    </div>
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
                        className="m-3"
                        size="compact"
                        icon={<SearchX />}
                        title="没有匹配的 provider"
                        description="调整关键词或 provider 筛选后重试。"
                        action={
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              patch({ q: undefined, provider: undefined, panel: undefined });
                            }}
                          >
                            清除筛选
                          </Button>
                        }
                      />
                    )}
                  </div>
                  <AttentionList
                    providers={data}
                    quotaError={quota.error}
                    onRetryQuota={quota.refetch}
                    onSelect={(id) => patch({ provider: id, panel: 'provider' })}
                  />
                </>
              );
            }}
          </DataState>
        </section>

        {/* 右侧：健康度 / 额度 / 用量 / 待处理（窄屏落在主区下方） */}
        <OverviewAside
          providers={providerList}
          quota={quota.data}
          quotaError={Boolean(quota.error)}
          usage={usage.data}
          onSelect={(id) => patch({ provider: id, panel: 'provider' })}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-ramp-16 font-semibold tracking-tight">用量指标 · 近 7 天</h2>
          <Link
            to="/usage"
            search={{ range: '7d' }}
            className="rounded text-[12px] text-accent-rest underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
          {(data) => (
            <div className="flex flex-col gap-3">
              <UsageKpiCards usage={data} />
              <div className="layer-1 p-3.5">
                <Usage7dPanel usage={data} />
              </div>
            </div>
          )}
        </DataState>
      </div>

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
