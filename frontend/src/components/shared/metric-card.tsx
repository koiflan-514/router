import { useId, type ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';

export function MetricCard({
  label,
  value,
  sub,
  hint,
  tone = 'default',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'destructive' | 'info';
  className?: string;
}) {
  const labelId = useId();
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'destructive'
          ? 'text-destructive'
          : tone === 'info'
            ? 'text-info'
            : 'text-foreground';
  return (
    <Card role="group" aria-labelledby={labelId} className={className}>
      <CardHeader>
        <CardTitle id={labelId} className="text-xs font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn('text-2xl font-semibold tabular-nums leading-none', toneClass)}>{value}</div>
        {sub ? <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div> : null}
        {hint ? <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}