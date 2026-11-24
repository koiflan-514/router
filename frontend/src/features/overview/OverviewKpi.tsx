import { Link } from '@tanstack/react-router';
import { Activity, CheckCheck, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Sparkline } from '@/components/shared/charts';
import { MetricCard } from '@/components/shared/metric-card';
import { DASH, fmtCompact, fmtInt } from '@/lib/format';
import type { ProviderStatus, UsageStats } from '@/lib/contract';
import type { QuotaPayload } from '@/lib/query';
import {
  activityTrend,
  activityValues,
  claimableCount,
  deriveSummary,
} from './overview-model';

/**
 * 顶部四个 KPI 瓦片：运行/启用、漂移/异常、认证告警、额度可领取。
 *
 * 全部由 providers / quota 明细逐项推导；sparkline 只画 usage.activity 的真实点，
 * 不足 2 点时不画线（Sparkline 内部显示占位），绝不生成假曲线。
 */
export function OverviewKpiTiles({
  providers,
  quota,
  usage,
}: {
  providers: ProviderStatus[];
  quota: QuotaPayload | null;
  usage: UsageStats | null;
}) {
  const s = deriveSummary(providers);
  const claimable = claimableCount(quota);
  const series = activityValues(usage);
  const trend = activityTrend(usage);
  const hasActivity = series.filter((n) => Number.isFinite(n)).length >= 2;

  return (
    <section aria-label="关键指标" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="运行中 / 已启用"
        value={
          <span className="flex items-baseline gap-1.5">
            {fmtInt(s.running)}
            <span className="text-ramp-14 font-normal text-text-tertiary">/ {fmtInt(s.enabled)}</span>
          </span>
        }
        sub={`台账共 ${fmtInt(s.total)} 项（含网关叠加层）`}
        hint="运行 = up=true；已启用 = on=true；两者独立计数"
        tone={s.running >= s.enabled && s.total > 0 ? 'success' : 'default'}
        accessory={<Activity aria-hidden />}
        density="comfortable"
      />
      <MetricCard
        label="漂移 / 异常"
        value={fmtInt(s.drifted)}
        sub={s.drifted > 0 ? '配置与进程状态不一致，需要处理' : '无配置漂移'}
        hint="drift 非空即计数，明细见下方矩阵与待处理事项"
        tone={s.drifted > 0 ? 'warning' : 'success'}
        accessory={<TriangleAlert aria-hidden />}
      />
      <MetricCard
        label="认证告警"
        value={fmtInt(s.authIssues)}
        sub={s.authIssues > 0 ? '即将到期 / 已过期 / 缺凭证 / 未知' : '认证状态均正常'}
        hint="unknown 同样计入告警，不当作正常"
        tone={s.authIssues > 0 ? 'warning' : 'success'}
        accessory={<ShieldAlert aria-hidden />}
      />
      <MetricCard
        label="额度可领取"
        value={claimable > 0 ? fmtInt(claimable) : DASH}
        sub={claimable > 0 ? '来自后端 checkin.claimable=true' : '暂无显式可领取来源'}
        hint={
          hasActivity
            ? `近 7 天会话步骤趋势（首尾差 ${trend !== null && trend > 0 ? '+' : ''}${fmtCompact(trend)})`
            : '近 7 天无 activity 序列，趋势位显示占位'
        }
        tone={claimable > 0 ? 'info' : 'default'}
        accessory={<CheckCheck aria-hidden />}
        spark={hasActivity ? series : undefined}
        trend={
          hasActivity && trend !== null
            ? { value: trend, label: '首尾差（steps）', intent: 'neutral' }
            : undefined
        }
        sparkLabel="近 7 天会话步骤"
      />
    </section>
  );
}

/**
 * 近 7 天用量区块（页面上半部分）：数据来源说明 + 一条较大的 sparkline。
 * 与 /usage 同源（OpenCode 会话统计 7d）；无数据时明确显示空状态。
 */
export function Usage7dPanel({ usage }: { usage: UsageStats | null }) {
  const series = activityValues(usage);
  const has = series.filter((n) => Number.isFinite(n)).length >= 2;
  const total = series.reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-display text-ramp-20 font-semibold tabular-nums">{fmtInt(total)}</span>
        <span className="text-[11px] text-text-secondary">steps · 近 7 天累计</span>
        <Link
          to="/usage"
          search={{ range: '7d' }}
          className="ml-auto rounded text-[11px] text-accent-rest underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          在用量页查看详情
        </Link>
      </div>
      {has ? (
        <Sparkline
          data={series}
          width={360}
          height={56}
          className="w-full"
          label="近 7 天会话步骤趋势"
          description={`共 ${series.length} 天，合计 ${total} steps，峰值 ${Math.max(...series)}`}
          dot
        />
      ) : (
        <div className="flex h-14 items-center rounded-md border border-dashed border-stroke-2 bg-surface-2/40 px-3 text-[11px] text-text-tertiary">
          近 7 天没有 activity 序列（接口返回为空），不绘制趋势线。
        </div>
      )}
    </div>
  );
}
