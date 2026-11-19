import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { AuthBadge, DriftBadges, ProviderChip, StatusDot } from '@/components/shared/status';
import { ProviderSelect } from '@/components/shared/provider-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
          'inline-flex items-center gap-1 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
        title={`按${label}排序`}
      >
        {label}
        <Icon className="size-3.5" aria-hidden />
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
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
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
      <span className="text-xs text-muted-foreground">共 {fmtInt(providers.length)} 条</span>
    </div>
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

/** 总览 Provider 表：四态独立徽标 + models(null≠0) + 可选额度摘要 + 跨页跳转。 */
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
    <Table>
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
          <TableHead>额度摘要</TableHead>
          <TableHead>跳转</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.map((p) => {
          const selected = selectedId === p.id;
          const quota = p.overlay ? DASH : quotaSummaryText(quotaIndex.get(p.id));
          return (
            <TableRow
              key={p.id}
              data-selected={selected ? 'true' : undefined}
              className={cn('cursor-pointer', selected && 'bg-accent/60')}
              onClick={() => onSelect(p.id)}
            >
              <TableCell>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(p.id);
                  }}
                  className="flex items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label={`查看 ${p.title}（${p.id}）详情`}
                  aria-expanded={selected}
                >
                  <ProviderChip id={p.id} title={p.title} />
                  {p.overlay ? <Badge variant="info">叠加</Badge> : null}
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
              <TableCell className="max-w-[15rem]">
                <DriftBadges drift={p.drift} />
                {p.drift.length ? (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{driftDetailText(p)}</div>
                ) : null}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{p.port > 0 ? p.port : DASH}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{p.models === null ? DASH : fmtInt(p.models)}</TableCell>
              <TableCell className="max-w-[12rem] text-xs text-muted-foreground">{quota}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2 text-xs">
                  {DESTINATIONS.map((d) => (
                    <Link
                      key={d.to}
                      to={d.to}
                      search={{ provider: p.id }}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
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
