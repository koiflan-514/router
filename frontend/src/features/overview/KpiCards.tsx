import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { Surface } from '@/components/shared/surface';
import { DASH, fmtCompact, fmtInt, fmtPercent } from '@/lib/format';
import type { UsageStats } from '@/lib/contract';
import { deriveUsageKpi } from './overview-model';

interface OverviewMetric {
  key: string;
  label: string;
  value: string;
  /** 补充说明（口径/构成），可为空。 */
  detail?: string;
}

/**
 * 近 7 天用量概览：**一条**紧凑指标带（不是四张卡，也不重复画趋势）。
 *
 * 趋势已由右栏 `UsageTrendPanel` 的「近 7 天会话步骤趋势」呈现，这里只给关键数字：
 * 会话/提示、steps、Token（入+出+推）、工具成功率，外加用量页跳转。
 *
 * 口径红线：steps 永不显示为「请求数」；Token 构成只算 input+output+reasoning；
 * 工具成功率不代替模型请求成功率。所有数值都来自 `/api/usage` 真实字段。
 */
export function UsageOverviewStrip({ usage }: { usage: UsageStats }) {
  const k = deriveUsageKpi(usage);
  const metrics: OverviewMetric[] = [
    {
      key: 'sessions',
      label: '会话 / 提示',
      value: `${fmtInt(k.sessions)} / ${fmtInt(k.prompts)}`,
      detail: k.subagents > 0 ? `子会话 ${fmtInt(k.subagents)}` : undefined,
    },
    {
      key: 'steps',
      label: '会话步骤',
      value: fmtInt(k.steps),
      detail: 'steps，≠ 请求数',
    },
    {
      key: 'tokens',
      label: 'Token（入+出+推）',
      value: fmtCompact(k.tokenTotal),
      detail: `入 ${fmtCompact(k.input)} · 出 ${fmtCompact(k.output)} · 推 ${fmtCompact(k.reasoning)}`,
    },
    {
      key: 'tools',
      label: '工具成功率',
      value: k.toolRate === null ? DASH : fmtPercent(k.toolRate, 1),
      detail: !k.toolsReported
        ? '接口未上报工具统计'
        : `成功 ${fmtInt(k.toolSucceeded)} · 失败 ${fmtInt(k.toolFailed)} · 未完成 ${fmtInt(k.toolUnfinished)}`,
    },
  ];

  return (
    <Surface level={1} padding="none" className="flex flex-wrap items-center gap-x-6 gap-y-3 px-3.5 py-3">
      <dl className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-6 gap-y-2">
        {metrics.map((m) => (
          <div key={m.key} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-[11px] text-text-secondary">{m.label}</dt>
            <dd className="font-display text-ramp-16 font-semibold tabular-nums leading-none text-text-primary">
              {m.value}
            </dd>
            {m.detail ? (
              <dd className="text-[10px] tabular-nums text-text-tertiary" title={m.detail}>
                {m.detail}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
      <Link
        to="/usage"
        search={{ range: '7d' }}
        className="inline-flex shrink-0 items-center gap-1 rounded text-[11px] text-accent-rest underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        用量页 <ArrowRight aria-hidden className="size-3" />
      </Link>
    </Surface>
  );
}
