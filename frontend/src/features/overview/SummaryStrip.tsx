import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import type { ProviderStatus } from '@/lib/contract';
import { deriveSummary, isAuthIssue, type QuotaIndex } from './overview-model';

function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'default' | 'warning' | 'destructive';
}) {
  const toneClass =
    tone === 'destructive' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : 'text-foreground';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          className="flex min-w-[6.5rem] flex-col gap-0.5 rounded-md px-2 py-1 outline-none transition-colors duration-150 hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="text-[11px] text-text-secondary">{label}</span>
          <span className={cn('font-display text-ramp-20 font-semibold tabular-nums leading-none', toneClass)}>{value}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 汇总条：数字全部由 providers 明细逐项推导，鼠标悬浮给出计数口径，
 * 不出现无法解释的汇总。网关为叠加层，单独说明。
 */
export function SummaryStrip({
  providers,
  quotaIndex,
  className,
}: {
  providers: ProviderStatus[];
  quotaIndex: QuotaIndex;
  className?: string;
}) {
  const s = deriveSummary(providers);
  const claimable = [...quotaIndex.values()].filter((r) => r.checkin?.claimable).length;
  const issueNames = providers.filter((p) => isAuthIssue(p.auth)).map((p) => p.id);
  const driftNames = providers.filter((p) => p.drift.length > 0).map((p) => p.id);

  return (
    <Card className={cn('shadow-none', className)}>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">汇总</span>
        <Stat label="已启用" value={`${fmtInt(s.enabled)} / ${fmtInt(s.total)}`} hint="on=true 的条目数（含网关叠加层）" />
        <Stat label="运行" value={`${fmtInt(s.running)} / ${fmtInt(s.total)}`} hint="up=true 的条目数，与已启用独立计算" />
        <Stat
          label="认证异常"
          value={fmtInt(s.authIssues)}
          tone={s.authIssues > 0 ? 'warning' : 'default'}
          hint={
            issueNames.length
              ? `auth.state ∈ {即将到期,已过期,缺少凭证,未知}：${issueNames.join('、')}`
              : '认证状态均为正常'
          }
        />
        <Stat
          label="配置漂移"
          value={fmtInt(s.drifted)}
          tone={s.drifted > 0 ? 'warning' : 'default'}
          hint={driftNames.length ? `drift 非空：${driftNames.join('、')}` : '无配置漂移'}
        />
        {claimable > 0 ? (
          <Stat label="可领取" value={fmtInt(claimable)} hint="后端显式 checkin.claimable=true 的来源数" />
        ) : null}
        {s.total ? (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-text-secondary">
            <Badge variant="info">叠加</Badge>
            <span>统一网关 on == up，不参与 on/off</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
