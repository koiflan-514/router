import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { MetricCard } from '@/components/shared/metric-card';
import { DataState } from '@/components/shared/states';
import { ActionButton } from '@/components/shared/action-button';
import { ProviderChip, TimeText } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useGatewayStatus } from '@/lib/query';
import { DASH, fmtCountdown, fmtDuration, fmtInt, fmtNumber, fmtPercent } from '@/lib/format';
import {
  CliCommand,
  GatewayUnreachable,
  InfoNote,
  cooldownKindLabel,
  isUnreachable,
  useNow,
} from './gateway-shared';

function dialectLabel(dialect: 'openai' | 'anthropic' | 'both'): string {
  if (dialect === 'openai') return 'OpenAI';
  if (dialect === 'anthropic') return 'Anthropic';
  return '双协议';
}

/**
 * 冷却的唯一时间源：用同一个 `now` 判定是否还在冷却，并算出到期 ISO。
 * `cooldownUntil` 缺失/null/非有限数都视为“没有冷却”，绝不显示倒计时。
 */
function cooldownIso(until: number | null | undefined, now: number): string | null {
  if (typeof until !== 'number' || !Number.isFinite(until) || until <= now) return null;
  return new Date(until).toISOString();
}

/** 调度快照：回答"这次为什么走了别家"。 */
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
          const providers = data.providers;
          const running = providers.filter((p) => p.running).length;
          const cooling = providers.filter((p) => p.cooldownUntil != null && p.cooldownUntil > now).length;
          const sticky = providers.reduce((acc, p) => acc + (p.sticky ?? 0), 0);
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

              <div className="grid grid-cols-3 gap-3">
                <MetricCard
                  label="上游在线"
                  value={`${running} / ${providers.length}`}
                  tone={providers.length > 0 && running === providers.length ? 'success' : 'warning'}
                />
                <MetricCard label="冷却中" value={fmtInt(cooling)} tone={cooling > 0 ? 'warning' : 'default'} />
                <MetricCard label="粘性会话" value={fmtInt(sticky)} />
              </div>

              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>进程</TableHead>
                      <TableHead>方言</TableHead>
                      <TableHead>端口</TableHead>
                      <TableHead className="text-right">权重</TableHead>
                      <TableHead>额度比</TableHead>
                      <TableHead className="text-right">并发</TableHead>
                      <TableHead className="text-right">连续失败</TableHead>
                      <TableHead className="text-right">成功率</TableHead>
                      <TableHead>冷却</TableHead>
                      <TableHead className="text-right">粘性</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {providers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={11} className="py-6 text-center text-muted-foreground">
                          网关已可达，但本批没有上游快照
                        </TableCell>
                      </TableRow>
                    ) : (
                      providers.map((p) => {
                        const cooldownUntil = p.cooldownUntil ?? null;
                        const cdActive = cooldownUntil != null && cooldownUntil > now;
                        const cdIso = cdActive && cooldownUntil != null ? new Date(cooldownUntil).toISOString() : null;
                        return (
                          <TableRow key={p.id}>
                            <TableCell>
                              <ProviderChip id={p.id} />
                            </TableCell>
                            <TableCell>
                              <Badge variant={p.running ? 'success' : 'muted'}>{p.running ? '运行中' : '已停止'}</Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {p.dialect ? dialectLabel(p.dialect) : DASH}
                            </TableCell>
                            <TableCell className="font-mono tabular-nums">{p.port ?? DASH}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtNumber(p.weight, 2)}</TableCell>
                            <TableCell>
                              {p.quotaRatio == null ? (
                                <span className="text-muted-foreground">{DASH}</span>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <Progress value={p.quotaRatio * 100} className="w-16" />
                                  <span className="tabular-nums">{fmtPercent(p.quotaRatio, 0)}</span>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{fmtInt(p.inFlight)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtInt(p.consecutiveFails)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtPercent(p.successRate, 1)}</TableCell>
                            <TableCell>
                              {cdActive ? (
                                <Badge variant="warning">
                                  冷却：{cooldownKindLabel(p.cooldownKind ?? null)} · 剩余 {fmtCountdown(cdIso, now)}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">{DASH}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{fmtInt(p.sticky ?? 0)}</TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

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
