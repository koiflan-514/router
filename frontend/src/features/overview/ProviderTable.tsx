import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from 'lucide-react';
import { AuthBadge, DriftBadges, ProviderChip, StatusDot } from '@/components/shared/status';
import { ProviderSelect } from '@/components/shared/provider-select';
import { Toolbar } from '@/components/shared/surface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/cn';
import { DASH, fmtInt } from '@/lib/format';
import type { ProviderStatus } from '@/lib/contract';
import {
  driftDetailText,
  quotaBarFor,
  quotaSummaryText,
  type QuotaIndex,
  type SortDir,
  type SortKey,
} from './overview-model';

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
  className,
  title,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
  /** 覆盖默认的「按<label>排序」提示（合并列时说明并入本列的徽标）。 */
  title?: string;
}) {
  const active = activeKey === sortKey;
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <TableHead aria-sort={ariaSort} className={cn(align === 'right' && 'text-right', className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] px-1 py-0.5 text-[11px] font-semibold tracking-wide uppercase outline-none transition-colors duration-150 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          align === 'right' && 'flex-row-reverse',
          active && 'text-text-primary',
        )}
        title={title ?? `按${label}排序`}
      >
        <span>{label}</span>
        {/* 指示图标在窄列（xl 左栏）隐藏，把宽度留给状态徽标与额度列；排序方向仍由 aria-sort 表达。 */}
        <Icon className="hidden size-3 2xl:inline" aria-hidden />
      </button>
    </TableHead>
  );
}

/** 客户端筛选：关键词（q）与 provider 焦点（provider）均进 URL。 */export function ProviderFilters({
  providers,
  q,
  provider,
  onQ,
  onProvider,
}: {
  providers: ProviderStatus[];
  q: string;
  provider: string | undefined;
  onQ: (v: string) => void;
  onProvider: (v: string | undefined) => void;
}) {
  const filtered = Boolean(q || provider);
  return (
    <Toolbar aria-label="provider 筛选" surface={false} className="px-0 py-0">
      <div className="relative min-w-[9rem] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" aria-hidden />
        <Input
          type="search"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="按名称或 ID 筛选"
          aria-label="按 provider 名称或 ID 筛选"
          className="pl-8"
        />
      </div>
      <ProviderSelect
        providers={providers.map((p) => ({ id: p.id, title: p.title, overlay: p.overlay }))}
        value={provider}
        onChange={onProvider}
        allLabel="全部 provider"
        className="w-40 shrink-0"
      />
      {filtered ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onQ('');
            onProvider(undefined);
          }}
        >
          <X className="size-3.5" aria-hidden />
          清除筛选
        </Button>
      ) : null}
      <span className="text-[11px] whitespace-nowrap text-text-tertiary">共 {fmtInt(providers.length)} 条</span>
    </Toolbar>
  );
}

function OnCell({ p }: { p: ProviderStatus }) {
  if (p.overlay) {
    return (
      <Badge variant="info" aria-label="网关为叠加层，不适用开关" className="whitespace-nowrap">
        叠加
      </Badge>
    );
  }
  return (
    <Badge variant={p.on ? 'success' : 'muted'} aria-label={p.on ? '开关：开' : '开关：关'} className="whitespace-nowrap">
      {p.on ? '开' : '关'}
    </Badge>
  );
}

function ClientCell({ p }: { p: ProviderStatus }) {
  if (p.ocUserOwned) {
    return (
      <Badge variant="muted" aria-label="opencode 由用户自管" className="whitespace-nowrap">
        用户自管
      </Badge>
    );
  }
  return (
    <Badge
      variant={p.oc ? 'success' : 'warning'}
      aria-label={p.oc ? 'opencode：已写入' : 'opencode：未写入'}
      className="whitespace-nowrap"
    >
      {p.oc ? '已写入' : '未写入'}
    </Badge>
  );
}

/**
 * 额度单元格：摘要文字 + 可算占比时的一条细进度条。
 *
 * 行高固定为「一行摘要 + 一条 4px 进度条」，摘要过长以省略号截断（完整文本在 `title`），
 * 这样矩阵里所有行等高，也不会把最后一列撑出容器。
 */
function QuotaCell({ row, loading = false }: { row: Parameters<typeof quotaBarFor>[0]; loading?: boolean }) {
  const text = quotaSummaryText(row);
  const bar = quotaBarFor(row);
  // 加载中且该来源尚无行：显示灰字「读取中」，避免 `—` 被读成「确实没有额度」。
  if (loading && !row) {
    return (
      <div className="flex h-7 min-w-[2.5rem] max-w-[14rem] flex-col justify-center gap-1">
        <span
          className="block overflow-hidden text-[11px] leading-4 text-ellipsis whitespace-nowrap text-text-tertiary"
          title="额度接口尚未返回；— 不代表没有额度"
          data-quota-state="loading"
        >
          读取中
        </span>
        <span aria-hidden className="block h-1" />
      </div>
    );
  }
  return (
    <div className="flex h-7 min-w-[2.5rem] max-w-[14rem] flex-col justify-center gap-1">
      <span className="block overflow-hidden text-[11px] leading-4 text-ellipsis whitespace-nowrap text-text-secondary" title={text}>
        {text}
      </span>
      {bar ? (
        <Progress
          value={bar.pct}
          aria-label={`${bar.label}剩余占比`}
          aria-valuetext={`${Math.round(bar.pct)}%`}
          className="h-1"
        />
      ) : (
        <span aria-hidden className="block h-1" />
      )}
    </div>
  );
}

