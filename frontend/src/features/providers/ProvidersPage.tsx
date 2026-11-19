import { useCallback } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Info,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ActionButton } from '@/components/shared/action-button';
import { MetricCard } from '@/components/shared/metric-card';
import { PageHeader } from '@/components/shared/page-header';
import { ProviderSelect } from '@/components/shared/provider-select';
import { DataState } from '@/components/shared/states';
import { AuthBadge, DriftBadges, ProviderChip, StatusDot } from '@/components/shared/status';
import { useActions } from '@/lib/action-store';
import { cn } from '@/lib/cn';
import { actionCatalog, type DriftKind, type ProviderStatus, type Task } from '@/lib/contract';
import { DASH, fmtCountdown, fmtDateTime, fmtRelative } from '@/lib/format';
import { useEnv, useProviders } from '@/lib/query';

/**
 * 服务页 `/providers?provider=codearts`（FR-110–119，设计见 03-ui-design.md §3.2）。
 *
 * - 四个独立状态（on / up / oc / auth）互不推导，drift 由后端字段派生，UI 不猜。
 * - 写操作一律经 `ActionButton`（内建确认框 / 全局串行 / 同目标去重 / 进行中禁用）。
 * - `gateway` 是叠加层：不显示 `on/off` 排他开关，其启停用通用 Start/Stop。
 * - 只读/演示模式在桥接层拦截写：此处禁用写按钮并说明原因，不隐藏。
 */

const DRIFT_NEXT: Record<DriftKind, string> = {
  stopped: '开关为开但进程已停止 → 下一步：启动 / 查看日志',
  notSynced: '已启用但客户端配置未写入 → 下一步：同步客户端',
  stillRunning: '开关为关但进程仍在运行 → 下一步：停止',
};

function isActiveTask(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running';
}

function OnBadge({ p }: { p: ProviderStatus }) {
  if (p.overlay) return <Badge variant="muted">叠加</Badge>;
  return p.on ? <Badge variant="success">开</Badge> : <Badge variant="muted">关</Badge>;
}

function ClientBadge({ p }: { p: ProviderStatus }) {
  if (p.overlay) return <span className="text-muted-foreground">不适用</span>;
  if (p.oc) return <Badge variant="success">已写入</Badge>;
  if (p.ocUserOwned) return <Badge variant="info">用户自管</Badge>;
  return <Badge variant="warning">未写入</Badge>;
}

function pidText(p: ProviderStatus): string {
  if (p.pids.length) return p.pids.join('、');
  return p.pid === null ? DASH : String(p.pid);
}

/** 详情区必须列出「开关 ≠ 进程 ≠ 客户端」的具体组合，而不是只写"异常"。 */
function comboParts(p: ProviderStatus): string[] {
  if (p.overlay) {
    return ['开关=叠加层（无独立开关）', `进程=${p.up ? '运行' : '停止'}`, '客户端=不适用'];
  }
  return [
    `开关=${p.on ? '开' : '关'}`,
    `进程=${p.up ? '运行' : '停止'}`,
    `客户端=${p.oc ? '已写入' : p.ocUserOwned ? '用户自管（不报同步漂移）' : '未写入'}`,
  ];
}

function affectedNames(rows: ProviderStatus[]): string[] {
  return rows.filter((p) => !p.overlay).map((p) => `${p.title}（${p.id}）`);
}

