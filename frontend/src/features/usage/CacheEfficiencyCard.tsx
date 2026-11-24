import { Gauge } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import type { UsageStats } from '@/lib/contract';
import { DASH, fmtInt, fmtPercent } from '@/lib/format';
import { cacheEfficiency } from './usage-model';

function RatioRow({
  label,
  value,
  ratio,
  colorClass,
}: {
  label: string;
  value: number;
  ratio: number | null;
  colorClass: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {fmtInt(value)} tokens
          <span className="ml-2 text-muted-foreground">
            {ratio === null ? DASH : `输入 ${fmtPercent(ratio, 1)}`}
          </span>
        </span>
      </div>
      {ratio === null ? (
        <div className="text-[11px] text-muted-foreground">输入 Token 为 0，无法计算比例。</div>
      ) : (
        <div className={colorClass}>
          <Progress
            value={Math.min(100, ratio * 100)}
            aria-label={`${label}占输入 Token 比例`}
            aria-valuetext={`${Math.round(ratio * 100)}%`}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 缓存效率：缓存读写相对输入 Token 的比例。
 * 只在接口确实给出缓存字段时出现；缓存读写不并入 Token 构成。
 */
export function CacheEfficiencyCard({ data }: { data: UsageStats }) {
  const cache = cacheEfficiency(data);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>缓存效率</CardTitle>
        <CardDescription>缓存读写 / 输入 Token · 不重复累计进 Token 构成</CardDescription>
      </CardHeader>
      <CardContent>
        {!cache ? (
          <Empty
            icon={<Gauge />}
            title="没有缓存读写数据"
            description="OpenCode 没有返回 cache.read / cache.write，或两者均为 0。"
          />
        ) : (
          <div className="flex flex-col gap-4">
            <RatioRow
              label="缓存读取"
              value={cache.read}
              ratio={cache.readRatio}
              colorClass="[&>div>div]:bg-info"
            />
            <RatioRow
              label="缓存写入"
              value={cache.write}
              ratio={cache.writeRatio}
              colorClass="[&>div>div]:bg-warning"
            />
            <p className="text-[11px] text-muted-foreground">
              比例 = 缓存 Token ÷ 输入 Token；分母为 0 时显示 {DASH}，不做除法。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}