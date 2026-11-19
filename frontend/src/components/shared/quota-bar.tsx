import { Progress } from '@/components/ui/progress';
import type { QuotaBucket } from '@/lib/contract';
import { DASH, fmtNumber } from '@/lib/format';

/** 额度条：仅在 total > 0 且剩余值有效时显示进度；否则只显示数值。 */
export function QuotaBar({ bucket }: { bucket: QuotaBucket }) {
  const { remaining, total, unit } = bucket;
  const hasTotal = typeof total === 'number' && total > 0;
  const hasRemaining = typeof remaining === 'number';
  const pct = hasTotal && hasRemaining ? Math.max(0, Math.min(100, (remaining / total) * 100)) : null;
  const name = bucket.label?.trim() || '额度';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{bucket.label}</span>
        <span className="tabular-nums">
          {fmtNumber(remaining)}
          {hasTotal ? ` / ${fmtNumber(total)}` : ''} {unit}
          {pct !== null ? <span className="ml-2 text-muted-foreground">{pct.toFixed(0)}%</span> : null}
        </span>
      </div>
      {pct !== null ? (
        <Progress
          value={pct}
          aria-label={`${name}剩余额度`}
          aria-valuetext={`剩余 ${fmtNumber(remaining)} / ${fmtNumber(total)} ${unit}（${pct.toFixed(0)}%）`}
        />
      ) : (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span aria-hidden>{DASH}</span>
          <span>{hasTotal ? '剩余量未知，暂不显示占比' : '未提供总量，暂不显示占比'}</span>
        </div>
      )}
    </div>
  );
}