/**
 * 总览 Provider 矩阵：四态独立徽标 + 端口/模型（null≠0）+ 额度条；漂移 badge 并入「进程·漂移」列。
 *
 * 宽度预算：xl 视口（1440px）下左栏约 790px，7 列必须全部装下、无横向裁切：
 * - provider 列用 compact chip（只显示名称，`title` 给「名称 (id)」）；
 * - 「进程·漂移」列同时承载进程状态与漂移 badge（明细只在详情抽屉，行内不放二级小字）；
 *   无漂移时只显示进程状态，**不渲染空态占位**——否则「运行中 —」会被误读成「进程未知」；
 * - 「端口」与「模型数」合并成一列（排序仍按 port）；
 * - **移除「跳转」列**——行点击已打开详情抽屉，抽屉里有「前往服务页」。
 * 所有状态/徽标单元格 `whitespace-nowrap`，额度列固定行高并以省略号截断，
 * 因此每行等高、最后一列不会被容器裁掉；`<2xl` 时排序图标隐藏（aria-sort 仍表达方向）。
 */
export function ProviderTable({
  providers,
  quotaIndex,
  sortKey,
  sortDir,
  onSort,
  onSelect,
  selectedId,
  quotaLoading = false,
}: {
  providers: ProviderStatus[];
  quotaIndex: QuotaIndex;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onSelect: (id: string) => void;
  selectedId?: string;
  /** `/api/quota` 首次加载中：无额度行的来源显示「读取中」，不改既有 `—` 语义。 */
  quotaLoading?: boolean;
}) {
  return (
    <Table containerProps={{ 'aria-label': 'provider 状态矩阵，可横向滚动' }}>
      <TableHeader>
        <TableRow>
          <SortHeader label="Provider" sortKey="id" activeKey={sortKey} dir={sortDir} onSort={onSort} className="px-2" />
          <SortHeader label="开关" sortKey="on" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader
            label="进程·漂移"
            sortKey="up"
            activeKey={sortKey}
            dir={sortDir}
            onSort={onSort}
            className="px-2"
            title="按进程状态排序；漂移徽标并入本列，明细见行详情"
          />
          <SortHeader label="认证" sortKey="auth" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="客户端" sortKey="client" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="端口·模型" sortKey="port" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
          <TableHead className="px-2">额度</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.map((p) => {
          const selected = selectedId === p.id;
          return (
            <TableRow
              key={p.id}
              data-selected={selected ? 'true' : undefined}
              className={cn('cursor-pointer', selected && 'bg-accent-selected')}
              onClick={() => onSelect(p.id)}
            >
              <TableCell className="px-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(p.id);
                  }}
                  className="flex items-center gap-2 rounded-[4px] px-1 py-0 text-left whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  aria-expanded={selected}
                >
                  <ProviderChip id={p.id} title={p.title} compact className="[&>span:last-child]:text-[11px]" />
                  {p.overlay ? (
                    <Badge variant="info" className="whitespace-nowrap">
                      叠加
                    </Badge>
                  ) : null}
                  <span className="sr-only">查看详情</span>
                </button>
              </TableCell>
              <TableCell className="whitespace-nowrap px-2">
                <OnCell p={p} />
              </TableCell>
              <TableCell className="whitespace-nowrap px-2">
                {/*
                  进程状态 + 漂移同一列：漂移只显示首个 badge（其余用 +N 计数，完整文案在 title），
                  明细留在详情抽屉。无漂移时**不渲染空态**（旧行为会在「运行中」后追加一个 `—`，
                  被读成「进程未知/缺失」）；这样任意组合都是一行，行高恒等。
                */}
                <span
                  className="inline-flex items-center gap-1.5 whitespace-nowrap"
                  title={p.drift.length ? driftDetailText(p) : undefined}
                  data-drift={p.drift.length ? p.drift.join(' ') : undefined}
                  data-drift-row={p.drift.length ? 'true' : undefined}
                >
                  <StatusDot up={p.up} />
                  {p.drift.length > 0 ? <DriftBadges drift={p.drift.slice(0, 1)} /> : null}
                  {p.drift.length > 1 ? (
                    <span className="text-[11px] whitespace-nowrap text-text-tertiary">
                      +{p.drift.length - 1}
                      <span className="sr-only">项漂移（完整说明见详情）</span>
                    </span>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap px-2">
                <AuthBadge auth={p.auth} />
              </TableCell>
              <TableCell className="whitespace-nowrap px-2">
                <ClientCell p={p} />
              </TableCell>
              <TableCell className="text-right font-mono text-[11px] whitespace-nowrap tabular-nums">
                <span className="inline-flex items-center gap-1.5" title={`端口 ${p.port > 0 ? p.port : DASH} · 模型 ${p.models === null ? DASH : fmtInt(p.models)}`}>
                  <span>{p.port > 0 ? p.port : DASH}</span>
                  <span aria-hidden className="text-text-tertiary">/</span>
                  <span className="text-text-secondary">{p.models === null ? DASH : fmtInt(p.models)}</span>
                  <span className="sr-only">{`端口、模型数`}</span>
                </span>
              </TableCell>
              <TableCell className="px-2">
                {p.overlay ? (
                  <span className="flex h-7 items-center text-text-tertiary">{DASH}</span>
                ) : (
                  <QuotaCell row={quotaIndex.get(p.id)} loading={quotaLoading} />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
