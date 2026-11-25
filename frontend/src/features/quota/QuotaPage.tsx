import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, ArrowDownUp, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MetricCard } from '@/components/shared/metric-card';
import { PageHeader } from '@/components/shared/page-header';
import { ProviderSelect } from '@/components/shared/provider-select';
import { DataState } from '@/components/shared/states';
import { ProviderChip, TimeText } from '@/components/shared/status';
import type { QuotaBucket, QuotaRow } from '@/lib/contract';
import { DASH, fmtNumber, fmtPercent } from '@/lib/format';
import { cn } from '@/lib/cn';
import { clampText } from '@/lib/redact';
import { useProviders, useQuota } from '@/lib/query';
import { QuotaGauge } from './QuotaGauge';
import {
  DEFAULT_QUOTA_SORT,
  accountCount,
  checkinBadge,
  countQuotaFilters,
  filterQuotaRows,
  isWorkBuddyProvider,
  normalizeQuotaRow,
  quotaCoverage,
  rowIssueCount,
  rowStatus,
  sortQuotaRows,
  sourceLabel,
  summarizeQuota,
  type QuotaFilter,
  type QuotaProviderLayer,
  type QuotaSort,
  type QuotaSortKey,
} from './quota-model';

const FILTERS: Array<{ value: QuotaFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'available', label: '可查' },
  { value: 'unavailable', label: '不可用' },
  { value: 'issue', label: '需处理' },
];

const SORT_OPTIONS: Array<{ value: QuotaSortKey; label: string }> = [
  { value: 'severity', label: '问题优先' },
  { value: 'title', label: '名称' },
  { value: 'fetched', label: '采集时间' },
];

/** 页面级 `r` 刷新（对齐 03 §5.5）：输入/弹层聚焦时不触发。 */
function useRefreshHotkey(refetch: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (el?.closest('[role="dialog"],[role="listbox"],[role="menu"],[role="combobox"]')) return;
      e.preventDefault();
      refetch();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refetch]);
}

/** 倒计时用的低频时钟（30s），不制造每秒重渲染。 */
function useTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function serviceText(running: boolean | undefined): string {
  if (running === true) return '服务在线';
  if (running === false) return '服务未运行';
  return '服务状态未知';
}

function RowStatusBadge({ row }: { row: QuotaProviderLayer }) {
  const status = rowStatus(row);
  if (status === 'unavailable') {
    return <Badge variant="destructive">不可用</Badge>;
  }
  if (status === 'error') return <Badge variant="destructive">采集失败</Badge>;
  if (status === 'issue') {
    return <Badge variant="warning">需处理 {rowIssueCount(row)}</Badge>;
  }
  return <Badge variant="success">正常</Badge>;
}

/** 签到：能力由后端决定；统一签到命令尚未接入，故只读说明（不发明 ActionName）。 */
function CheckinLine({ checkin }: { checkin: QuotaRow['checkin'] }) {
  if (!checkin) return null;
  const reward = typeof checkin.rewardCredits === 'number' ? checkin.rewardCredits : null;

  if (checkin.supported && checkin.claimable) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 p-2 text-xs">
        <span className="font-medium text-warning">
          签到可领取{reward !== null ? ` ${fmtNumber(reward)} credits` : ''}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled
          title="尚未接入统一签到命令"
          aria-disabled="true"
        >
          签到
        </Button>
        <span className="text-muted-foreground">尚未接入统一签到命令，暂只能到原生终端执行</span>
        {checkin.note ? <span className="text-muted-foreground">（{checkin.note}）</span> : null}
      </div>
    );
  }

  if (checkin.supported) {
    return (
      <div className="text-xs text-muted-foreground">
        签到：{checkin.claimed ? '今日已签到' : '当前不可领取'}
        {checkin.note ? `（${checkin.note}）` : ''}
      </div>
    );
  }

  return (
    <div className="text-xs text-muted-foreground">
      签到：不支持{checkin.note ? `（${checkin.note}）` : ''}
    </div>
  );
}

function BucketGrid({
  buckets,
  baseIso,
  workbuddy,
  now,
}: {
  buckets: QuotaBucket[];
  baseIso: string | null;
  workbuddy: boolean;
  now: number;
}) {
  if (!buckets.length) {
    return <div className="text-xs text-muted-foreground">没有可展示的额度桶</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {buckets.map((bucket) => (
        <QuotaGauge
          key={bucket.id}
          bucket={bucket}
          baseIso={baseIso}
          workbuddy={workbuddy}
          now={now}
        />
      ))}
    </div>
  );
}

