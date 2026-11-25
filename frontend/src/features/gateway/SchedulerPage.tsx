import { Boxes, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { MetricCard } from '@/components/shared/metric-card';
import { DataState } from '@/components/shared/states';
import { ActionButton } from '@/components/shared/action-button';
import { ProviderChip, TimeText } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { useGatewayStatus } from '@/lib/query';
import { DASH, fmtCountdown, fmtDuration, fmtInt, fmtNumber, fmtPercent } from '@/lib/format';
import { cn } from '@/lib/cn';
import { providerTitle } from '@/lib/provider';
import {
  CliCommand,
  GatewayUnreachable,
  InfoNote,
  cooldownKindLabel,
  isUnreachable,
  useNow,
} from './gateway-shared';
import { schedulerLanes, type LaneStatus, type SchedulerLane } from './gateway-model';

function dialectLabel(dialect: 'openai' | 'anthropic' | 'both' | null): string {
  if (dialect === 'openai') return 'OpenAI';
  if (dialect === 'anthropic') return 'Anthropic';
  if (dialect === 'both') return '双协议';
  return DASH;
}

function statusMeta(status: LaneStatus): {
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'muted' | 'info';
} {
  if (status === 'cooling') return { label: '冷却中', variant: 'warning' };
  if (status === 'busy') return { label: '处理中', variant: 'info' };
  if (status === 'running') return { label: '运行中', variant: 'success' };
  if (status === 'stopped') return { label: '已停止', variant: 'muted' };
  return { label: '未知', variant: 'muted' };
}

function successTone(rate: number): string {
  if (rate >= 0.95) return '[&>div>div]:bg-success';
  if (rate >= 0.8) return '[&>div>div]:bg-warning';
  return '[&>div>div]:bg-destructive';
}

function LaneCard({ lane, now }: { lane: SchedulerLane; now: number }) {
  const meta = statusMeta(lane.status);
  const cooling = lane.cooldown.active;
  return (
    <Card className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 p-4 pb-2">
        <ProviderChip id={lane.id} title={providerTitle(lane.id)} compact />
        <Badge variant={meta.variant}>{meta.label}</Badge>
        {cooling ? (
          <Badge variant="warning">
            {cooldownKindLabel(lane.cooldown.kind)} · {fmtCountdown(lane.cooldown.iso, now)}
          </Badge>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {dialectLabel(lane.dialect)} · :{lane.port ?? DASH}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4 pt-2">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">权重</span>
              <span className="font-mono tabular-nums">{fmtNumber(lane.weight, 2)}</span>
            </div>
            <Progress value={lane.weightPct} aria-label={`权重 ${fmtNumber(lane.weight, 2)}`} />
            <span className="text-[10px] text-muted-foreground">相对当前批次最大权重</span>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">并发</span>
              <span className="font-mono tabular-nums">{fmtInt(lane.inFlight)}</span>
            </div>
            <Progress value={lane.loadPct} aria-label={`进行中请求 ${fmtInt(lane.inFlight)}`} />
            <span className="text-[10px] text-muted-foreground">相对本批最大并发</span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">成功率</span>
            <span className="font-mono tabular-nums">{fmtPercent(lane.successRate, 1)}</span>
          </div>
          <div className={successTone(lane.successRate)}>
            <Progress
              value={Math.max(0, Math.min(100, lane.successRate * 100))}
              aria-label={`成功率 ${fmtPercent(lane.successRate, 1)}`}
            />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">额度比</dt>
            <dd className="font-mono tabular-nums">
              {lane.quotaRatio === null ? DASH : fmtPercent(lane.quotaRatio, 0)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">连续失败</dt>
            <dd className={cn('font-mono tabular-nums', lane.consecutiveFails > 0 ? 'text-warning' : '')}>
              {fmtInt(lane.consecutiveFails)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">粘性会话</dt>
            <dd className="font-mono tabular-nums">{fmtInt(lane.sticky)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">冷却</dt>
            <dd className="text-right">
              {cooling ? (
                <span className="text-warning">
                  {cooldownKindLabel(lane.cooldown.kind)} · {fmtCountdown(lane.cooldown.iso, now)}
                </span>
              ) : (
                <span className="text-muted-foreground">无</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

/** 调度快照：回答"这次为什么走了别家"。卡片是只读 lane，不提供调度开关。 */
export function SchedulerPage() {
  const res = useGatewayStatus();
  const now = useNow(1000);

  const actions = (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={res.refetch}>
        <RefreshCw className="size-4" />
        刷新
      </Button>
      <ActionButton
        action="RefreshModels"
        targetLabel="网关模型缓存"
        details={[{ label: '影响', value: '清空模型缓存，下次请求重新拉取八家并集' }]}
      />
    </div>
  );

  if (isUnreachable(res.error) && !res.data) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="调度快照"
          description="权重、额度比、并发、成功率、冷却与粘性。"
          actions={actions}
        />
        <GatewayUnreachable message={res.error?.message} onRetry={res.refetch} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="调度快照"
        description="网关是叠加层（on == up），不参与 on/off；这里回答「为什么这次走了别家」。"
        actions={actions}
      />

      <DataState res={res} loadingLabel="正在读取网关调度快照…" onRetry={res.refetch}>
        {(data) => {
          const lanes = schedulerLanes(data.providers, now);
          const running = lanes.filter((lane) => lane.running).length;
          const cooling = lanes.filter((lane) => lane.cooldown.active).length;
          const sticky = lanes.reduce((acc, lane) => acc + lane.sticky, 0);
          const snapshotIso = data.quotaSnapshotAt ? new Date(data.quotaSnapshotAt).toISOString() : null;

          return (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label="网关状态" value="可达" tone="success" sub={`版本 ${data.version || DASH}`} />
                <MetricCard
                  label="进程 PID"
                  value={data.pid ?? DASH}
                  sub={`运行 ${fmtDuration((data.uptimeSec ?? 0) * 1000)}`}
                />
                <MetricCard
                  label="密钥模式"
                  value={data.openMode ? '回环免密钥' : '需密钥'}
                  sub={data.strict ? 'strict：回环也校验密钥' : 'strict 关闭'}
                />
                <MetricCard
                  label="额度快照"
                  value={<TimeText iso={snapshotIso} />}
                  sub="quotaSnapshotAt（间接参与权重）"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <MetricCard
                  label="上游在线"
                  value={`${running} / ${lanes.length}`}
                  tone={lanes.length > 0 && running === lanes.length ? 'success' : 'warning'}
                />
                <MetricCard label="冷却中" value={fmtInt(cooling)} tone={cooling > 0 ? 'warning' : 'default'} />
                <MetricCard label="粘性会话" value={fmtInt(sticky)} />
              </div>

              {lanes.length === 0 ? (
                <Empty
                  icon={<Boxes />}
                  title="网关已可达，但本批没有上游快照"
                  description="没有 provider lane 可展示；稍后刷新或检查网关配置。"
                />
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {lanes.map((lane) => (
                    <LaneCard key={lane.id} lane={lane} now={now} />
                  ))}
                </div>
              )}

              <InfoNote>
                权重 =（额度比 × 10 + 闲置奖励 + 成功率 × 3）× 手动权重；{COOLDOWN_HINT}
              </InfoNote>
            </div>
          );
        }}
      </DataState>
    </div>
  );
}

const COOLDOWN_HINT = (
  <>
    冷却只增不减。<CliCommand>auth</CliCommand> / <CliCommand>billing</CliCommand> /{' '}
    <CliCommand>rate_limit</CliCommand> / <CliCommand>overloaded</CliCommand> 会换家并冷却；
    <CliCommand>context_window</CliCommand> 与未匹配 4xx 不冷却、不换家。
  </>
);