export function ProvidersPage() {
  const providersRes = useProviders();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();

  const selectedId = typeof search.provider === 'string' && search.provider ? search.provider : undefined;

  const selectProvider = useCallback(
    (id: string | undefined) => {
      // 选择写进 URL search（可分享、可回退）；排序/过滤类连续变更用 replace 语义。
      void navigate({
        to: '/providers',
        replace: true,
        search: (prev: Record<string, unknown>) => ({ ...prev, provider: id }),
      });
    },
    [navigate],
  );

  const options = (providersRes.data ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    overlay: p.overlay,
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="服务"
        description="启停、停止但保留客户端、重启、仅启用、关闭、全部启用/关闭与同步。四个状态（开关 / 进程 / 客户端 / 认证）互不推导。"
        actions={
          <>
            <ProviderSelect
              providers={options}
              value={selectedId}
              onChange={selectProvider}
              className="w-[12rem]"
            />
            <Button variant="outline" size="sm" onClick={providersRes.refetch}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
          </>
        }
      />

      <DataState
        res={providersRes}
        onRetry={providersRes.refetch}
        loadingLabel="正在读取 provider 状态…"
      >
        {(rows) => <ProvidersContent rows={rows} selectedId={selectedId} onSelect={selectProvider} />}
      </DataState>
    </div>
  );
}