function ProviderQuotaCard({
  row,
  baseFetchedAt,
  now,
}: {
  row: QuotaProviderLayer;
  baseFetchedAt: string | null;
  now: number;
}) {
  const workbuddy = isWorkBuddyProvider(row.provider, row.kind);
  const accountBuckets = row.accounts.some((a) => a.buckets.length > 0);
  const rowFetchedAt = row.fetchedAt ?? baseFetchedAt;
  const checkin = checkinBadge(row.checkin);

  return (
    // 不加 h-full：网格 `items-start` 后短卡保持自身高度，避免被同行的长卡拉出大片空白。
    <Card className="flex flex-col">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* 卡片头部只显示名称（title 保留 id）；完整 id 仍在账号页/详情里可查。 */}
          <ProviderChip id={row.provider} title={row.title} compact />
          {/* kind 与 provider/名称相同时不重复渲染（同一来源两遍没有信息量）。 */}
          {row.kind && row.kind !== row.provider && row.kind !== row.title ? (
            <span className="font-mono text-[11px] text-muted-foreground">{row.kind}</span>
          ) : null}
          <RowStatusBadge row={row} />
          {workbuddy ? <Badge variant="info">凭证有效期</Badge> : null}
          {checkin ? <Badge variant={checkin.variant}>{checkin.label}</Badge> : null}
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              采集 <TimeText iso={rowFetchedAt} />
            </span>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/accounts" search={{ provider: row.provider }}>
                账号页
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span
            className={
              row.serviceRunning === true
                ? 'text-success'
                : row.serviceRunning === false
                  ? 'text-warning'
                  : 'text-muted-foreground'
            }
          >
            {serviceText(row.serviceRunning)}
          </span>
          <span>
            账号{' '}
            <span className="font-mono text-foreground">
              {row.account ?? (accountCount(row) ? `${accountCount(row)} 个` : DASH)}
            </span>
          </span>
          {workbuddy ? (
            <span className="whitespace-nowrap" title="WorkBuddy 的凭证剩余天数按「天」独立成桶，不与 credits 相加">
              凭证剩余天数（天）独立展示，不并入 credits
            </span>
          ) : null}
        </div>
        {!accountBuckets && row.accounts.length ? (
          <div className="text-xs text-muted-foreground">
            账号明细：<span className="text-foreground">{row.accounts.map((account) => account.label).join('、')}</span>
          </div>
        ) : null}

        {!row.available ? (
          <div className="text-xs text-destructive">
            不可用{row.reason ? `：${row.reason}` : ''}
            {row.detail ? ` · ${row.detail}` : ''}
          </div>
        ) : null}
        {row.error ? (
          <div className="text-xs text-destructive">采集失败：{clampText(row.error, 200)}</div>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {accountBuckets ? (
          <div className="flex flex-col gap-3">
            {row.accounts.map((account, i) => (
              <section
                key={account.id}
                className={cn('flex flex-col gap-2', i > 0 ? 'border-t border-border pt-3' : '')}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="inline-flex items-center gap-2 font-medium">
                    {account.label}
                    {!account.available ? <Badge variant="destructive">不可用</Badge> : null}
                  </span>
                  <span className="font-mono text-muted-foreground">{account.account ?? account.id}</span>
                </div>
                {!account.available ? (
                  <div className="text-xs text-destructive">
                    不可用{account.reason ? `：${account.reason}` : ''}
                    {account.detail ? ` · ${account.detail}` : ''}
                  </div>
                ) : null}
                {account.error ? (
                  <div className="text-xs text-destructive">采集失败：{clampText(account.error, 200)}</div>
                ) : null}
                <BucketGrid
                  buckets={account.buckets}
                  baseIso={rowFetchedAt}
                  workbuddy={workbuddy}
                  now={now}
                />
              </section>
            ))}
          </div>
        ) : (
          <BucketGrid buckets={row.buckets} baseIso={rowFetchedAt} workbuddy={workbuddy} now={now} />
        )}

        <div className="mt-auto">
          <CheckinLine checkin={row.checkin} />
        </div>
      </CardContent>
    </Card>
  );
}

export function QuotaPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const rawProvider = typeof search.provider === 'string' && search.provider ? search.provider : undefined;
  const navigate = useNavigate();
  const now = useTick();

  const providersRes = useProviders();
  const knownProviders = providersRes.data ?? [];
  const providerUnknown =
    Boolean(rawProvider) && knownProviders.length > 0 && !knownProviders.some((p) => p.id === rawProvider);
  // 非法 provider 回退为「全部」，并按下方提示告知一次，不静默丢弃。
  const provider = providerUnknown ? undefined : rawProvider;

  const res = useQuota(provider);
  const [filter, setFilter] = useState<QuotaFilter>('all');
  const [sort, setSort] = useState<QuotaSort>(DEFAULT_QUOTA_SORT);

  const setProvider = useCallback(
    (next?: string) => {
      const nextSearch: Record<string, unknown> = { ...search };
      if (next) nextSearch.provider = next;
      else delete nextSearch.provider;
      void navigate({ to: '/quota', search: nextSearch, replace: true });
    },
    [navigate, search],
  );

  const refetch = res.refetch;
  useRefreshHotkey(refetch);

  const options = useMemo(() => {
    const fromProviders = (providersRes.data ?? [])
      .filter((p) => !p.overlay)
      .map((p) => ({ id: p.id, title: p.title, overlay: p.overlay }));
    if (fromProviders.length) return fromProviders;
    const seen = new Map<string, string>();
    for (const row of res.data?.providers ?? []) seen.set(row.provider, row.title);
    return [...seen].map(([id, title]) => ({ id, title }));
  }, [providersRes.data, res.data]);

  const layers = useMemo(
    () => (res.data?.providers ?? []).map(normalizeQuotaRow),
    [res.data],
  );
  const summary = useMemo(() => summarizeQuota(layers), [layers]);
  const coverage = useMemo(() => quotaCoverage(layers), [layers]);
  const counts = useMemo(() => countQuotaFilters(layers), [layers]);
  const visible = useMemo(
    () => sortQuotaRows(filterQuotaRows(layers, filter), sort),
    [layers, filter, sort],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="额度"
        description="provider → 账号 → 额度桶三层展开；数字用原单位，未知显示 —；不做跨厂商汇总。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ProviderSelect
              providers={options}
              value={provider}
              onChange={setProvider}
              className="w-44"
            />
            <Button size="sm" variant="outline" onClick={refetch}>
              <RefreshCw />
              刷新
            </Button>
          </div>
        }
      />

      {providerUnknown ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
          <Badge variant="warning">URL 参数已回退默认值</Badge>
          <span>provider「{rawProvider}」不在已知清单；已按「全部 provider」展示。</span>
        </div>
      ) : null}

      <DataState
        res={res}
        onRetry={refetch}
        loadingLabel="正在读取额度…"
        isEmpty={(payload) => payload.providers.length === 0}
        empty={
          <Empty
            title={provider ? '该 provider 没有额度数据' : '没有可展示的额度桶'}
            description="查询成功但没有返回额度桶，这不等于查询失败；可刷新或切换 provider。"
          />
        }
      >
        {(payload) => {
          return (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <MetricCard
                  label="可查来源数"
                  value={`${summary.sources} / ${summary.total}`}
                  sub="available=true 的来源"
                />
                <MetricCard
                  label="额度覆盖"
                  value={coverage.ratio === null ? DASH : fmtPercent(coverage.ratio, 0)}
                  sub={`${coverage.available} / ${coverage.total} 家可查`}
                  hint="只统计来源可用性，不跨厂商求和"
                />
                <MetricCard
                  label="需处理提醒数"
                  value={summary.alerts.length}
                  tone={summary.alerts.length ? 'warning' : 'default'}
                  sub={summary.alerts.length ? '见下方提醒清单' : '无需处理'}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  来源采集时间：<TimeText iso={payload.fetchedAt} />
                </span>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  桥接接收：<TimeText iso={res.lastSuccessAt} />
                </span>
                <span aria-hidden>·</span>
                <span>数据来源：{sourceLabel(payload.source)}</span>
              </div>

              {summary.alerts.length ? (
                <Card>
                  <CardContent className="flex flex-col gap-1 p-3 text-xs">
                    {summary.alerts.map((alert, i) => (
                      <div key={`${alert}-${i}`} className="flex items-center gap-2 text-warning">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        {alert}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  role="group"
                  aria-label="按状态筛选额度"
                  className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs"
                >
                  {FILTERS.map((item) => {
                    const active = filter === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setFilter(item.value)}
                        className={cn(
                          'rounded-md px-2.5 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                          active
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {item.label}
                        <span className="ml-1 tabular-nums opacity-70">{counts[item.value]}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2">
                  <Select
                    value={sort.key}
                    onValueChange={(value) => setSort((prev) => ({ ...prev, key: value as QuotaSortKey }))}
                  >
                    <SelectTrigger className="w-32" aria-label="额度排序方式">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SORT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={sort.dir === 'desc' ? '当前降序，点击改为升序' : '当前升序，点击改为降序'}
                    onClick={() => setSort((prev) => ({ ...prev, dir: prev.dir === 'desc' ? 'asc' : 'desc' }))}
                  >
                    <ArrowDownUp className="size-4" />
                    {sort.dir === 'desc' ? '降序' : '升序'}
                  </Button>
                </div>
              </div>

              {visible.length ? (
                <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {visible.map((row) => (
                    <ProviderQuotaCard
                      key={row.provider}
                      row={row}
                      baseFetchedAt={payload.fetchedAt}
                      now={now}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  title={filter === 'issue' ? '当前没有需处理的来源' : '当前筛选下没有来源'}
                  description="调整状态筛选或切换 provider 可查看其余额度桶。"
                />
              )}
            </div>
          );
        }}
      </DataState>
    </div>
  );
}