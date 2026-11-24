import { Layers } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import type { UsageStats } from '@/lib/contract';
import { DASH, fmtCompact, fmtInt, fmtPercent } from '@/lib/format';
import { cacheEfficiency, tokenBreakdown } from './usage-model';

function tooltipStyle() {
  return {
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
  } as const;
}

/**
 * Token 构成环形图。构成口径固定为 输入 + 输出 + 推理；
 * 缓存读/写单独列在下方，不并入环形图，避免重复累计（14 §4）。
 */
export function TokenComposition({ data }: { data: UsageStats }) {
  const { total, items } = tokenBreakdown(data);
  const cache = cacheEfficiency(data);
  const hasComposition = total > 0;
  const cacheTotal = cache ? cache.read + cache.write : 0;
  const cacheReadShare = cacheTotal > 0 && cache ? cache.read / cacheTotal : 0;
  const cacheWriteShare = cacheTotal > 0 && cache ? cache.write / cacheTotal : 0;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Token 构成</CardTitle>
        <CardDescription>
          输入 + 输出 + 推理 = <span className="tabular-nums">{fmtInt(total)}</span> tokens
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!hasComposition && !cache ? (
          <Empty
            icon={<Layers />}
            title="该范围没有 Token 数据"
            description="OpenCode 返回的 token 字段均为 0；不画空环、不生成估算值。"
          />
        ) : (
          <>
            {hasComposition ? (
              <div className="flex flex-col items-center gap-2 sm:flex-row">
                <div className="relative h-40 w-40 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={items.filter((i) => i.value > 0)}
                        dataKey="value"
                        nameKey="label"
                        innerRadius="62%"
                        outerRadius="86%"
                        paddingAngle={2}
                        stroke="var(--card)"
                        strokeWidth={2}
                        isAnimationActive={false}
                      >
                        {items
                          .filter((i) => i.value > 0)
                          .map((item) => (
                            <Cell key={item.key} fill={item.colorVar} />
                          ))}
                      </Pie>
                      <Tooltip
                        contentStyle={tooltipStyle()}
                        formatter={(value) => [`${fmtInt(Number(value))} tokens`, '']}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-lg font-semibold tabular-nums">{fmtCompact(total)}</span>
                    <span className="text-[10px] text-muted-foreground">tokens</span>
                  </div>
                </div>

                <ul className="flex w-full flex-col gap-1.5 text-xs">
                  {items.map((item) => (
                    <li key={item.key} className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="size-2 rounded-sm"
                          style={{ backgroundColor: item.colorVar }}
                        />
                        {item.label}
                      </span>
                      <span className="tabular-nums">
                        {fmtInt(item.value)}
                        <span className="ml-2 text-muted-foreground">{fmtPercent(item.ratio, 1)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                输入 / 输出 / 推理均为 0，环形图不显示；下方仍展示 OpenCode 上报的缓存读写。
              </div>
            )}

            <div className="border-t border-border pt-2">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                缓存读写（不并入构成）
              </div>
              {cache ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>缓存总量</span>
                    <span className="tabular-nums text-foreground">{fmtInt(cacheTotal)} tokens</span>
                  </div>
                  <div
                    role="img"
                    aria-label={`缓存读 ${fmtInt(cache.read)} tokens（${fmtPercent(cacheReadShare, 1)}），缓存写 ${fmtInt(
                      cache.write,
                    )} tokens（${fmtPercent(cacheWriteShare, 1)}）`}
                    className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      aria-hidden
                      style={{ width: `${cacheReadShare * 100}%`, backgroundColor: 'var(--primary)' }}
                    />
                    <span
                      aria-hidden
                      style={{ width: `${cacheWriteShare * 100}%`, backgroundColor: 'var(--muted-foreground)' }}
                    />
                  </div>
                  <ul className="flex flex-col gap-1.5 text-xs">
                  <li className="flex items-center justify-between gap-2">
                    <span>缓存读取</span>
                    <span className="tabular-nums">
                      {fmtInt(cache.read)}
                      <span className="ml-2 text-muted-foreground">
                        {cache.readRatio === null ? DASH : `输入 ${fmtPercent(cache.readRatio, 1)}`}
                      </span>
                    </span>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span>缓存写入</span>
                    <span className="tabular-nums">
                      {fmtInt(cache.write)}
                      <span className="ml-2 text-muted-foreground">
                        {cache.writeRatio === null ? DASH : `输入 ${fmtPercent(cache.writeRatio, 1)}`}
                      </span>
                    </span>
                  </li>
                  </ul>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">接口没有返回缓存读写字段。</div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}