import { Wrench } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import type { UsageStats } from '@/lib/contract';
import { DASH, fmtInt, fmtPercent } from '@/lib/format';
import { toolsSummary } from './usage-model';

function rateColor(rate: number): string {
  if (rate >= 0.95) return 'var(--success)';
  if (rate >= 0.8) return 'var(--warning)';
  return 'var(--destructive)';
}

/**
 * 工具调用成功率环形 gauge。分子/分母只来自 tools.totals；
 * 无调用时显示空状态，绝不用 0 / 100% 冒充成功。
 */
export function ToolsReliability({ data }: { data: UsageStats }) {
  const tools = toolsSummary(data);
  const rate = tools?.rate ?? 0;
  const color = rateColor(rate);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const dash = Math.max(0, Math.min(1, rate)) * circumference;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>工具可靠性</CardTitle>
        <CardDescription>工具调用成功率 · 不代表模型请求成功率</CardDescription>
      </CardHeader>
      <CardContent>
        {!tools ? (
          <Empty
            icon={<Wrench />}
            title="没有工具调用数据"
            description="tools.totals 缺失或 calls=0；没有分母时不计算成功率。"
          />
        ) : (
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
            <div className="relative size-32 shrink-0">
              <svg
                viewBox="0 0 100 100"
                role="img"
                aria-label={`工具成功率 ${fmtPercent(tools.rate, 1)}，成功 ${fmtInt(
                  tools.succeeded,
                )} 次，失败 ${fmtInt(tools.failed)} 次，未完成 ${fmtInt(tools.pending)} 次`}
                className="size-full -rotate-90"
              >
                <circle
                  cx="50"
                  cy="50"
                  r={radius}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth="10"
                />
                <circle
                  cx="50"
                  cy="50"
                  r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray={`${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}`}
                />
              </svg>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xl font-semibold tabular-nums" style={{ color }}>
                  {fmtPercent(tools.rate, 1)}
                </span>
                <span className="text-[10px] text-muted-foreground">成功率</span>
              </div>
            </div>

            <dl className="grid w-full grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">调用</dt>
                <dd className="font-mono tabular-nums">{fmtInt(tools.calls)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">成功</dt>
                <dd className="font-mono tabular-nums text-success">{fmtInt(tools.succeeded)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">失败</dt>
                <dd className="font-mono tabular-nums text-destructive">{fmtInt(tools.failed)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">未完成</dt>
                <dd className="font-mono tabular-nums">
                  {tools.pending > 0 ? fmtInt(tools.pending) : DASH}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}