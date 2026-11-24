import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AuthBadge, ProviderChip } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DASH, fmtDateTime, fmtInt } from '@/lib/format';
import type { ProviderStatus } from '@/lib/contract';
import { driftDetailText, quotaSummaryText, stateComboText, type QuotaIndex } from './overview-model';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-mono text-[13px] tabular-nums">{children}</dd>
    </div>
  );
}

const NEXT_LINKS = [
  { to: '/providers', label: '服务页' },
  { to: '/logs', label: '日志页' },
  { to: '/diagnostics', label: '诊断页' },
] as const;

/** 选中行详情：完整四态、PID/pids、control 与认证详情；只提供跳转，不写操作。 */
export function ProviderDetailSheet({
  provider,
  quotaIndex,
  open,
  onOpenChange,
}: {
  provider: ProviderStatus | null;
  quotaIndex: QuotaIndex;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" aria-label={provider ? `${provider.title} 详情` : 'provider 详情'}>
        {provider ? (
          <>
            <SheetHeader>
              <SheetTitle>
                <ProviderChip id={provider.id} title={provider.title} />
              </SheetTitle>
              <SheetDescription>{stateComboText(provider)}</SheetDescription>
            </SheetHeader>
            <Separator />
            <dl className="divide-y divide-border">
              <Field label="开关 on">
                {provider.overlay ? (
                  <Badge variant="info">叠加（不适用 on/off）</Badge>
                ) : (
                  <Badge variant={provider.on ? 'success' : 'muted'}>{provider.on ? '开' : '关'}</Badge>
                )}
              </Field>
              <Field label="进程 up">
                <Badge variant={provider.up ? 'success' : 'muted'}>{provider.up ? '运行' : '停止'}</Badge>
              </Field>
              <Field label="客户端 oc">
                {provider.ocUserOwned ? (
                  <Badge variant="muted">用户自管</Badge>
                ) : (
                  <Badge variant={provider.oc ? 'success' : 'warning'}>{provider.oc ? '已写入' : '未写入'}</Badge>
                )}
              </Field>
              <Field label="认证 auth">
                <span className="inline-flex items-center gap-2">
                  <AuthBadge auth={provider.auth} />
                  {provider.auth.label ? <span className="text-muted-foreground">{provider.auth.label}</span> : null}
                </span>
              </Field>
              <Field label="到期时间">{provider.auth.expiresAt ? fmtDateTime(provider.auth.expiresAt) : DASH}</Field>
              <Field label="配置漂移">
                <span className="font-sans">{driftDetailText(provider)}</span>
              </Field>
              <Field label="端口">{provider.port > 0 ? provider.port : DASH}</Field>
              <Field label="模型数">{provider.models === null ? DASH : fmtInt(provider.models)}</Field>
              <Field label="PID">{provider.pid ?? DASH}</Field>
              <Field label="全部 PID">{provider.pids.length ? provider.pids.join(', ') : DASH}</Field>
              <Field label="control">{provider.control || DASH}</Field>
              <Field label="额度摘要">
                <span className="font-sans">
                  {provider.overlay ? DASH : quotaSummaryText(quotaIndex.get(provider.id))}
                </span>
              </Field>
            </dl>
            <Separator />
            <div className="flex flex-col gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">下一步（跳转，不在本页写操作）</span>
              <div className="flex flex-wrap gap-2">
                {NEXT_LINKS.map((l) => (
                  <Link
                    key={l.to}
                    to={l.to}
                    search={{ provider: provider.id }}
                    className="rounded border border-stroke-1 px-2.5 py-1 outline-none transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    前往{l.label}
                  </Link>
                ))}
              </div>
              <span className="mt-1">
                up 不代表凭证有效，凭证有效不代表 oc=true，oc=true 也不代表请求会成功。
              </span>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
