import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Activity,
  CircleAlert,
  Cpu,
  Info,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataState, StaleNotice } from '@/components/shared/states';
import { LogView } from '@/components/shared/log-view';
import { MetricCard } from '@/components/shared/metric-card';
import { ProviderSelect } from '@/components/shared/provider-select';
import { ProviderChip, TimeText, NotRun } from '@/components/shared/status';
import { ActionButton } from '@/components/shared/action-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useDoctor, useHealth, useProviders, toRes } from '@/lib/query';
import { useActions } from '@/lib/action-store';
import { DASH, fmtRelative } from '@/lib/format';
import type { AuthState } from '@/lib/contract';
import type { HealthProvider } from '@/lib/schemas';
import { useEnvView } from './use-env';

const AUTH_TEXT: Record<AuthState, string> = {
  valid: '正常',
  expiring: '即将到期',
  expired: '已过期',
  missing: '缺少凭证',
  unknown: '未知',
};

const HEALTH_AUTH_VARIANT: Record<AuthState, 'success' | 'warning' | 'destructive' | 'muted'> = {
  valid: 'success',
  expiring: 'warning',
  expired: 'destructive',
  missing: 'destructive',
  unknown: 'muted',
};

const TASK_STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{children}</span>
    </div>
  );
}

function HealthTable({ providers }: { providers: HealthProvider[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>可达</TableHead>
          <TableHead>HTTP</TableHead>
          <TableHead>模型</TableHead>
          <TableHead>认证</TableHead>
          <TableHead>错误</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.map((p) => {
          const state = p.auth?.state;
          return (
            <TableRow key={p.id}>
              <TableCell>
                <ProviderChip id={p.id} title={p.title || undefined} />
              </TableCell>
              <TableCell>
                <Badge variant={p.reachable ? 'success' : 'destructive'}>
                  {p.reachable ? '可达' : '不可达'}
                </Badge>
              </TableCell>
              <TableCell className="font-mono tabular-nums">
                {p.httpStatus ? p.httpStatus : DASH}
              </TableCell>
              <TableCell className="tabular-nums">
                {p.models === null ? DASH : p.models}
              </TableCell>
              <TableCell>
                {state ? (
                  <Badge variant={HEALTH_AUTH_VARIANT[state]}>
                    {AUTH_TEXT[state] ?? state}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">{DASH}</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {p.error ?? DASH}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function DiagnosticsPage() {
  const search = useSearch({ from: '/diagnostics' }) as { provider?: string };
  const navigate = useNavigate();
  const rawProvider = typeof search.provider === 'string' && search.provider ? search.provider : undefined;

  const setProvider = useCallback(
    (v: string | undefined) => {
      void navigate({
        to: '/diagnostics',
        search: (prev: Record<string, unknown>) => ({ ...prev, provider: v }),
        replace: true,
      });
    },
    [navigate],
  );

  const providersRes = useProviders(15000);
  const providers = providersRes.data ?? [];
  const providerUnknown =
    Boolean(rawProvider) && providers.length > 0 && !providers.some((p) => p.id === rawProvider);
  const provider = providerUnknown ? undefined : rawProvider;

  const env = useEnvView();

  const [doctorEnabled, setDoctorEnabled] = useState(true);
  const doctorRes = toRes(useDoctor(doctorEnabled));

  const [healthEnabled, setHealthEnabled] = useState(true);
  const healthRes = useHealth({ provider, probe: false, enabled: healthEnabled });

  const { tasks } = useActions();
  const probeTasks = useMemo(() => tasks.filter((t) => t.action === 'Probe'), [tasks]);
  const lastProbe = probeTasks.length ? probeTasks[probeTasks.length - 1] : undefined;

  const readOnly = env.readOnly;
  const health = healthRes.data;
  const structured = Boolean(health && health.providers.length > 0);
  const passed = structured ? health!.providers.filter((p) => p.reachable && !p.error).length : null;

  const lastCheckAt = useMemo(() => {
    const times = [doctorRes.lastSuccessAt, healthRes.lastSuccessAt, lastProbe?.finishedAt ?? lastProbe?.startedAt ?? null]
      .filter((t): t is string => Boolean(t))
      .sort();
    return times.length ? times[times.length - 1] : null;
  }, [doctorRes.lastSuccessAt, healthRes.lastSuccessAt, lastProbe]);

  // 平台/环境限制（从真实字段派生，不编造）。
  const limits: string[] = [];
  if (env.error) limits.push(`桥接不可达：${env.error.message}`);
  if (readOnly) limits.push('只读模式：写操作已在桥接层禁用');
  if (env.ready && env.mode === 'demo') limits.push('演示模式：数据为匿名虚构值，不 spawn 真实进程');
  if (env.ready && env.mode !== 'demo' && !env.root)
    limits.push('未发现 router.mjs：doctor / 健康检查可能不可用');
  if (env.ready && env.gateway.reachable === false) limits.push('网关不可达：仅影响网关相关页面');
  if (env.extras.features?.openCodeCli === false) limits.push('未检测到 OpenCode CLI：用量页不可用');

  const doctorExit: string = DASH;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="诊断"
        description="环境 → 自检 → 无试打健康检查 → 真实试打（默认折叠、显式触发）。文本输出原样展示，不解析成结构化字段。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ProviderSelect
              providers={providers.map((p) => ({ id: p.id, title: p.title, overlay: p.overlay }))}
              value={provider}
              onChange={setProvider}
              className="w-44"
            />
            <Button variant="outline" size="sm" onClick={() => env.refetch()}>
              <RefreshCw className="size-4" />
              重读环境
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/logs" search={provider ? { provider } : {}}>
                <ScrollText className="size-4" />
                进入日志
              </Link>
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="doctor 退出码"
          value={doctorExit}
          hint="doctor 文本模式未提供退出码"
          tone="default"
        />
        <MetricCard
          label="健康项通过数"
          value={passed === null ? DASH : passed}
          sub={structured ? `共 ${health!.providers.length} 项` : '文本模式'}
          hint={structured ? undefined : 'health.mjs --json 落地前不解析文本'}
        />
        <MetricCard
          label="上次检查时间"
          value={lastCheckAt ? fmtRelative(lastCheckAt) : DASH}
          hint={lastCheckAt ?? '尚未执行'}
        />
        <MetricCard
          label="平台限制"
          value={limits.length}
          tone={limits.length ? 'warning' : 'default'}
          hint={limits.length ? '见环境分区' : '无已知限制'}
        />
      </div>

      {env.error && !env.ready ? (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 text-destructive" />
              <div>
                <div className="font-medium text-destructive">
                  环境不可读{env.error.code ? `（${env.error.code}）` : ''}
                </div>
                <div className="text-muted-foreground">{env.error.message}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 环境 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="size-4" />
            环境（GET /api/env）
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div>
            {env.stale ? (
              <div className="mb-2">
                <StaleNotice lastSuccessAt={env.lastSuccessAt} />
              </div>
            ) : null}
            {env.ready ? (
              <>
                <InfoRow label="OS / 平台">
                  <span className="font-mono">{env.platform || DASH}</span>
                  {env.extras.node?.arch ? (
                    <span className="ml-1 text-xs text-muted-foreground">{env.extras.node.arch}</span>
                  ) : null}
                </InfoRow>
                <InfoRow label="Node">
                  <span className="font-mono">{env.nodeVersion || env.extras.node?.version || DASH}</span>
                </InfoRow>
                <InfoRow label="root">
                  <span className="font-mono">{env.root || DASH}</span>
                </InfoRow>
                <InfoRow label="模式">
                  <Badge variant={env.mode === 'demo' ? 'info' : 'muted'}>
                    {env.mode === 'demo' ? '演示 (demo)' : '本机 (real)'}
                  </Badge>
                </InfoRow>
                <InfoRow label="只读">
                  <Badge variant={readOnly ? 'warning' : 'muted'}>
                    {readOnly ? '是（写操作被拦截）' : '否'}
                  </Badge>
                </InfoRow>
                <InfoRow label="面板版本">
                  <span className="font-mono">{env.panelVersion || DASH}</span>
                </InfoRow>
                <InfoRow label="网关">
                  <span className="font-mono text-xs">{env.gateway.url || DASH}</span>{' '}
                  <Badge
                    variant={
                      env.gateway.reachable === null
                        ? 'muted'
                        : env.gateway.reachable
                          ? 'success'
                          : 'warning'
                    }
                  >
                    {env.gateway.reachable === null ? '未知（未查询）' : env.gateway.reachable ? '可达' : '不可达'}
                  </Badge>
                </InfoRow>
                <InfoRow label="SSE">
                  <Badge variant={env.extras.features?.sse === false ? 'warning' : 'muted'}>
                    {env.extras.features?.sse === false ? '不可用' : '可用'}
                  </Badge>
                </InfoRow>
                <InfoRow label="OpenCode CLI">
                  <Badge variant={env.extras.features?.openCodeCli === false ? 'warning' : 'muted'}>
                    {env.extras.features?.openCodeCli === undefined
                      ? '未知'
                      : env.extras.features.openCodeCli
                        ? '可用'
                        : '不可用'}
                  </Badge>
                </InfoRow>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                {env.error ? '环境读取失败' : '正在读取环境…'}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">平台 / 环境限制</div>
            {limits.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="size-3.5" />
                未发现已知限制。
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {limits.map((l) => (
                  <li key={l} className="flex items-start gap-2 text-xs">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>{l}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 自检 doctor */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4" />
            自检 doctor（GET /api/doctor）
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              最近 <TimeText iso={doctorRes.lastSuccessAt} />
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!doctorEnabled) setDoctorEnabled(true);
                else doctorRes.refetch();
              }}
            >
              <RefreshCw className="size-4" />
              重新运行
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <DataState
            res={doctorRes}
            onRetry={() => doctorRes.refetch()}
            loadingLabel="正在运行 doctor…"
            isEmpty={(t) => t.trim() === ''}
            empty={
              <Empty
                icon={<ShieldAlert />}
                title="doctor 无输出"
                description="命令成功但没有可展示的文本。"
              />
            }
          >
            {(t) => (
              <div className="max-h-80 overflow-auto rounded-md border border-border bg-muted/20">
                <LogView text={t} />
              </div>
            )}
          </DataState>
          <p className="mt-2 text-[11px] text-muted-foreground">
            退出码在 doctor 文本模式下不可得，统一显示 {DASH}；非零退出码表示有需处理项，不代表后端失败。
          </p>
        </CardContent>
      </Card>

      {/* 健康检查（无试打） */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" />
            健康检查（GET /api/health-check，无试打）
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              最近 <TimeText iso={healthRes.lastSuccessAt} />
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!healthEnabled) setHealthEnabled(true);
                else healthRes.refetch();
              }}
            >
              <RefreshCw className="size-4" />
              重新体检
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {structured ? (
              <>
                <Badge variant={health!.ok ? 'success' : 'warning'}>
                  {health!.ok ? '结构化为通过' : '结构化为有失败项'}
                </Badge>
                <Badge variant="muted">issues {health!.issues}</Badge>
              </>
            ) : health ? (
              <>
                <Badge variant={health.ok ? 'success' : 'warning'}>
                  {health.ok ? '通过' : `有需处理项（issues ${health.issues}）`}
                </Badge>
                <Badge variant="muted">文本模式</Badge>
              </>
            ) : null}
            <NotRun label="不消耗模型额度" />
          </div>

          <DataState
            res={healthRes}
            onRetry={() => healthRes.refetch()}
            loadingLabel="正在运行健康检查…"
            empty={
              <Empty icon={<Activity />} title="健康检查无输出" description="命令成功但没有可展示内容。" />
            }
          >
            {(h) =>
              h.providers.length > 0 ? (
                <HealthTable providers={h.providers} />
              ) : h.text && h.text.trim() ? (
                <div className="max-h-96 overflow-auto rounded-md border border-border bg-muted/20">
                  <LogView text={h.text} />
                  <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                    health.mjs 当前仅返回文本；结构化 providers 将在 --json 落地后自动展示（此处不解析文本）。
                  </div>
                </div>
              ) : (
                <Empty icon={<Activity />} title="健康检查无输出" description="命令成功但没有可展示内容。" />
              )
            }
          </DataState>
        </CardContent>
      </Card>

      {/* 真实试打（默认折叠，仅显式触发） */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Stethoscope className="size-4" />
            真实试打（默认折叠 · 从不自动）
          </CardTitle>
          <ActionButton
            action="Probe"
            providerIds={provider ? [provider] : []}
            targetLabel={provider ? provider : undefined}
            disabled={readOnly || !provider}
            title={
              readOnly
                ? '当前为只读模式，写操作已在桥接层禁用'
                : !provider
                  ? '请先选择 provider'
                  : undefined
            }
          >
            <Stethoscope className="size-4" />
            真实试打
          </ActionButton>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-1">
              <span className="font-medium">真实试打会调用真实模型，可能消耗额度并等待较久。</span>
              <span>仅在你显式点击后执行，本页不会自动重复试打。</span>
              {readOnly ? <span>当前为只读模式，按钮已在桥接层被禁用。</span> : null}
              {!provider ? <span>真实试打需要先选择具体 provider。</span> : null}
            </div>
          </div>

          {lastProbe ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant={
                    lastProbe.status === 'succeeded'
                      ? 'success'
                      : lastProbe.status === 'failed'
                        ? 'destructive'
                        : lastProbe.status === 'cancelled'
                          ? 'muted'
                          : 'info'
                  }
                >
                  {TASK_STATUS_TEXT[lastProbe.status] ?? lastProbe.status}
                </Badge>
                {lastProbe.providerIds.map((id) => (
                  <ProviderChip key={id} id={id} />
                ))}
                <span className="text-muted-foreground">
                  执行时间 <TimeText iso={lastProbe.startedAt} />
                </span>
                {lastProbe.exitCode !== null ? (
                  <span className="font-mono text-muted-foreground">退出码 {lastProbe.exitCode}</span>
                ) : null}
                {lastProbe.status === 'succeeded' && lastProbe.refreshStatus === 'pending' ? (
                  <Badge variant="info">状态确认中</Badge>
                ) : null}
                {lastProbe.refreshStatus === 'failed' ? (
                  <Badge variant="warning">命令已完成，状态未确认</Badge>
                ) : null}
              </div>
              <div className="max-h-80 overflow-auto rounded-md border border-border bg-muted/20">
                <LogView text={`${lastProbe.stdout}${lastProbe.stderr ? `\n${lastProbe.stderr}` : ''}`} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                输出来自写任务队列（task {lastProbe.actionId}），已脱敏；不含提示词或响应正文。
              </p>
            </div>
          ) : (
            <Empty
              icon={<Stethoscope />}
              title="尚未执行真实试打"
              description="点击右上角「真实试打」后，这里会显示该次试打的任务状态与脱敏输出。"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
