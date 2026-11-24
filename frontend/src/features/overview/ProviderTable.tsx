import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
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
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = activeKey === sortKey;
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <TableHead aria-sort={ariaSort} className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide outline-none transition-colors duration-150 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          align === 'right' && 'flex-row-reverse',
          active && 'text-text-primary',
        )}
        title={`按${label}排序`}
      >
        {label}
        <Icon className="size-3" aria-hidden />
      </button>
    </TableHead>
  );
}

/** 客户端筛选：关键词（q）与 provider 焦点（provider）均进 URL。 */
export function ProviderFilters({
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
      <div className="relative min-w-[12rem] flex-1">
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
        className="w-[12rem]"
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
      <span className="text-[11px] text-text-tertiary">共 {fmtInt(providers.length)} 条</span>
    </Toolbar>
  );
}

const DESTINATIONS = [
  { to: '/providers', label: '服务' },
  { to: '/logs', label: '日志' },
  { to: '/diagnostics', label: '诊断' },
] as const;

function OnCell({ p }: { p: ProviderStatus }) {
  if (p.overlay) {
    return (
      <Badge variant="info" aria-label="网关为叠加层，不适用开关">
        叠加
      </Badge>
    );
  }
  return (
    <Badge variant={p.on ? 'success' : 'muted'} aria-label={p.on ? '开关：开' : '开关：关'}>
      {p.on ? '开' : '关'}
    </Badge>
  );
}

function ClientCell({ p }: { p: ProviderStatus }) {
  if (p.ocUserOwned) {
    return (
      <Badge variant="muted" aria-label="opencode 由用户自管">
        用户自管
      </Badge>
    );
  }
  return (
    <Badge variant={p.oc ? 'success' : 'warning'} aria-label={p.oc ? 'opencode：已写入' : 'opencode：未写入'}>
      {p.oc ? '已写入' : '未写入'}
    </Badge>
  );
}

/** 额度单元格：摘要文字 + 可算占比时的一条细进度条。 */
function QuotaCell({ row }: { row: Parameters<typeof quotaBarFor>[0] }) {
  const text = quotaSummaryText(row);
  const bar = quotaBarFor(row);
  return (
    <div className="flex max-w-[11rem] flex-col gap-1">
      <span className="truncate text-[11px] text-text-secondary" title={text}>
        {text}
      </span>
      {bar ? (
        <Progress
          value={bar.pct}
          aria-label={`${bar.label}剩余占比`}
          aria-valuetext={`${Math.round(bar.pct)}%`}
          className="h-1"
        />
      ) : null}
    </div>
  );
}

/**
 * 总览 Provider 矩阵：四态独立徽标 + models(null≠0) + 额度条 + 漂移 badge。
 * 保留原有所有列、排序、选中与列表语义（仅视觉改为 Fluent 紧凑密度）。
 */
export function ProviderTable({
  providers,
  quotaIndex,
  sortKey,
  sortDir,
  onSort,
  onSelect,
  selectedId,
}: {
  providers: ProviderStatus[];
  quotaIndex: QuotaIndex;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onSelect: (id: string) => void;
  selectedId?: string;
}) {
  return (
    <Table containerProps={{ 'aria-label': 'provider 状态矩阵，可横向滚动' }}>
      <TableHeader>
        <TableRow>
          <SortHeader label="Provider" sortKey="id" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="开关" sortKey="on" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="进程" sortKey="up" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="认证" sortKey="auth" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="客户端" sortKey="client" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="漂移" sortKey="drift" activeKey={sortKey} dir={sortDir} onSort={onSort} />
          <SortHeader label="端口" sortKey="port" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
          <SortHeader label="模型数" sortKey="models" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
          <TableHead>额度</TableHead>
          <TableHead>跳转</TableHead>
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
              <TableCell>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(p.id);
                  }}
                  className="flex items-center gap-2 rounded-[4px] px-1 py-0.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  aria-expanded={selected}
                >
                  <ProviderChip id={p.id} title={p.title} />
                  {p.overlay ? <Badge variant="info">叠加</Badge> : null}
                  <span className="sr-only">查看详情</span>
                </button>
              </TableCell>
              <TableCell>
                <OnCell p={p} />
              </TableCell>
              <TableCell>
                <StatusDot up={p.up} />
              </TableCell>
              <TableCell>
                <AuthBadge auth={p.auth} />
              </TableCell>
              <TableCell>
                <ClientCell p={p} />
              </TableCell>
              <TableCell className="max-w-[13rem]">
                <DriftBadges drift={p.drift} />
                {p.drift.length ? (
                  <div className="mt-0.5 text-[10px] text-text-tertiary">{driftDetailText(p)}</div>
                ) : null}
              </TableCell>
              <TableCell className="text-right font-mono text-[11px] tabular-nums">
                {p.port > 0 ? p.port : DASH}
              </TableCell>
              <TableCell className="text-right font-mono text-[11px] tabular-nums">
                {p.models === null ? DASH : fmtInt(p.models)}
              </TableCell>
              <TableCell>{p.overlay ? <span className="text-text-tertiary">{DASH}</span> : <QuotaCell row={quotaIndex.get(p.id)} />}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2 text-[11px]">
                  {DESTINATIONS.map((d) => (
                    <Link
                      key={d.to}
                      to={d.to}
                      search={{ provider: p.id }}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded text-accent-rest underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      aria-label={`在${d.label}页查看 ${p.title}`}
                    >
                      {d.label}
                    </Link>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
