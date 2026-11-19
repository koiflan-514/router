import { useMemo } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/empty';
import { useUsage } from '@/lib/query';
import { DASH, fmtDateTime } from '@/lib/format';
import { ActivityChart } from './ActivityChart';
import { ModelsTable } from './ModelsTable';
import { RangeSwitch } from './RangeSwitch';
import { UsageKpis } from './UsageKpis';
import {
  isSortDir,
  isSortKey,
  isUsageRange,
  isUsageEmpty,
  parseRange,
  parseSort,
  sortModelRows,
  type UsageSort,
} from './usage-model';

/**
 * 用量页（路由 `/usage`）。
 * 口径与设计见 frontend/docs/14-usage-analytics.md；与网关用量 `/gateway/usage` 是两个页面、两套口径。
 */
export function UsagePage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const range = parseRange(search.range);
  const sort = parseSort(search.sort, search.dir);
  const selected = typeof search.model === 'string' ? search.model : '';

  const rangeInvalid =
    typeof search.range === 'string' && search.range !== '' && !isUsageRange(search.range);
  const sortInvalid =
    (typeof search.sort === 'string' && search.sort !== '' && !isSortKey(search.sort)) ||
    (typeof search.dir === 'string' && search.dir !== '' && !isSortDir(search.dir));

  const res = useUsage(range);

  const sortedModels = useMemo(
    () => (res.data ? sortModelRows(res.data.models, sort) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [res.data, sort.key, sort.dir],
  );

  function updateSearch(patch: Record<string, unknown>) {
    // 范围 / 排序 / 选中模型都是“状态变更”，用 replace 避免污染历史。
    void navigate({ to: '/usage', search: (prev) => ({ ...prev, ...patch }), replace: true });
  }

  function handleSort(next: UsageSort) {
    updateSearch({ sort: next.key, dir: next.dir });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="用量"
        description={
          <>
            数据来源 OpenCode 官方会话统计（experimental.session.stats）。本页统计的是 OpenCode 会话，网关转发的
            HTTP 请求请看{' '}
            <Link to="/gateway/usage" className="text-primary underline-offset-4 hover:underline">
              网关用量
            </Link>
            ，两者口径不同、不可相加或换算。
          </>
        }
        actions={
          <>
            <RangeSwitch value={range} onChange={(next) => updateSearch({ range: next })} />
            <span className="text-[11px] text-muted-foreground">
              最后成功 {res.lastSuccessAt ? fmtDateTime(res.lastSuccessAt) : DASH}
            </span>
            <Button variant="outline" size="sm" onClick={() => res.refetch()}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
          </>
        }
      />

      {rangeInvalid || sortInvalid ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
          <Badge variant="warning">URL 参数已回退默认值</Badge>
          <span>
            {rangeInvalid ? `range 仅支持 24h / 7d / 30d / all；` : ''}
            {sortInvalid ? 'sort / dir 取值非法；' : ''}
            已按默认范围与默认排序展示。
          </span>
        </div>
      ) : null}

      <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        steps 是 OpenCode 会话步骤，<span className="text-foreground">不等于 HTTP 请求数</span>
        ；cost 是 OpenCode 上报成本，<span className="text-foreground">不等同积分余额</span>
        ，不折算、不跨厂商求和；工具成功率不代表模型请求成功率。
      </p>

      <DataState
        res={res}
        onRetry={res.refetch}
        loadingLabel="正在读取 OpenCode 用量…"
        isEmpty={isUsageEmpty}
        empty={
          <Empty
            title="该时间范围内没有用量数据"
            description="接口成功返回，但会话、模型与每日活动均为空。可切换时间范围或稍后重试。"
          />
        }
      >
        {(data) => (
          <div className="flex flex-col gap-4">
            <UsageKpis data={data} />
            <ActivityChart data={data} range={range} />
            <ModelsTable
              rows={sortedModels}
              sort={sort}
              onSortChange={handleSort}
              selected={selected}
              onSelect={(key) => updateSearch({ model: key || undefined })}
            />
          </div>
        )}
      </DataState>
    </div>
  );
}