function ProvidersContent({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ProviderStatus[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}) {
  const { tasks, runningProviderIds, activeGlobal } = useActions();
  const readOnly = useEnv().data?.readOnly ?? false;

  const managed = rows.filter((p) => !p.overlay);
  const managedIds = managed.map((p) => p.id);
  const runningCount = managed.filter((p) => p.up).length;
  const driftCount = managed.filter((p) => p.drift.length > 0).length;
  const activeCount = tasks.filter(isActiveTask).length;
  const lastTask = tasks.length ? tasks[tasks.length - 1] : null;

  const selected = selectedId ? rows.find((p) => p.id === selectedId) : undefined;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="运行中"
          value={`${runningCount}/${managed.length}`}
          sub="进程 / 端口在跑（与开关独立）"
          tone={runningCount === managed.length && managed.length > 0 ? 'success' : 'default'}
        />
        <MetricCard
          label="配置漂移"
          value={driftCount}
          sub={driftCount ? '存在 on/up/oc 不一致' : '四个状态一致'}
          tone={driftCount ? 'warning' : 'success'}
        />
        <MetricCard
          label="活动任务"
          value={activeCount}
          sub={activeGlobal ? '有全局写任务执行中' : '写任务全局串行'}
          tone={activeCount ? 'info' : 'default'}
        />
        <MetricCard
          label="最近写操作"
          value={lastTask ? fmtRelative(lastTask.finishedAt ?? lastTask.startedAt) : DASH}
          sub={
            lastTask
              ? `${actionCatalog[lastTask.action].label} · ${
                  lastTask.status === 'succeeded'
                    ? '成功'
                    : lastTask.status === 'failed'
                      ? '失败'
                      : lastTask.status === 'cancelled'
                        ? '已取消'
                        : '执行中'
                }`
              : '本会话还没有写操作'
          }
        />
      </div>

      {readOnly ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <ShieldAlert className="size-4" />
          当前为只读模式，写操作已在桥接层禁用；本页仍可浏览真实状态。
        </div>
      ) : null}

      {activeGlobal ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-xs text-info"
        >
          <Info className="size-4" />
          有全局写任务执行中，其它写按钮已临时禁用（写任务全局串行）。
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>Provider 状态</CardTitle>
              <CardDescription>
                点击一行选中 provider 以启用单家操作；<code className="font-mono">gateway</code> 为叠加层，不参与 on/off。
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton
                action="EnableAll"
                providerIds={managedIds}
                targetLabel="全部 provider"
                affected={affectedNames(rows)}
                details={[
                  { label: '影响', value: '启用全部 provider 并启动进程（--no-login，不自动登录）' },
                  {
                    label: '当前未启用',
                    value: managed.filter((p) => !p.on).length
                      ? managed
                          .filter((p) => !p.on)
                          .map((p) => p.title)
                          .join('、')
                      : '无',
                  },
                ]}
                disabled={readOnly}
              />
              <ActionButton
                action="DisableAll"
                providerIds={managedIds}
                targetLabel="全部 provider"
                affected={affectedNames(rows)}
                details={[
                  { label: '影响', value: '关闭全部开关、停止进程并同步客户端配置' },
                ]}
                disabled={readOnly}
              />
              <ActionButton
                action="Sync"
                targetLabel="客户端配置"
                details={[{ label: '影响', value: '让 opencode / provider 配置与当前开关一致' }]}
                disabled={readOnly}
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>开关</TableHead>
                  <TableHead>进程</TableHead>
                  <TableHead>认证</TableHead>
                  <TableHead>客户端</TableHead>
                  <TableHead>漂移</TableHead>
                  <TableHead className="text-right">端口</TableHead>
                  <TableHead className="hidden lg:table-cell">PID</TableHead>
                  <TableHead className="hidden xl:table-cell">control</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const isSelected = p.id === selectedId;
                  const rowBusy = runningProviderIds.has(p.id);
                  return (
                    <TableRow
                      key={p.id}
                      aria-selected={isSelected}
                      tabIndex={0}
                      onClick={() => onSelect(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(p.id);
                        }
                      }}
                      className={cn(
                        'cursor-pointer outline-none focus-visible:bg-accent/40',
                        isSelected && 'bg-accent/50 hover:bg-accent/60',
                      )}
                    >
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ProviderChip id={p.id} title={p.title} />
                          {p.overlay ? <Badge variant="muted">叠加层</Badge> : null}
                          {rowBusy ? <Badge variant="info">执行中</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <OnBadge p={p} />
                      </TableCell>
                      <TableCell>
                        <StatusDot up={p.up} />
                      </TableCell>
                      <TableCell>
                        <AuthBadge auth={p.auth} />
                      </TableCell>
                      <TableCell>
                        <ClientBadge p={p} />
                      </TableCell>
                      <TableCell>
                        <DriftBadges drift={p.drift} />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {p.port ? p.port : DASH}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs lg:table-cell">
                        {pidText(p)}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                        {p.control || DASH}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <ProviderDetail
          selected={selected}
          rows={rows}
          tasks={tasks}
          runningProviderIds={runningProviderIds}
          readOnly={readOnly}
        />
      </div>
    </>
  );
}

function ProviderDetail({
  selected,
  rows,
  tasks,
  runningProviderIds,
  readOnly,
}: {
  selected: ProviderStatus | undefined;
  rows: ProviderStatus[];
  tasks: Task[];
  runningProviderIds: Set<string>;
  readOnly: boolean;
}) {
  if (!selected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>详情</CardTitle>
          <CardDescription>未选中 provider</CardDescription>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          在上表或上方下拉中选择一家，以查看开关 / 进程 / 客户端的具体组合、认证到期、control 方式与操作按钮。
        </CardContent>
      </Card>
    );
  }

  const providerTask = [...tasks].reverse().find((t) => t.providerIds.includes(selected.id));
  const busy = runningProviderIds.has(selected.id);
  const isGateway = selected.overlay;

  // 仅启用：受影响名单必须列出将被关闭的其它 provider（当前已启用的那些）。
  const willClose = rows.filter((p) => !p.overlay && p.id !== selected.id && p.on);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ProviderChip id={selected.id} title={selected.title} />
          {isGateway ? <Badge variant="muted">叠加层</Badge> : null}
          {busy ? <Badge variant="info">执行中</Badge> : null}
        </CardTitle>
        <CardDescription>四个状态互不推导，请分别确认。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-xs">
        <ul className="flex flex-col gap-1">
          {comboParts(selected).map((part) => (
            <li key={part} className="flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
              <span className="font-mono">{part}</span>
            </li>
          ))}
        </ul>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 p-3">
          <dt className="text-muted-foreground">认证</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            <AuthBadge auth={selected.auth} />
            {selected.auth.expiresAt ? (
              <span className="text-muted-foreground">
                到期 {fmtDateTime(selected.auth.expiresAt)}（{fmtCountdown(selected.auth.expiresAt)}）
              </span>
            ) : (
              <span className="text-muted-foreground">无到期信息</span>
            )}
          </dd>
          <dt className="text-muted-foreground">control</dt>
          <dd className="font-mono">{selected.control || DASH}</dd>
          <dt className="text-muted-foreground">PID</dt>
          <dd className="font-mono">{pidText(selected)}</dd>
          <dt className="text-muted-foreground">端口</dt>
          <dd className="font-mono">{selected.port ? selected.port : DASH}</dd>
        </dl>

        {isGateway ? (
          <div className="rounded-md border border-info/40 bg-info/10 p-3 text-info">
            叠加层：网关不参与 <code className="font-mono">on/off</code>，其「开关」直接等于进程状态；
            启停请使用通用「启动 / 停止」，「仅启用 / 关闭」不适用。
          </div>
        ) : null}

        {selected.drift.length ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-warning">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <TriangleAlert className="size-3.5" />
              配置漂移
            </div>
            <ul className="list-inside list-disc">
              {selected.drift.map((d) => (
                <li key={d}>{DRIFT_NEXT[d]}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {providerTask && providerTask.refreshStatus === 'failed' ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
            命令已完成，状态未确认（{actionCatalog[providerTask.action].label}）。
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <ActionButton
            action="Start"
            providerIds={[selected.id]}
            targetLabel={`${selected.title}（${selected.id}）`}
            details={[
              { label: '影响', value: '启动该反代进程（--no-login，不自动登录）' },
              { label: '当前进程', value: selected.up ? '运行中' : '已停止' },
            ]}
            disabled={readOnly}
            variant="default"
          />
          <ActionButton
            action="Stop"
            providerIds={[selected.id]}
            targetLabel={`${selected.title}（${selected.id}）`}
            details={[{ label: '影响', value: '停止进程并同步移除客户端配置' }]}
            disabled={readOnly}
          />
          <ActionButton
            action="StopKeepOpenCode"
            providerIds={[selected.id]}
            targetLabel={`${selected.title}（${selected.id}）`}
            details={[{ label: '影响', value: '只停止进程，保留 opencode provider 配置' }]}
            disabled={readOnly}
          />
          <ActionButton
            action="Restart"
            providerIds={[selected.id]}
            targetLabel={`${selected.title}（${selected.id}）`}
            details={[
              { label: '影响', value: '停止并重新启动该反代（--no-login）' },
              { label: '当前客户端', value: selected.oc ? '已写入' : selected.ocUserOwned ? '用户自管' : '未写入' },
            ]}
            disabled={readOnly}
          />
          <ActionButton
            action="OnlyEnable"
            providerIds={[selected.id]}
            targetLabel={`${selected.title}（${selected.id}）`}
            affected={willClose.map((p) => `${p.title}（${p.id}）`)}
            details={[
              { label: '将启用', value: `${selected.title}（${selected.id}）` },
              {
                label: '将关闭',
                value: willClose.length
                  ? `${willClose.length} 家其它已启用 provider`
                  : '无其它已启用 provider',
              },
            ]}
            disabled={readOnly || isGateway}
            title={isGateway ? '叠加层不参与 on/off，请改用「启动 / 停止」' : undefined}
          />
          <ActionButton
            action="Disable"
            providerIds={[selected.id]}
            targetLabel={`${selected.title}（${selected.id}）`}
            details={[{ label: '影响', value: '关闭开关、停止进程并同步客户端' }]}
            disabled={readOnly || isGateway}
            title={isGateway ? '叠加层不参与 on/off，请改用「启动 / 停止」' : undefined}
          />
        </div>

        {isGateway ? (
          <div className="flex items-start gap-1.5 text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            「仅启用此家」与「关闭」对 gateway 已禁用：它没有独立 on/off 开关。
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button asChild variant="outline" size="sm">
            <Link to="/logs" search={{ provider: selected.id }}>
              <ScrollText className="size-4" />
              查看日志
            </Link>
          </Button>
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Zap className="size-3.5" />
            操作完成后先重查，再替换状态。
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
