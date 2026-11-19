import { MetricCard } from '@/components/shared/metric-card';
import type { UsageStats } from '@/lib/contract';
import { DASH, fmtCompact, fmtInt, fmtPercent } from '@/lib/format';
import { tokenComposition, toolsSummary } from './usage-model';

/** 四张 KPI 卡：会话/提示 · 会话步骤 · Token 构成 · 工具成功率（14 §6.2）。 */
export function UsageKpis({ data }: { data: UsageStats }) {
  const tools = toolsSummary(data);
  const cacheRead = data.tokens.cache?.read;
  const cacheWrite = data.tokens.cache?.write;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
        sub="steps"
        hint="OpenCode 会话步骤，不等于 HTTP 请求数"
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
            缓存读 {fmtCompact(cacheRead)} · 缓存写 {fmtCompact(cacheWrite)}（另计，不并入构成）
          </span>
        }
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
      />
    </div>
  );
}
