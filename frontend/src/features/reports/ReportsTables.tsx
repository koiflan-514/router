import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ProviderChip } from '@/components/shared/status';
import type { ProviderStatus } from '@/lib/contract';
import { DASH, fmtInt, fmtNumber, fmtPercent } from '@/lib/format';
import { providerColorVar, providerTitle } from '@/lib/provider';
import type {
  ReportModel,
  ReportProviderRow,
  ReportQuotaRowSummary,
  ReportUsageProviderRow,
} from './reports-model';
import type { ModelDetail } from '@/features/usage/usage-model';

function ShareBar({ share, label }: { share: number | null; label: string }) {
  if (share === null) return <span className="text-[10px] text-muted-foreground">{DASH}</span>;
  return (
    <div className="flex items-center gap-2">
      <Progress value={Math.max(0, Math.min(100, share * 100))} className="h-1 w-24" aria-label={`${label} 占比`} />
      <span className="text-[10px] tabular-nums text-muted-foreground">{fmtPercent(share, 1)}</span>
    </div>
  );
}

const AUTH_TEXT: Record<ProviderStatus['auth']['state'], string> = {
  valid: '认证正常',
  expiring: '即将到期',
  expired: '已过期',
  missing: '缺少凭证',
  unknown: '认证未知',
};

const AUTH_VARIANT: Record<
  ProviderStatus['auth']['state'],
  'success' | 'warning' | 'destructive' | 'muted'
> = {
  valid: 'success',
  expiring: 'warning',
  expired: 'destructive',
  missing: 'destructive',
  unknown: 'muted',
};

