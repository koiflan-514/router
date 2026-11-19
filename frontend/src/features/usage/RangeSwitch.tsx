import type { UsageRange } from '@/lib/contract';
import { cn } from '@/lib/cn';
import { RANGE_OPTIONS } from './usage-model';

/** 时间范围切换器：24h / 7d / 30d / 全部，默认 7d，状态由调用方写入 URL search。 */
export function RangeSwitch({
  value,
  onChange,
}: {
  value: UsageRange;
  onChange: (range: UsageRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label="时间范围"
      className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
    >
      {RANGE_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.short}
          </button>
        );
      })}
    </div>
  );
}
