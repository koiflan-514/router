import { MetricCard } from '@/components/shared/metric-card';
import type { UsageStats } from '@/lib/contract';
import { DASH, fmtCompact, fmtInt, fmtNumber, fmtPercent } from '@/lib/format';
import { activityPoints, tokenComposition, toolsSummary } from './usage-model';

/** 六张 KPI 卡：会话/提示、steps、Token 构成、成本、活跃天数、工具成功率。 */
export function UsageKpis({ data }: { data: UsageStats }) {
  const tools = toolsSummary(data);
  const cacheRead = data.tokens.cache?.read;
  const cacheWrite = data.tokens.cache?.write;
  const points = activityPoints(data);
  const hasActivity = points.some((p) => p.steps > 0);
  const stepsSeries = points.map((p) => p.steps);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <MetricCard
        label="会话 / 提示"
        value={
          <span className="tabular-nums">
            {fmtInt(data.sessions)} / {fmtInt(data.prompts)}
          </span>
        }
        sub={`子会话 ${fmtInt(data.subagents)}`}
        hint="提示数不等同模型请求数"
      />

      <MetricCard
        label="会话步骤"
        value={fmtInt(data.steps)}
        sub={
          hasActivity ? `按日 ${points.length} 个活动点` : '没有按日活动数据'
        }
        hint="steps 是 OpenCode 会话步骤，不是 HTTP 请求数"
        spark={hasActivity ? stepsSeries : undefined}
        sparkLabel="按日 steps 趋势（真实活动点，不做插值）"
      />

      <MetricCard
        label="Token 构成"
        value={fmtCompact(tokenComposition(data))}
        sub={
          <span className="tabular-nums">
            入 {fmtCompact(data.tokens.input)} · 出 {fmtCompact(data.tokens.output)} · 推{' '}
            {fmtCompact(data.tokens.reasoning)}
          </span>
        }
        hint={
          <span className="tabular-nums">
            缓存读 {fmtCompact(cacheRead)} · 缓存写 {fmtCompact(cacheWrite)}（另计）
          </span>
        }
      />

      <MetricCard
        label="上报成本"
        value={data.cost > 0 ? fmtNumber(data.cost) : DASH}
        sub={data.cost > 0 ? 'OpenCode 上报值' : '—（OpenCode 未上报）'}
        hint="不等于积分余额，不折算、不跨厂商求和"
        tone={data.cost > 0 ? 'default' : 'default'}
      />

      <MetricCard
        label="活跃 / 连续"
        value={
          <span className="tabular-nums">
            {fmtInt(data.activeDays)} / {fmtInt(data.streak)}
          </span>
        }
        sub="活跃天数 / 连续活跃天数"
        hint="原样展示，不做趋势推断"
      />

      <MetricCard
        label="工具成功率"
        value={tools ? fmtPercent(tools.rate, 1) : DASH}
        sub={
          tools ? (
            <span className="tabular-nums">
              成功 {fmtInt(tools.succeeded)} · 失败 {fmtInt(tools.failed)} · 未完成{' '}
              {fmtInt(tools.pending)}
            </span>
          ) : (
            '无工具调用数据'
          )
        }
        hint="工具调用成功率，不代表模型请求成功率"
        tone={tools ? (tools.rate < 0.8 ? 'warning' : 'default') : 'default'}
      />
    </div>
  );
}