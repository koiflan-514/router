import { Link } from '@tanstack/react-router';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { RingGauge, Sparkline } from '@/components/shared/charts';
import { SectionHeader, Surface } from '@/components/shared/surface';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { DASH, fmtInt } from '@/lib/format';
import type { ProviderStatus, QuotaRow, UsageStats } from '@/lib/contract';
import { providerColorVar } from '@/lib/provider';
import type { QuotaPayload } from '@/lib/query';
import {
  activityValues,
  attentionItems,
  deriveHealth,
  quotaBarFor,
  quotaTop,
} from './overview-model';

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Surface level={1} padding="none" className="flex flex-col gap-3 p-3.5">
      <SectionHeader title={title} description={description} density="compact" actions={action} />
      {children}
    </Surface>
  );
}

/** 健康度：环形总分 + 四项达标条形（阈值由分数决定，组件不猜）。 */
function HealthPanel({ providers }: { providers: ProviderStatus[] }) {
  const h = deriveHealth(providers);
  const color =
    h.score === null
      ? 'var(--text-tertiary)'
      : h.score >= 80
        ? 'var(--success)'
        : h.score >= 50
          ? 'var(--warning)'
          : 'var(--destructive)';
  const bars = [
    { label: '进程运行', n: h.running },
    { label: '认证正常', n: h.authOk },
    { label: '客户端已写入', n: h.clientSynced },
    { label: '无漂移', n: h.noDrift },
  ];
  return (
    <Panel title="健康度" description={`受管条目 ${fmtInt(h.managed)} 项（不含网关叠加层）；四项达标率均值`}>
      <div className="flex items-center gap-4">
        <RingGauge
          value={h.score}
          color={color}
          label="健康度"
          size={92}
          caption={h.score === null ? '无受管条目' : '四项均值'}
        />
        <dl className="flex min-w-0 flex-1 flex-col gap-2">
          {bars.map((b) => {
            const pct = h.managed > 0 ? (b.n / h.managed) * 100 : null;
            return (
              <div key={b.label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1">
                <dt className="text-[11px] text-text-secondary">{b.label}</dt>
                <dd className="text-right text-[11px] tabular-nums text-text-primary">
                  {fmtInt(b.n)} / {fmtInt(h.managed)}
                </dd>
                <dd className="col-span-2">
                  {pct === null ? (
                    <span className="text-[10px] text-text-tertiary">{DASH}</span>
                  ) : (
                    <Progress value={pct} aria-label={`${b.label}达标率`} aria-valuetext={`${Math.round(pct)}%`} />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </Panel>
  );
}

/** 额度 Top：按剩余占比排序，展示前若干条；只读，点击跳到额度页。 */
function QuotaTopPanel({ payload, error }: { payload: QuotaPayload | null; error: boolean }) {
  const rows = quotaTop(payload, 5);
  return (
    <Panel
      title="额度 Top"
      description="按剩余占比降序；未提供总量的来源不画占比"
      action={
        <Link
          to="/quota"
          className="inline-flex items-center gap-1 rounded text-[11px] text-accent-rest underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          额度页 <ArrowRight aria-hidden className="size-3" />
        </Link>
      }
    >
      {error ? (
        <p className="text-[11px] text-destructive">额度数据读取失败，无法排序。</p>
      ) : rows.length === 0 ? (
        <Empty size="compact" title="没有额度数据" description="额度接口尚未返回任何来源。" />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <li key={r.provider} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: providerColorVar(r.provider) }}
                  />
                  <span className="truncate text-text-primary">{r.title}</span>
                </span>
                <span className="shrink-0 tabular-nums text-text-secondary">
                  {r.ratio === null ? '—' : `${Math.round(r.ratio * 100)}%`}
                </span>
              </div>
              {r.ratio === null ? (
                <span className="truncate text-[10px] text-text-tertiary" title={r.text}>
                  {r.text}
                </span>
              ) : (
                <Progress
                  value={r.ratio * 100}
                  aria-label={`${r.title}剩余额度占比`}
                  aria-valuetext={`${Math.round(r.ratio * 100)}%，${r.text}`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * 近 7 天用量：只画 activity 真实点。
 *
 * 三态必须区分开，否则「接口失败」会被误读成「真的没有活动」：
 * - `error`：明确报错 + 重试入口（不画占位曲线，也不显示「没有 activity」）；
 * - `loading`：读取中；
 * - 请求成功但没有序列：空态文案。
 */
function UsageTrendPanel({
  usage,
  error,
  loading,
}: {
  usage: UsageStats | null;
  error?: string | null;
  loading?: boolean;
}) {
  const series = activityValues(usage);
  const has = series.filter((n) => Number.isFinite(n)).length >= 2;
  if (error) {
    return (
      <Panel
        title="近 7 天用量"
        description="OpenCode 会话统计（7d），单位为 steps"
        action={
          <Link
            to="/usage"
            search={{ range: '7d' }}
            className="inline-flex items-center gap-1 rounded text-[11px] text-warning underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            去用量页重试 <ArrowRight aria-hidden className="size-3" />
          </Link>
        }
      >
        <div
          role="alert"
          data-usage-state="error"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive"
        >
          <span className="font-medium">用量读取失败：{error}</span>
          <span className="text-text-secondary">
            这是查询失败，不是「没有活动」；趋势线不绘制。可在
            <Link
              to="/usage"
              search={{ range: '7d' }}
              className="mx-0.5 rounded text-accent-rest underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              用量页
            </Link>
            重试。
          </span>
        </div>
      </Panel>
    );
  }
  return (
    <Panel
      title="近 7 天用量"
      description="OpenCode 会话统计（7d），单位为 steps"
      action={
        <Link
          to="/usage"
          search={{ range: '7d' }}
          className="inline-flex items-center gap-1 rounded text-[11px] text-accent-rest underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          详情 <ArrowRight aria-hidden className="size-3" />
        </Link>
      }
    >
      {loading && !usage ? (
        <div
          data-usage-state="loading"
          className="flex h-[64px] items-center rounded-md border border-dashed border-stroke-2 bg-surface-2/40 px-3 text-[11px] text-text-tertiary"
        >
          正在读取用量…
        </div>
      ) : has ? (
        <Sparkline
          data={series}
          width={320}
          height={64}
          className="w-full"
          label="近 7 天会话步骤趋势"
          description={`共 ${series.length} 天，峰值 ${Math.max(...series)}`}
          dot
        />
      ) : (
        <div
          data-usage-state="empty"
          className="flex h-[64px] items-center rounded-md border border-dashed border-stroke-2 bg-surface-2/40 px-3 text-[11px] text-text-tertiary"
        >
          没有 activity 序列，不绘制趋势线。
        </div>
      )}
    </Panel>
  );
}

/** 待处理事项：漂移与认证异常，逐项给出跳转（本页不写操作）。 */
function AttentionPanel({ providers, onSelect }: { providers: ProviderStatus[]; onSelect: (id: string) => void }) {
  const items = attentionItems(providers);
  return (
    <Panel title="待处理事项" description={`${fmtInt(items.length)} 项（漂移 + 认证异常）`}>
      {items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md bg-success/10 px-2.5 py-2 text-[12px] text-success">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          全部条目状态一致，没有待处理项
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelect(it.provider)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-150 hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Badge variant={it.kind === 'drift' ? 'warning' : 'destructive'} className="shrink-0">
                  {it.kind === 'drift' ? '漂移' : '认证'}
                </Badge>
                <span className="min-w-0 flex-col">
                  <span className="block truncate text-[12px] text-text-primary">{it.title}</span>
                  <span className="block truncate text-[10px] text-text-tertiary">{it.text}</span>
                </span>
              </button>
              <Link
                to="/providers"
                search={{ provider: it.provider }}
                aria-label={`在服务页处理 ${it.title}`}
                className="shrink-0 rounded p-1 text-text-tertiary outline-none hover:bg-accent-subtle hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <ChevronRight aria-hidden className="size-3.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * 右侧栏（>=1280px 固定在矩阵右侧，窄屏折叠到主区下方）。
 * 内部用 grid 自适应 1/2 列，避免窄栏里塞四块超长内容。
 */
export function OverviewAside({
  providers,
  quota,
  quotaError,
  usage,
  usageError,
  usageLoading,
  onSelect,
}: {
  providers: ProviderStatus[];
  quota: QuotaPayload | null;
  quotaError: boolean;
  usage: UsageStats | null;
  /** `/api/usage` 的错误消息；非空时右栏显式报错，不再显示「没有 activity」。 */
  usageError?: string | null;
  usageLoading?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <aside aria-label="健康度与待处理事项" className="flex flex-col gap-3">
      <HealthPanel providers={providers} />
      <QuotaTopPanel payload={quota} error={quotaError} />
      <UsageTrendPanel usage={usage} error={usageError} loading={usageLoading} />
      <AttentionPanel providers={providers} onSelect={onSelect} />
    </aside>
  );
}

/** 供矩阵内复用的额度条（无 total 时不渲染进度条，与 quotaSummaryText 口径一致）。 */
export function ProviderQuotaBar({ row }: { row: QuotaRow | undefined }) {
  const bar = quotaBarFor(row);
  if (!bar) return null;
  return (
    <Progress
      value={bar.pct}
      aria-label={`${bar.label}剩余占比`}
      aria-valuetext={`${Math.round(bar.pct)}%`}
      className="mt-1 h-1"
    />
  );
}
