import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Eraser,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Stethoscope,
  Server,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataState } from '@/components/shared/states';
import { LogView } from '@/components/shared/log-view';
import { ProviderSelect } from '@/components/shared/provider-select';
import { TimeText } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useProviders } from '@/lib/query';
import { useSse, type SseEvent } from '@/lib/events';
import { sanitizeOutput } from '@/lib/redact';
import { providerTitle } from '@/lib/provider';
import {
  LINE_OPTIONS,
  MAX_LIVE_LINES,
  parseFollow,
  parseLines,
  useDocumentVisible,
  useLogsText,
} from './use-logs';

/** 手动向上滚动后暂停自动跟随的阈值（px）。 */
const BOTTOM_EPSILON = 12;

interface LogsSearch {
  provider?: string;
  lines?: string;
  filter?: string;
  follow?: string;
}

export function LogsPage() {
  const search = useSearch({ from: '/logs' }) as LogsSearch;
  const navigate = useNavigate();

  const rawProvider = typeof search.provider === 'string' && search.provider ? search.provider : undefined;
  const { lines, invalid: linesInvalid } = useMemo(() => parseLines(search.lines), [search.lines]);
  const { follow, invalid: followInvalid } = useMemo(() => parseFollow(search.follow), [search.follow]);
  const filter = typeof search.filter === 'string' ? search.filter : '';

  const providersRes = useProviders(15000);
  const providers = providersRes.data ?? [];
  const providerUnknown =
    Boolean(rawProvider) && providers.length > 0 && !providers.some((p) => p.id === rawProvider);
  const provider = providerUnknown ? undefined : rawProvider;
  const meta = provider ? providers.find((p) => p.id === provider) : undefined;

  const updateSearch = useCallback(
    (patch: Record<string, string | undefined>) => {
      void navigate({
        to: '/logs',
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
        replace: true,
      });
    },
    [navigate],
  );

  const setFollow = useCallback(
    (next: boolean) => updateSearch({ follow: next ? '1' : '0' }),
    [updateSearch],
  );

  // ---- 快照 + 实时（SSE）
  const logsRes = useLogsText(provider ?? null, lines);
  const visible = useDocumentVisible();
  const [live, setLive] = useState<{ seq: number; lines: string[]; truncated: boolean }>({
    seq: 0,
    lines: [],
    truncated: false,
  });
  const [cleared, setCleared] = useState(false);

  const cap = Math.max(1, Math.min(lines, MAX_LIVE_LINES));

  // provider 变化：丢弃上一家的实时缓冲，避免串台。
  useEffect(() => {
    setLive({ seq: 0, lines: [], truncated: false });
    setCleared(false);
  }, [provider]);

  // 行数档位变小：立即把实时缓冲裁剪到新上限，保持“有界”承诺。
  useEffect(() => {
    setLive((prev) =>
      prev.lines.length > cap
        ? { ...prev, lines: prev.lines.slice(prev.lines.length - cap), truncated: true }
        : prev,
    );
  }, [cap]);

  const onSseEvent = useCallback(
    (e: SseEvent) => {
      if (e.event === 'reset') {
        setLive({ seq: 0, lines: [], truncated: false });
        return;
      }
      if (e.event !== 'log') return;
      let payload: { line?: unknown; seq?: unknown };
      try {
        payload = JSON.parse(e.data) as { line?: unknown; seq?: unknown };
      } catch {
        return;
      }
      const line = typeof payload.line === 'string' ? payload.line : '';
      // seq 缺失或非法时不做序号判断，但仍按上限追加（不整段重置）。
      const seq =
        typeof payload.seq === 'number' && Number.isFinite(payload.seq) && payload.seq > 0
          ? payload.seq
          : null;
      setLive((prev) => {
        if (seq !== null) {
          // 同一 seq 是重复事件：忽略。
          if (prev.seq > 0 && seq === prev.seq) return prev;
          // seq 回退 = 重连后服务端从 1 重新计数：重置旧连接缓冲，避免重复追加。
          if (prev.seq > 0 && seq < prev.seq) {
            return { seq, lines: [line], truncated: false };
          }
        }
        const next = [...prev.lines, line];
        const truncated = prev.truncated || next.length > cap;
        return {
          seq: seq ?? prev.seq,
          lines: next.length > cap ? next.slice(next.length - cap) : next,
          truncated,
        };
      });
    },
    [cap],
  );

  const ssePath =
    follow && visible && provider
      ? `/logs/stream?provider=${encodeURIComponent(provider)}`
      : null;
  useSse(ssePath, onSseEvent);

  const liveActive = live.seq > 0;
  const snapshotText = logsRes.data ?? '';
  const displayText = cleared ? '' : liveActive ? live.lines.join('\n') : snapshotText;

  // ---- 过滤 + 有界：与 LogView 使用同一套行窗口口径（先按上限取最近行，再过滤）。
  const { windowLines, matchedLines } = useMemo(() => {
    if (displayText === '') return { windowLines: 0, matchedLines: 0 };
    const clean = sanitizeOutput(displayText);
    const all = clean.split('\n');
    const capped = all.length > lines ? all.slice(all.length - lines) : all;
    const q = filter.trim().toLowerCase();
    const matched = q ? capped.filter((l) => l.toLowerCase().includes(q)) : capped;
    return { windowLines: capped.length, matchedLines: matched.length };
  }, [displayText, filter, lines]);

  // 与 LogView 顶部“仅显示最近 N 行”保持同一文案与同一判定。
  const truncated = windowLines >= lines || live.truncated;
  const hasFilter = filter.trim() !== '';
  const readAt = logsRes.lastSuccessAt;

  // ---- 滚动与跟随
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow, displayText]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON;
    if (follow && !atBottom) setFollow(false);
  }, [follow, setFollow]);

  // `End` 跳底部并恢复跟随；`p` 暂停/继续；`/` 聚焦过滤框。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'End') {
        e.preventDefault();
        setFollow(true);
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setFollow(!follow);
      } else if (e.key === '/') {
        e.preventDefault();
        filterRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [follow, setFollow]);

  const providerOptions = providers.map((p) => ({ id: p.id, title: p.title, overlay: p.overlay }));
  const headerTitle = provider ? `日志 · ${providerTitle(provider, meta?.title)}` : '日志';

  const controls = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">provider</span>
        <ProviderSelect
          providers={providerOptions}
          value={provider}
          onChange={(v) => updateSearch({ provider: v })}
          allowAll={false}
          className="w-44"
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">行数</span>
        <Select value={String(lines)} onValueChange={(v) => updateSearch({ lines: v })}>
          <SelectTrigger className="w-24" aria-label="尾部行数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LINE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} 行
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="logs-follow"
          checked={follow}
          onCheckedChange={(v) => setFollow(v)}
          aria-label="跟随最新日志"
        />
        <label htmlFor="logs-follow" className="text-xs text-muted-foreground">
          跟随
        </label>
      </div>

      <div className="flex min-w-48 flex-1 items-center gap-2">
        <Input
          ref={filterRef}
          value={filter}
          onChange={(e) => updateSearch({ filter: e.target.value || undefined })}
          placeholder="过滤当前已加载文本（/ 聚焦）"
          aria-label="过滤日志"
          className="h-8"
        />
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {hasFilter ? `${matchedLines} / ${windowLines} 行匹配` : `${windowLines} 行`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          最近读取 <TimeText iso={readAt} />
        </span>
        <Badge variant={liveActive ? 'success' : 'muted'}>
          {liveActive ? '流式 (SSE)' : '快照 (GET /logs)'}
        </Badge>
        {truncated ? <Badge variant="warning">仅显示最近 {lines} 行</Badge> : null}
      </div>
    </div>
  );

  const urlNotice =
    linesInvalid || followInvalid || providerUnknown ? (
      <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
        <Badge variant="warning">URL 参数已回退默认值</Badge>
        <span>
          {linesInvalid ? `lines 仅支持 ${LINE_OPTIONS.join(' / ')}；` : ''}
          {followInvalid ? 'follow 仅支持 1 / 0；' : ''}
          {providerUnknown ? `provider「${rawProvider}」不在已知清单；` : ''}
          已按默认视图展示。
        </span>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={headerTitle}
        description="进程 stdout/stderr 聚合日志：渲染前已剥离控制序列并脱敏，缓冲有界。"
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/providers" search={provider ? { provider } : {}}>
                <Server className="size-4" />
                服务页
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/diagnostics" search={provider ? { provider } : {}}>
                <Stethoscope className="size-4" />
                诊断页
              </Link>
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          {controls}
          {urlNotice}
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col">
        <CardContent className="flex min-h-0 flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ScrollText className="size-3.5" />
              来源：router.mjs logs（进程 stdout/stderr 聚合）
            </span>
            <span className="flex items-center gap-2">
              {cleared ? (
                <Button variant="ghost" size="sm" onClick={() => setCleared(false)}>
                  恢复显示
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!displayText}
                  onClick={() => setCleared(true)}
                  title="仅清空本页显示缓冲，磁盘日志不会被删除"
                >
                  <Eraser className="size-4" />
                  清空显示
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => logsRes.refetch()}
                disabled={!provider}
              >
                <RefreshCw className="size-4" />
                重读
              </Button>
              <Button
                variant={follow ? 'outline' : 'default'}
                size="sm"
                disabled={!provider}
                onClick={() => setFollow(!follow)}
              >
                {follow ? <Pause className="size-4" /> : <Play className="size-4" />}
                {follow ? '暂停跟随' : '继续跟随'}
              </Button>
            </span>
          </div>

          {!provider ? (
            <div className="py-8">
              <Empty
                icon={<ScrollText />}
                title={providerUnknown ? 'URL 中的 provider 不存在' : '请选择 provider'}
                description={
                  providerUnknown
                    ? `「${rawProvider}」不在已知 provider 清单，日志读取需要合法的 provider。`
                    : '日志按 provider 读取；选择后可查看最近输出并实时跟随。'
                }
              />
            </div>
          ) : (
            <div
              ref={scrollRef}
              onScroll={onScroll}
              tabIndex={0}
              aria-label="日志正文"
              className="h-[calc(100vh_-_26rem)] min-h-[320px] overflow-auto rounded-md border border-border bg-muted/20"
            >
              {cleared ? (
                <div className="p-4 text-xs text-muted-foreground">
                  本页显示缓冲已清空（磁盘日志未删除）。
                </div>
              ) : liveActive ? (
                <LogView text={displayText} filter={filter || undefined} maxLines={lines} />
              ) : (
                <DataState
                  res={logsRes}
                  onRetry={() => logsRes.refetch()}
                  loadingLabel="正在读取日志…"
                  isEmpty={(t) => t.trim() === ''}
                  empty={
                    <div className="py-6">
                      <Empty
                        icon={<ScrollText />}
                        title="该 provider 暂无日志输出"
                        description={
                          meta && !meta.up
                            ? '该 provider 当前进程未运行，可能因此没有日志。'
                            : '读取成功但内容为空，可能尚未产生日志。'
                        }
                      />
                    </div>
                  }
                >
                  {(t) => <LogView text={t} filter={filter || undefined} maxLines={lines} />}
                </DataState>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
