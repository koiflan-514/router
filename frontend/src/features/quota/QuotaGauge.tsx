import { Badge } from '@/components/ui/badge';
import type { QuotaBucket } from '@/lib/contract';
import { DASH, fmtCountdown, fmtInt, fmtNumber } from '@/lib/format';
import {
  bucketExpiryIso,
  bucketGauge,
  bucketStatus,
  fmtUtcDateTime,
  isDaysBucket,
  isDerivedExpiry,
  workbuddyBucketLabel,
} from './quota-model';

const STATUS_TEXT: Record<string, string> = {
  exhausted: '已耗尽',
  expiring: '即将过期',
  low: '偏低',
  ok: '正常',
  unknown: '未知',
};

const STATUS_VARIANT: Record<string, 'destructive' | 'warning' | 'success' | 'muted'> = {
  exhausted: 'destructive',
  expiring: 'warning',
  low: 'warning',
  ok: 'success',
  unknown: 'muted',
};

function gaugeColor(status: string): string {
  if (status === 'exhausted') return 'var(--destructive)';
  if (status === 'expiring' || status === 'low') return 'var(--warning)';
  if (status === 'ok') return 'var(--success)';
  return 'var(--muted-foreground)';
}

/**
 * 单个额度桶：有总量才算百分比，未知时画虚线环并明确写「总量未知」。
 * `days` 桶（WorkBuddy 凭证有效期）不画百分比，只显示天数与 UTC 到期日。
 */
export function QuotaGauge({
  bucket,
  baseIso,
  workbuddy,
  now = Date.now(),
}: {
  bucket: QuotaBucket;
  baseIso: string | null;
  workbuddy: boolean;
  now?: number;
}) {
  if (isDaysBucket(bucket)) {
    const expiry = bucketExpiryIso(bucket, baseIso);
    const derived = expiry !== null && isDerivedExpiry(bucket);
    const days = typeof bucket.remaining === 'number' ? bucket.remaining : null;
    return (
      <div className="flex flex-col gap-1 rounded-md bg-muted/25 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium">
            {workbuddy ? workbuddyBucketLabel(bucket) : bucket.label || '凭证有效期'}
          </span>
          <Badge variant={days !== null && days <= 7 ? 'warning' : 'info'}>凭证天数</Badge>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{days === null ? DASH : fmtNumber(days, 1)}</span>
          <span className="text-xs text-muted-foreground">天</span>
        </div>
        <div className="text-[11px] leading-snug text-muted-foreground">
          到期 {expiry ? fmtUtcDateTime(expiry) : DASH}
          {derived ? '（按采集时间 + 剩余天数推算）' : ''}
          {days !== null && days > 0 ? ` · 约 ${fmtCountdown(expiry, now)}` : ''}
        </div>
        <div className="text-[11px] text-muted-foreground">凭证 / 续期天数不并入 credits 汇总。</div>
      </div>
    );
  }

  const gauge = bucketGauge(bucket);
  const status = bucketStatus(bucket);
  const color = gaugeColor(status);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const dash = gauge.pct === null ? 0 : (gauge.pct / 100) * circumference;
  const resetIso = bucket.resetDate ?? null;
  const resetCountdown = resetIso ? fmtCountdown(resetIso, now) : null;
  const label = bucket.label || '额度';

  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/25 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <Badge variant={STATUS_VARIANT[status] ?? 'muted'}>{STATUS_TEXT[status] ?? '未知'}</Badge>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative size-24 shrink-0">
          <svg
            viewBox="0 0 100 100"
            role="img"
            aria-label={
              gauge.pct === null
                ? `${label}：总量未知，剩余 ${gauge.remaining === null ? '未知' : `${fmtNumber(gauge.remaining)} ${gauge.unit}`}`
                : `${label}：剩余 ${fmtNumber(gauge.remaining)} / ${fmtNumber(gauge.total)} ${gauge.unit}，${gauge.pct.toFixed(0)}%`
            }
            className="size-full -rotate-90"
          >
            <circle
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke="var(--border)"
              strokeWidth="9"
              strokeDasharray={gauge.pct === null ? '3 5' : undefined}
            />
            {gauge.pct !== null ? (
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={`${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}`}
              />
            ) : null}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-base font-semibold tabular-nums" style={{ color }}>
              {gauge.pct === null ? DASH : `${gauge.pct.toFixed(0)}%`}
            </span>
            <span className="text-[10px] text-muted-foreground">剩余</span>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium tabular-nums">
            {gauge.remaining === null ? DASH : fmtInt(gauge.remaining)}
            <span className="text-xs font-normal text-muted-foreground">
              {gauge.hasTotal
                ? ` / ${fmtInt(gauge.total)} ${gauge.unit}`
                : gauge.hasRemaining
                  ? ` ${gauge.unit}`
                  : ''}
            </span>
          </div>
          {!gauge.hasTotal ? (
            <div className="text-[11px] text-muted-foreground">
              未提供总量，暂不显示占比；剩余量按原单位展示。
            </div>
          ) : !gauge.hasRemaining ? (
            <div className="text-[11px] text-muted-foreground">剩余量未知，暂不显示占比。</div>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              已用 {gauge.used === null ? DASH : fmtInt(gauge.used)} {gauge.unit}
            </div>
          )}
        <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {resetIso ? (
            <>
              重置 <span className="tabular-nums">{resetIso.slice(0, 10)}</span>
              {resetCountdown ? ` · ${resetCountdown}` : ''}
            </>
          ) : (
            <span className="whitespace-nowrap" title="接口未提供下次重置日，不推断">
              未提供重置日
            </span>
          )}
        </div>
          {typeof bucket.expiring === 'number' && bucket.expiring > 0 ? (
            <div className="text-[11px] text-warning">
              即将过期 {fmtNumber(bucket.expiring)} {gauge.unit}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}