export function ProviderTopTable({ rows }: { rows: ReportUsageProviderRow[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Provider 用量 Top</CardTitle>
        <CardDescription>OpenCode 模型 steps 按 provider 汇总 · 占比以 steps 为分母</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty title="没有 provider 用量" description="该范围没有模型聚合，不补 0 行。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Steps</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">成本</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.provider}>
                  <TableCell className="min-w-40">
                    <div className="flex flex-col gap-1">
                      {row.provider === DASH ? (
                        <span className="text-muted-foreground">{DASH}</span>
                      ) : (
                        // 用量行只有 provider id：用 fallback 标题当名称，不把 id 再拼一遍（「百度搭子 dumate」）。
                        <ProviderChip id={row.provider} title={providerTitle(row.provider)} compact />
                      )}
                      <ShareBar share={row.share} label={row.provider} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.steps)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.tokens)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.cost > 0 ? fmtNumber(row.cost) : DASH}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function ModelTopTable({ rows }: { rows: ModelDetail[] }) {
  const totalSteps = rows.reduce((sum, row) => sum + Math.max(0, row.steps), 0);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>模型 Top</CardTitle>
        <CardDescription>按 steps 降序；Token 为入+出+推，缓存读写另计</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty title="没有模型用量" description="OpenCode 没有返回 models[]；不生成排名。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Steps</TableHead>
                <TableHead className="text-right">Token（入+出+推）</TableHead>
                <TableHead className="text-right">成本</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 12).map((row) => {
                const tokens = (row.input ?? 0) + (row.output ?? 0) + (row.reasoning ?? 0);
                const share = totalSteps > 0 ? Math.max(0, row.steps) / totalSteps : null;
                return (
                  <TableRow key={row.key}>
                    <TableCell className="min-w-44">
                      <div className="flex flex-col gap-1">
                        <span className="font-mono">{row.id}</span>
                        <ShareBar share={share} label={row.id} />
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.providerID ? (
                        <ProviderChip id={row.providerID} compact />
                      ) : (
                        <span className="text-muted-foreground">{DASH}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.steps)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.input === null && row.output === null && row.reasoning === null ? DASH : fmtInt(tokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.cost > 0 ? fmtNumber(row.cost) : DASH}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {rows.length > 12 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">仅展示前 12 行；完整明细见 CSV 导出。</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ProviderMatrixCard({ rows }: { rows: ReportProviderRow[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Provider 状态矩阵</CardTitle>
        <CardDescription>来自 /providers 的只读状态；叠加层不参与 on/off</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty
            icon={<ShieldCheck />}
            title="没有 provider 状态"
            description="providers 为空或读取失败；此矩阵不会把未知写成正常。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>进程</TableHead>
                <TableHead>开关</TableHead>
                <TableHead>认证</TableHead>
                <TableHead>漂移</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {/* compact：只显示名称，id 进 title（明细见行详情/CSV），避免重复 id 占宽。 */}
                    <ProviderChip id={row.id} title={row.title} compact />
                    {row.overlay ? <Badge variant="info" className="ml-2">叠加</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.up ? 'success' : row.on ? 'warning' : 'muted'}>
                      {row.up ? '运行中' : row.on ? '已启用未运行' : '已停止'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.on ? 'success' : 'muted'}>{row.on ? '启用' : '关闭'}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={AUTH_VARIANT[row.auth]}>{AUTH_TEXT[row.auth]}</Badge>
                  </TableCell>
                  <TableCell>
                    {row.drift.length ? (
                      <span className="flex flex-wrap gap-1">
                        {row.drift.map((kind) => (
                          <Badge key={kind} variant={kind === 'stillRunning' ? 'destructive' : 'warning'}>
                            {kind === 'stopped' ? '已启用未运行' : kind === 'notSynced' ? '未同步客户端' : '已关闭仍在运行'}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{DASH}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function QuotaSnapshotCard({
  coverage,
  alerts,
  providers,
  workbuddyDays,
}: {
  coverage: ReportModel['quota']['coverage'];
  alerts: string[];
  providers: ReportQuotaRowSummary[];
  workbuddyDays: ReportModel['quota']['workbuddyDays'];
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>额度快照</CardTitle>
        <CardDescription>
          可查 {coverage.available} / {coverage.total} 家 · 不跨厂商求和
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {coverage.total === 0 ? (
          <Empty title="没有额度数据" description="quota.providers 为空；空状态不等于余额为 0。" />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Progress
                value={coverage.ratio === null ? 0 : coverage.ratio * 100}
                className="h-2 flex-1"
                aria-label="额度来源可查覆盖率"
                aria-valuetext={
                  coverage.ratio === null ? '未知' : `${Math.round(coverage.ratio * 100)}%`
                }
              />
              <span className="text-xs tabular-nums text-muted-foreground">
                {coverage.ratio === null ? DASH : fmtPercent(coverage.ratio, 0)}
              </span>
            </div>

            {alerts.length ? (
              <ul className="flex flex-col gap-1 text-xs">
                {alerts.map((alert, i) => (
                  <li key={`${alert}-${i}`} className="flex items-start gap-2 text-warning">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{alert}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2 text-xs text-success">
                <CheckCircle2 className="size-3.5" />
                没有额度告警
              </div>
            )}

            {workbuddyDays.length ? (
              <div className="flex flex-col gap-1 border-t border-border pt-2 text-xs">
                <span className="font-medium text-muted-foreground">WorkBuddy 凭证有效期（单独口径）</span>
                {workbuddyDays.map((item) => (
                  <div key={item.provider} className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="size-2 rounded-sm"
                        style={{ backgroundColor: providerColorVar(item.provider) }}
                      />
                      {item.title}
                    </span>
                    <span className="tabular-nums">
                      {item.days === null ? DASH : `${fmtNumber(item.days, 1)} 天`}
                    </span>
                  </div>
                ))}
                <span className="text-[10px] text-muted-foreground">凭证天数不并入 credits 汇总。</span>
              </div>
            ) : null}

            <div className="border-t border-border pt-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">来源状态</div>
              <div className="flex flex-wrap gap-1">
                {providers.map((provider) => (
                  <Badge
                    key={provider.provider}
                    variant={
                      provider.status === 'ok'
                        ? 'success'
                        : provider.status === 'issue'
                          ? 'warning'
                          : provider.status === 'error' || provider.status === 'unavailable'
                            ? 'destructive'
                            : 'muted'
                    }
                  >
                    {provider.title}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function GatewaySnapshotCard({
  gateway,
  available,
}: {
  gateway: ReportModel['gateway'];
  available: boolean;
}) {
  const top = gateway.providerRows.slice(0, 4);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>网关快照</CardTitle>
        <CardDescription>与 OpenCode 用量是两套口径；请求数不与 steps 相加</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">请求 / 错误</dt>
            <dd className="font-mono tabular-nums">
              {available ? fmtInt(gateway.totals.requests) : DASH} / {available ? fmtInt(gateway.totals.errors) : DASH}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">错误率</dt>
            <dd className="font-mono tabular-nums">
              {available && gateway.totals.errorRate !== null
                ? fmtPercent(gateway.totals.errorRate, 1)
                : DASH}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">输入 / 输出 Token</dt>
            <dd className="font-mono tabular-nums">
              {available ? fmtInt(gateway.totals.inputTokens) : DASH} /{' '}
              {available ? fmtInt(gateway.totals.outputTokens) : DASH}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">上游在线 / 冷却</dt>
            <dd className="font-mono tabular-nums">
              {gateway.running === null || gateway.providers === null
                ? DASH
                : `${gateway.running} / ${gateway.providers}`}
              {gateway.cooling === null ? '' : ` · 冷却 ${gateway.cooling}`}
            </dd>
          </div>
        </dl>

        {top.length ? (
          <div className="border-t border-border pt-2">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">请求 Top</div>
            <ul className="flex flex-col gap-1 text-xs">
              {top.map((row) => (
                <li key={row.label} className="flex items-center justify-between gap-2">
                  <ProviderChip id={row.label} compact />
                  <span className="tabular-nums">
                    {fmtInt(row.requests)}
                    <span className="ml-2 text-muted-foreground">
                      {row.share === null ? DASH : fmtPercent(row.share, 1)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">该窗口没有网关 provider 聚合。</div>
        )}
        <p className="text-[10px] text-muted-foreground">
          网关窗口为近 {gateway.days} 天（按自然日分片）；与上方 OpenCode 的滚动窗口（24h / 7d / 30d / all）可能不完全对齐。
        </p>
      </CardContent>
    </Card>
  );
}