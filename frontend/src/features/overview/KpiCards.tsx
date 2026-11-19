import { MetricCard } from '@/components/shared/metric-card';
import { DASH, fmtCompact, fmtInt, fmtPercent } from '@/lib/format';
import type { UsageStats } from '@/lib/contract';
import { deriveUsageKpi } from './overview-model';

/**
 * 总览顶部四张 KPI 卡：与 /usage 同源同参（OpenCode 会话统计）。
 * 口径红线：steps 永不显示为「请求数」；Token 构成只算 input+output+reasoning；
 * 工具成功率不代替模型请求成功率。
 */
export function UsageKpiCards({ usage }: { usage: UsageStats }) {
  const k = deriveUsageKpi(usage);
  return (
    <section aria-label="用量指标（近 7 天）" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="会话 / 提示"
        value={`${fmtInt(k.sessions)} / ${fmtInt(k.prompts)}`}
        sub={k.subagents > 0 ? `子会话 ${fmtInt(k.subagents)}` : '无子会话'}
        hint="来源：OpenCode 会话统计（近 7 天）"
      />
      <MetricCard
        label="会话步骤"
        value={fmtInt(k.steps)}
        sub="单位：steps"
        hint="会话步骤，不等于 HTTP 请求数"
      />
      <MetricCard
        label="Token 构成（入+出+推）"
        value={`${fmtCompact(k.tokenTotal)} Token`}
        sub={`入 ${fmtCompact(k.input)} · 出 ${fmtCompact(k.output)} · 推 ${fmtCompact(k.reasoning)}`}
        hint={`缓存读 ${fmtCompact(k.cacheRead)} · 缓存写 ${fmtCompact(k.cacheWrite)}（不并入构成）`}
      />
      <MetricCard
        label="工具成功率"
        value={k.toolRate === null ? DASH : fmtPercent(k.toolRate, 1)}
        sub={`成功 ${fmtInt(k.toolSucceeded)} · 失败 ${fmtInt(k.toolFailed)} · 未完成 ${fmtInt(k.toolUnfinished)}`}
        hint={
          !k.toolsReported
            ? '接口未上报工具统计'
            : k.toolRate === null
              ? '暂无已完成的工具调用（未完成不计入分母）'
              : '成功 /（成功+失败）；不等于模型请求成功率'
        }
        tone={k.toolRate !== null && k.toolRate < 0.9 ? 'warning' : 'default'}
      />
    </section>
  );
}
