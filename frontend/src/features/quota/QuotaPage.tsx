import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { MetricCard } from '@/components/shared/metric-card';
import { PageHeader } from '@/components/shared/page-header';
import { ProviderSelect } from '@/components/shared/provider-select';
import { QuotaBar } from '@/components/shared/quota-bar';
import { DataState } from '@/components/shared/states';
import { ProviderChip, TimeText } from '@/components/shared/status';
import type { QuotaBucket, QuotaRow } from '@/lib/contract';
import { DASH, fmtDate, fmtNumber } from '@/lib/format';
import { clampText } from '@/lib/redact';
import { useProviders, useQuota } from '@/lib/query';
import {
  bucketExpiryIso,
  fmtUtcDateTime,
  isDaysBucket,
  isDerivedExpiry,
  isWorkBuddyProvider,
  normalizeQuotaRow,
  rowHasIssue,
  sourceLabel,
  summarizeQuota,
  workbuddyBucketLabel,
  type QuotaProviderLayer,
} from './quota-model';

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

function serviceText(running: boolean | undefined): string {
  if (running === true) return '服务在线';
  if (running === false) return '服务未运行';
  return '服务状态未知';
}

/** 单个额度桶：credits/tokens 画条；`days` 只给天数与 UTC 到期日。 */
function BucketBlock({
  bucket,
  baseIso,
  workbuddy,
}: {
  bucket: QuotaBucket;
  baseIso: string | null;
  workbuddy: boolean;
}) {
  if (isDaysBucket(bucket)) {
    const expiry = bucketExpiryIso(bucket, baseIso);
    const derived = expiry !== null && isDerivedExpiry(bucket);
    return (
      <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/20 p-2 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium">
            {workbuddy ? workbuddyBucketLabel(bucket) : bucket.label || '凭证有效期'}
          </span>
          <span className="tabular-nums">
            {typeof bucket.remaining === 'number' ? `${fmtNumber(bucket.remaining)} 天` : DASH}
          </span>
        </div>
        <div className="text-muted-foreground">
          到期 {expiry ? fmtUtcDateTime(expiry) : DASH}
          {derived ? '（按采集时间 + 剩余天数推算）' : ''}
          <span className="mx-1">·</span>天数不并入 credits 汇总
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <QuotaBar bucket={bucket} />
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {typeof bucket.used === 'number' ? (
          <span>
            已用 {fmtNumber(bucket.used)} {bucket.unit}
          </span>
        ) : null}
        {bucket.resetDate ? <span>重置 {fmtDate(bucket.resetDate)}</span> : null}
        {typeof bucket.expiring === 'number' && bucket.expiring > 0 ? (
          <span className="text-warning">
            即将过期 {fmtNumber(bucket.expiring)} {bucket.unit}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 签到：能力由后端决定；统一签到命令尚未接入，故只读说明（不发明 ActionName）。 */
function CheckinLine({ checkin }: { checkin: QuotaRow['checkin'] }) {
  if (!checkin) return null;
  const reward = typeof checkin.rewardCredits === 'number' ? checkin.rewardCredits : null;

  if (checkin.supported && checkin.claimable) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
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

function ProviderQuotaCard({ row, baseFetchedAt }: { row: QuotaProviderLayer; baseFetchedAt: string | null }) {
  const workbuddy = isWorkBuddyProvider(row.provider, row.kind);
  const accountBuckets = row.accounts.some((a) => a.buckets.length > 0);
  const rowFetchedAt = row.fetchedAt ?? baseFetchedAt;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ProviderChip id={row.provider} title={row.title} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {workbuddy ? <Badge variant="info">凭证有效期</Badge> : null}
            {row.available ? (
              <Badge variant="success">可查</Badge>
            ) : (
              <Badge variant="destructive">不可用</Badge>
            )}
            {row.error ? <Badge variant="destructive">采集失败</Badge> : null}
            <span className="inline-flex items-center gap-1">
              来源采集 <TimeText iso={rowFetchedAt} />
            </span>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/accounts" search={{ provider: row.provider }}>
                账号页
              </Link>
            </Button>
          </div>
        </div>
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
      <CardContent className="flex flex-col gap-3">
        {workbuddy ? (
          <div className="text-xs text-muted-foreground">{serviceText(row.serviceRunning)} · 凭证有效期</div>
        ) : null}

        {accountBuckets ? (
          row.accounts.map((account) => (
            <div key={account.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium">{account.label}</span>
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
              {account.buckets.length ? (
                account.buckets.map((bucket) => (
                  <BucketBlock
                    key={bucket.id}
                    bucket={bucket}
                    baseIso={rowFetchedAt}
                    workbuddy={workbuddy}
                  />
                ))
              ) : (
                <div className="text-xs text-muted-foreground">没有可展示的额度桶</div>
              )}
            </div>
          ))
        ) : row.buckets.length ? (
          <>
            {row.account ? (
              <div className="text-xs text-muted-foreground">
                账号 <span className="font-mono">{row.account}</span>
              </div>
            ) : null}
            {row.buckets.map((bucket) => (
              <BucketBlock key={bucket.id} bucket={bucket} baseIso={rowFetchedAt} workbuddy={workbuddy} />
            ))}
          </>
        ) : (
          <div className="text-xs text-muted-foreground">没有可展示的额度桶</div>
        )}

        {workbuddy ? (
          <div className="text-[11px] text-muted-foreground">
            此来源没有可比较的 credits 余额；凭证 / 续期天数不并入积分口径。
          </div>
        ) : null}

        <CheckinLine checkin={row.checkin} />
      </CardContent>
    </Card>
  );
}

export function QuotaPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const rawProvider = typeof search.provider === 'string' && search.provider ? search.provider : undefined;
  const navigate = useNavigate();

  const providersRes = useProviders();
  const knownProviders = providersRes.data ?? [];
  const providerUnknown =
    Boolean(rawProvider) && knownProviders.length > 0 && !knownProviders.some((p) => p.id === rawProvider);
  // 非法 provider 回退为「全部」，并按下方提示告知一次，不静默丢弃。
  const provider = providerUnknown ? undefined : rawProvider;

  const res = useQuota(provider);
  const [onlyIssues, setOnlyIssues] = useState(false);

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
  const visible = onlyIssues ? layers.filter(rowHasIssue) : layers;

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
            <Button
              size="sm"
              variant={onlyIssues ? 'default' : 'outline'}
              aria-pressed={onlyIssues}
              onClick={() => setOnlyIssues((v) => !v)}
            >
              仅看需处理
            </Button>
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <MetricCard
                  label="可查来源数"
                  value={`${summary.sources} / ${summary.total}`}
                  sub="available=true 的来源"
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

              {visible.length ? (
                visible.map((row) => (
                  <ProviderQuotaCard key={row.provider} row={row} baseFetchedAt={payload.fetchedAt} />
                ))
              ) : (
                <Empty
                  title="当前没有被标记为需处理的来源"
                  description="“仅看需处理”已开启；关闭筛选可查看全部额度桶。"
                />
              )}
            </div>
          );
        }}
      </DataState>
    </div>
  );
}
