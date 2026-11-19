import { CircleAlert, CircleCheck, CircleDot, CircleHelp, CircleMinus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AuthState, AuthStatus, DriftKind } from '@/lib/contract';
import { DASH, fmtDateTime, fmtRelative } from '@/lib/format';
import { providerColorVar } from '@/lib/provider';
import { cn } from '@/lib/cn';

export function StatusDot({ up, label }: { up: boolean; label?: string }) {
  const text = label ?? (up ? '运行中' : '已停止');
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn('size-2 rounded-full', up ? 'bg-success' : 'bg-muted-foreground/40')}
      />
      {/* 圆点只是装饰，文字始终表达状态，颜色不是唯一信息。 */}
      <span className="sr-only">状态：</span>
      <span className={up ? 'text-foreground' : 'text-muted-foreground'}>{text}</span>
    </span>
  );
}

const AUTH_META: Record<AuthState, { text: string; variant: 'success' | 'warning' | 'destructive' | 'muted' }> = {
  valid: { text: '正常', variant: 'success' },
  expiring: { text: '即将到期', variant: 'warning' },
  expired: { text: '已过期', variant: 'destructive' },
  missing: { text: '缺少凭证', variant: 'destructive' },
  unknown: { text: '未知', variant: 'muted' },
};

export function AuthBadge({ auth }: { auth: AuthStatus }) {
  const meta = AUTH_META[auth.state];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          role="img"
          variant={meta.variant}
          aria-label={`认证：${meta.text}${auth.label ? `，${auth.label}` : ''}${
            auth.expiresAt ? `，到期 ${fmtDateTime(auth.expiresAt)}` : ''
          }`}
        >
          {meta.text}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {auth.label || meta.text}
        {auth.expiresAt ? ` · 到期 ${fmtDateTime(auth.expiresAt)}` : ''}
      </TooltipContent>
    </Tooltip>
  );
}

const DRIFT_META: Record<DriftKind, { text: string; variant: 'warning' | 'destructive' | 'muted' }> = {
  stopped: { text: '已启用未运行', variant: 'warning' },
  notSynced: { text: '未写入客户端', variant: 'warning' },
  stillRunning: { text: '已关闭仍在运行', variant: 'destructive' },
};

export function DriftBadges({ drift }: { drift: DriftKind[] }) {
  if (!drift.length) {
    return (
      <span role="img" aria-label="无状态漂移" className="text-muted-foreground">
        {DASH}
      </span>
    );
  }
  return (
    <span
      role="group"
      aria-label={`状态漂移：${drift.map((d) => DRIFT_META[d].text).join('、')}`}
      className="inline-flex flex-wrap gap-1"
    >
      {drift.map((d) => (
        <Badge key={d} variant={DRIFT_META[d].variant}>
          {DRIFT_META[d].text}
        </Badge>
      ))}
    </span>
  );
}

export function ProviderChip({ id, title, className }: { id: string; title?: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: providerColorVar(id) }} />
      <span className="font-medium">{title ?? id}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{id}</span>
    </span>
  );
}

/** 相对时间 + 悬浮绝对时间；未知显示 `—`。 */
export function TimeText({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return <span className={cn('text-muted-foreground', className)}>{DASH}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{fmtRelative(iso)}</span>
      </TooltipTrigger>
      <TooltipContent>{fmtDateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}

export function BoolText({ value, yes = '是', no = '否' }: { value: boolean | null | undefined; yes?: string; no?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">{DASH}</span>;
  return <span>{value ? yes : no}</span>;
}

export function HealthIcon({ level }: { level: 'ok' | 'warn' | 'error' | 'unknown' }) {
  if (level === 'ok') return <CircleCheck role="img" className="size-4 text-success" aria-label="正常" />;
  if (level === 'warn') return <CircleAlert role="img" className="size-4 text-warning" aria-label="注意" />;
  if (level === 'error') return <CircleAlert role="img" className="size-4 text-destructive" aria-label="错误" />;
  return <CircleHelp role="img" className="size-4 text-muted-foreground" aria-label="未知" />;
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

export function NotRun({ label = '未查询' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <CircleMinus className="size-3.5" />
      {label}
    </span>
  );
}

export function RunningDot() {
  return <CircleDot className="size-3.5 text-info" aria-hidden />;
}
