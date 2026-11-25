import { Activity, CheckCheck, ShieldAlert, TriangleAlert } from 'lucide-react';
import { MetricCard } from '@/components/shared/metric-card';
import { DASH, fmtInt } from '@/lib/format';
import type { ProviderStatus } from '@/lib/contract';
import type { QuotaPayload } from '@/lib/query';
import { claimableCount, deriveSummary, quotaCoverageStats } from './overview-model';

/**
 * 顶部四个 KPI 瓦片：运行/启用、漂移/异常、认证告警、额度可领取。
 *
 * 全部由 providers / quota 明细逐项推导。额度卡**不再借用** usage.activity 的
 * steps 序列做 sparkline/trend（语义不同、也会让人误读为额度趋势）；它只展示
 * 后端显式给出的可领取数，以及额度覆盖情况。
 */
export function OverviewKpiTiles({
  providers,
  quota,
}: {
  providers: ProviderStatus[];
  quota: QuotaPayload | null;
}) {
  const s = deriveSummary(providers);
  const claimable = claimableCount(quota);
  const coverage = quotaCoverageStats(quota);

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
        sub={coverage.sub}
        hint="可领取来自后端 checkin；不推断历史趋势"
        tone={claimable > 0 ? 'info' : 'default'}
        accessory={<CheckCheck aria-hidden />}
      />
    </section>
  );
}
