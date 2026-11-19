import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/shared/action-button';
import { MetricCard } from '@/components/shared/metric-card';
import { PageHeader } from '@/components/shared/page-header';
import { ProviderSelect } from '@/components/shared/provider-select';
import { DataState } from '@/components/shared/states';
import { HealthIcon, ProviderChip, TimeText } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AccountGroup, Task } from '@/lib/contract';
import { DASH } from '@/lib/format';
import { ApiError } from '@/lib/api';
import { clampText, sanitizeOutput } from '@/lib/redact';
import { useAccountCheck, useAccountGroups, useEnv, useProviders } from '@/lib/query';
import { useActions } from '@/lib/action-store';
import {
  accountMarker,
  activeAccount,
  buildCheckIndex,
  countCheckedIssues,
  countHealth,
  healthText,
  mergeCheckHealth,
} from './accounts-model';

/** 页面级 `r` 刷新（对齐 03 §5.5）：输入/弹层聚焦时不触发。 */
function useRefreshHotkey(refetch: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (el?.closest('[role="dialog"],[role="listbox"],[role="menu"],[role="combobox"]')) return;
      e.preventDefault();
      refetch();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refetch]);
}

function taskStatusText(status: Task['status'] | undefined): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return DASH;
  }
}

function Legend() {
  const items: Array<{ symbol: string; text: string }> = [
    { symbol: '*', text: '当前生效' },
    { symbol: '+', text: '参与轮询' },
    { symbol: '-', text: '停用' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">图例</span>
      {items.map((it) => (
        <span key={it.symbol} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="font-mono text-sm text-foreground">
            {it.symbol}
          </span>
          {it.text}
        </span>
      ))}
    </div>
  );
}

/** 登录 / 添加账号：浏览器不能接管 stdin，只发起并等待外部终端完成。 */
function WaitingPanel({
  provider,
  action,
  startedAt,
  onCancel,
}: {
  provider: string;
  action: 'Login' | 'AddAccount';
  startedAt: number;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const command =
    action === 'Login' ? `node router.mjs login ${provider}` : `node router.mjs account add ${provider}`;

  return (
    <div role="status" className="flex flex-col gap-1 rounded-md border border-info/40 bg-info/5 p-3 text-xs">
      <div className="font-medium">等待外部终端完成</div>
      <div>
        已在原生终端发起：<code className="font-mono">{command}</code>
      </div>
      <div className="text-muted-foreground">
        请在原生终端完成扫码 / 输入；本页不接收你的输入，也不代执行。
      </div>
      <div className="text-muted-foreground">状态：等待中 · 已等待 {seconds}s</div>
      <div>
        <Button size="sm" variant="outline" onClick={onCancel}>
          取消等待（不会终止终端进程）
        </Button>
      </div>
    </div>
  );
}

function PreviewPanel({
  group,
  previewKey,
  task,
}: {
  group: AccountGroup;
  previewKey: string;
  task: Task | null;
}) {
  const account = group.accounts.find((a) => a.key === previewKey) ?? null;
  const active = activeAccount(group);
  return (
    <div className="flex flex-col gap-1 rounded-md border border-info/40 bg-info/5 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">切换预览（dry-run，不写配置）</span>
        <span className="text-muted-foreground">状态：{taskStatusText(task?.status)}</span>
      </div>
      <div>
        目标账号：<span className="font-medium">{account?.name || previewKey}</span>
        <span className="ml-1 font-mono text-muted-foreground">（{previewKey}）</span>
      </div>
      <div>
        当前生效：<span className="font-mono">{active?.key ?? DASH}</span>
        {active ? ` · ${active.name}` : ''}
      </div>
      <div className="text-muted-foreground">将写入账号配置并重启对应反代；确认前不改变生效项。</div>
      {task?.stdout ? (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">
          {sanitizeOutput(task.stdout).trim()}
        </pre>
      ) : null}
      {task?.stderr ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
          {sanitizeOutput(task.stderr).trim()}
        </pre>
      ) : null}
      {task?.truncated ? <div className="text-muted-foreground">仅显示最近内容</div> : null}
      {task?.refreshStatus === 'failed' ? (
        <div className="text-warning">命令已完成，状态未确认</div>
      ) : null}
    </div>
  );
}

function AccountGroupCard({ group, readOnly }: { group: AccountGroup; readOnly: boolean }) {
  const { run, tasks, busy } = useActions();
  const [preview, setPreview] = useState<{ key: string; actionId: string } | null>(null);
  const [waiting, setWaiting] = useState<{ action: 'Login' | 'AddAccount'; startedAt: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const active = activeAccount(group);
  const disabledLabels = group.accounts
    .filter((a) => !a.enabled)
    .map((a) => `${a.name || a.key}（${a.key}）`);
  const previewTask = preview ? tasks.find((t) => t.actionId === preview.actionId) ?? null : null;

  // dry-run 只在“本次会话 + 同一账号池 + 同一生效账号”内有效：
  // 账号变化、预览失败/取消、正式切换完成后都必须重置，避免拿旧预览放行写入。
  const activeKey = active?.key ?? null;
  const accountSignature = group.accounts.map((a) => a.key).join('|');
  useEffect(() => {
    setPreview(null);
  }, [group.id, activeKey, accountSignature]);

  useEffect(() => {
    if (!preview || !previewTask) return;
    if (previewTask.status === 'failed' || previewTask.status === 'cancelled') {
      setPreview(null);
      toast.error('切换预览未成功', { description: '请重新预览（dry-run）后再切换' });
    }
  }, [preview, previewTask]);

  const startWaiting = useCallback((action: 'Login' | 'AddAccount') => {
    setWaiting({ action, startedAt: Date.now() });
  }, []);

  const runPreview = useCallback(
    async (key: string) => {
      setError(null);
      setPreview(null);
      try {
        const task = await run({
          action: 'SwitchAccountPreview',
          providerIds: [group.id],
          accountKey: key,
          dryRun: true,
        });
        setPreview({ key, actionId: task.actionId });
        toast.success('切换预览已提交', { description: `任务 ${task.actionId}` });
      } catch (err) {
        const message = err instanceof ApiError ? err.message : (err as Error).message;
        setError(message);
        toast.error('预览失败', { description: message });
      }
    },
    [group.id, run],
  );

  /** 正式切换门槛：同一账号、同一会话、且 dry-run 任务已成功完成。 */
  function previewReady(key: string): boolean {
    if (!preview || preview.key !== key) return false;
    return previewTask?.status === 'succeeded';
  }

  function rowDetails(key: string): Array<{ label: string; value: string }> {
    const account = group.accounts.find((a) => a.key === key);
    return [
      { label: '目标账号', value: `${account?.name || key}（${key}）` },
      { label: '当前生效', value: active?.key ?? DASH },
      { label: '预览结果', value: taskStatusText(previewTask?.status) },
    ];
  }

  const accountActions = (key: string) =>
    group.switchable ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly || busy}
          onClick={() => void runPreview(key)}
        >
          预览切换
        </Button>
        <ActionButton
          action="SwitchAccount"
          providerIds={[group.id]}
          accountKey={key}
          disabled={readOnly || !previewReady(key)}
          title={
            previewReady(key)
              ? undefined
              : preview && preview.key === key && previewTask?.status !== 'failed'
                ? '预览进行中，成功后才能切换'
                : '请先预览切换（dry-run）并等待成功'
          }
          targetLabel={`${group.title} · ${key}`}
          details={rowDetails(key)}
          onDone={() => setPreview(null)}
        >
          切换
        </ActionButton>
      </div>
    ) : (
      <span className="text-muted-foreground">换号请重新登录</span>
    );

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderChip id={group.id} title={group.title} />
            {group.kind ? (
              <span className="font-mono text-[11px] text-muted-foreground">{group.kind}</span>
            ) : null}
            {group.switchable ? (
              <Badge variant="info">可切换</Badge>
            ) : (
              <Badge variant="muted">不可切换</Badge>
            )}
            <span className="text-xs text-muted-foreground">{group.accounts.length} 个账号</span>
            <span className="text-xs text-muted-foreground">
              当前生效：<span className="font-mono">{active?.key ?? DASH}</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              action="EnableAllAccounts"
              providerIds={[group.id]}
              disabled={readOnly || !disabledLabels.length}
              title={disabledLabels.length ? undefined : '没有停用账号，无需恢复'}
              affected={disabledLabels}
              targetLabel={group.title}
              details={[{ label: '范围', value: `仅限 ${group.title}` }]}
            >
              恢复整池
            </ActionButton>
            <ActionButton
              action="Login"
              providerIds={[group.id]}
              disabled={readOnly}
              onDone={() => startWaiting('Login')}
            >
              登录
            </ActionButton>
            {group.switchable ? (
              <ActionButton
                action="AddAccount"
                providerIds={[group.id]}
                disabled={readOnly}
                onDone={() => startWaiting('AddAccount')}
              >
                添加账号
              </ActionButton>
            ) : null}
          </div>
        </div>
        {!group.switchable ? (
          <div className="text-xs text-muted-foreground">
            该 provider 不支持普通槽位切换（例如单凭证来源）；换号请重新登录。
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {preview ? <PreviewPanel group={group} previewKey={preview.key} task={previewTask} /> : null}
        {waiting ? (
          <WaitingPanel
            provider={group.id}
            action={waiting.action}
            startedAt={waiting.startedAt}
            onCancel={() => setWaiting(null)}
          />
        ) : null}
        {error ? <div className="text-xs text-destructive">{error}</div> : null}

        {group.accounts.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>状态</TableHead>
                <TableHead>key</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>uid</TableHead>
                <TableHead>参与轮询</TableHead>
                <TableHead>当前生效</TableHead>
                <TableHead>健康</TableHead>
                <TableHead>详情</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.accounts.map((account) => {
                const marker = accountMarker(account);
                return (
                  <TableRow key={account.key}>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span aria-hidden className="font-mono text-sm">
                          {marker.symbol}
                        </span>
                        <span className="text-xs">{marker.text}</span>
                      </span>
                    </TableCell>
                    <TableCell className="font-mono">{account.key}</TableCell>
                    <TableCell>{account.name || DASH}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {account.uid ?? DASH}
                    </TableCell>
                    <TableCell>{account.enabled ? '参与轮询' : '不参与'}</TableCell>
                    <TableCell>{account.active ? '当前生效' : '未生效'}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <HealthIcon level={account.health.level} />
                          <span className="text-xs">{healthText(account.health.level)}</span>
                        </span>
                        {account.health.notes.length ? (
                          <ul className="list-inside list-disc text-[11px] text-muted-foreground">
                            {account.health.notes.map((note, i) => (
                              <li key={i} className="break-words">
                                {note}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {account.health.level === 'error' ? (
                          <ActionButton
                            action="Login"
                            providerIds={[group.id]}
                            size="sm"
                            variant="outline"
                            disabled={readOnly}
                            onDone={() => startWaiting('Login')}
                          >
                            重新登录
                          </ActionButton>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {account.detail ? clampText(account.detail, 120) : DASH}
                    </TableCell>
                    <TableCell>{accountActions(account.key)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <Empty
            title="该 provider 当前没有账号"
            description="未登录或没有账号池；可在原生终端登录或添加账号（本页不接管 stdin）。"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton
                  action="Login"
                  providerIds={[group.id]}
                  disabled={readOnly}
                  onDone={() => startWaiting('Login')}
                >
                  登录
                </ActionButton>
                {group.switchable ? (
                  <ActionButton
                    action="AddAccount"
                    providerIds={[group.id]}
                    disabled={readOnly}
                    onDone={() => startWaiting('AddAccount')}
                  >
                    添加账号
                  </ActionButton>
                ) : null}
              </div>
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

export function AccountsPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const rawProvider = typeof search.provider === 'string' && search.provider ? search.provider : undefined;
  const navigate = useNavigate();
  const env = useEnv();
  const readOnly = Boolean(env.data?.readOnly);

  const providersRes = useProviders();
  const knownProviders = providersRes.data ?? [];
  const providerUnknown =
    Boolean(rawProvider) && knownProviders.length > 0 && !knownProviders.some((p) => p.id === rawProvider);
  const provider = providerUnknown ? undefined : rawProvider;

  const groupsRes = useAccountGroups(provider);
  const [checkEnabled, setCheckEnabled] = useState(false);
  const checkRes = useAccountCheck(checkEnabled);

  const groupsRefetch = groupsRes.refetch;
  const checkRefetch = checkRes.refetch;
  const refetchAll = useCallback(() => {
    groupsRefetch();
    if (checkEnabled) checkRefetch();
  }, [groupsRefetch, checkRefetch, checkEnabled]);
  useRefreshHotkey(refetchAll);

  const setProvider = useCallback(
    (next?: string) => {
      const nextSearch: Record<string, unknown> = { ...search };
      if (next) nextSearch.provider = next;
      else delete nextSearch.provider;
      void navigate({ to: '/accounts', search: nextSearch, replace: true });
    },
    [navigate, search],
  );

  const options = useMemo(() => {
    const fromProviders = (providersRes.data ?? [])
      .filter((p) => !p.overlay)
      .map((p) => ({ id: p.id, title: p.title, overlay: p.overlay }));
    if (fromProviders.length) return fromProviders;
    return (groupsRes.data ?? []).map((g) => ({ id: g.id, title: g.title }));
  }, [providersRes.data, groupsRes.data]);

  const checkIndex = useMemo(() => buildCheckIndex(checkRes.data), [checkRes.data]);
  const groups = useMemo(
    () => (groupsRes.data ?? []).map((g) => mergeCheckHealth(g, checkIndex)),
    [groupsRes.data, checkIndex],
  );
  const stats = useMemo(() => countHealth(groups), [groups]);
  const checkedIssues = useMemo(() => countCheckedIssues(checkRes.data), [checkRes.data]);

  const checkSub = !checkEnabled
    ? '未运行体检'
    : checkRes.error
      ? '体检失败'
      : checkRes.data
        ? `体检：${checkedIssues} 项需处理`
        : '体检中…';

  function runCheck() {
    if (checkEnabled) checkRefetch();
    else setCheckEnabled(true);
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="账号"
        description="当前生效、参与轮询、停用与可切换状态；切换前先 dry-run 预览，完成后重新查询。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ProviderSelect providers={options} value={provider} onChange={setProvider} className="w-44" />
            <Button
              size="sm"
              variant={checkEnabled ? 'default' : 'outline'}
              onClick={runCheck}
            >
              运行体检
            </Button>
            <Button size="sm" variant="outline" onClick={refetchAll}>
              <RefreshCw />
              刷新
            </Button>
          </div>
        }
      />

      {readOnly ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          当前为只读模式，写操作已在桥接层禁用
        </div>
      ) : null}

      <Legend />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCard label="账号数" value={stats.total} sub={`${groups.length} 个 provider`} />
        <MetricCard label="生效账号" value={stats.active} sub="active=true" />
        <MetricCard
          label="健康提醒"
          value={stats.issues}
          tone={stats.issues ? 'warning' : 'default'}
          sub={checkSub}
        />
      </div>

      {providerUnknown ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
          <Badge variant="warning">URL 参数已回退默认值</Badge>
          <span>provider「{rawProvider}」不在已知清单；已展示全部账号池。</span>
        </div>
      ) : null}

      <DataState
        res={groupsRes}
        onRetry={refetchAll}
        loadingLabel="正在读取账号…"
        isEmpty={(data) => data.length === 0}
        empty={
          <Empty
            title="没有账号数据"
            description="账号池为空是合法结果；选择具体 provider 后可在此登录或添加账号。"
          />
        }
      >
        {() => (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <AccountGroupCard key={group.id} group={group} readOnly={readOnly} />
            ))}
          </div>
        )}
      </DataState>

      <div className="text-xs text-muted-foreground">
        账号数据 <TimeText iso={groupsRes.lastSuccessAt} />
        {checkEnabled && !checkRes.error && checkRes.data
          ? ` · 体检 ${checkedIssues} 项需处理（只报有问题的账号）`
          : ''}
      </div>
    </div>
  );
}
