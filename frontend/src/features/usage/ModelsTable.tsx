import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DASH, fmtInt, fmtNumber } from '@/lib/format';
import { providerColorVar, providerTitle } from '@/lib/provider';
import { toModelDetail, type ModelRow, type UsageSort, type UsageSortKey } from './usage-model';

interface Column {
  key: UsageSortKey;
  label: string;
  numeric: boolean;
  /** 窄屏（< 1024px）收起。 */
  narrowHidden?: boolean;
}

/** 列顺序对齐 14 §6.4。 */
const COLUMNS: Column[] = [
  { key: 'model', label: '模型', numeric: false },
  { key: 'provider', label: 'Provider', numeric: false },
  { key: 'steps', label: 'Steps', numeric: true },
  { key: 'input', label: '输入', numeric: true, narrowHidden: true },
  { key: 'output', label: '输出', numeric: true },
  { key: 'reasoning', label: '推理', numeric: true, narrowHidden: true },
  { key: 'cacheRead', label: '缓存读', numeric: true },
  { key: 'cacheWrite', label: '缓存写', numeric: true, narrowHidden: true },
  { key: 'cost', label: '成本', numeric: true },
];

function ProviderCell({ providerID }: { providerID: string }) {
  if (!providerID) return <span className="text-muted-foreground">{DASH}</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={providerID}>
      <span
        aria-hidden
        className="size-2.5 rounded-sm"
        style={{ backgroundColor: providerColorVar(providerID) }}
      />
      <span>{providerTitle(providerID)}</span>
    </span>
  );
}

function numCell(value: number | null) {
  return <span className="font-mono tabular-nums">{value === null ? DASH : fmtInt(value)}</span>;
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

/** 模型 / Provider 表（默认按 steps 降序）+ 详情抽屉。 */
export function ModelsTable({
  rows,
  sort,
  onSortChange,
  selected,
  onSelect,
}: {
  rows: ModelRow[];
  sort: UsageSort;
  onSortChange: (sort: UsageSort) => void;
  selected: string;
  onSelect: (key: string) => void;
}) {
  const details = rows.map(toModelDetail);
  const selectedRow = selected ? details.find((d) => d.key === selected) : undefined;

  function toggleSort(key: UsageSortKey) {
    if (sort.key === key) {
      onSortChange({ key, dir: sort.dir === 'desc' ? 'asc' : 'desc' });
    } else {
      onSortChange({ key, dir: 'desc' });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型 / Provider</CardTitle>
        <CardDescription>
          默认按 steps 降序；点击表头排序，点击行查看完整 Token 与成本。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((col) => {
                const active = sort.key === col.key;
                return (
                  <TableHead
                    key={col.key}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={[
                      col.numeric ? 'text-right' : '',
                      col.narrowHidden ? 'hidden lg:table-cell' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={[
                        'inline-flex items-center gap-1 rounded text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                        col.numeric ? 'flex-row-reverse' : '',
                        active ? 'text-foreground' : 'text-muted-foreground',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {active ? (
                        sort.dir === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )
                      ) : null}
                      {col.label}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {details.map((row) => (
              <TableRow
                key={row.key}
                aria-selected={row.key === selected}
                onClick={() => onSelect(row.key)}
                className="cursor-pointer aria-selected:bg-accent"
              >
                <TableCell className="font-medium">{row.id}</TableCell>
                <TableCell>
                  <ProviderCell providerID={row.providerID} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{fmtInt(row.steps)}</TableCell>
                <TableCell className="hidden text-right lg:table-cell">{numCell(row.input)}</TableCell>
                <TableCell className="text-right">{numCell(row.output)}</TableCell>
                <TableCell className="hidden text-right lg:table-cell">{numCell(row.reasoning)}</TableCell>
                <TableCell className="text-right">{numCell(row.cacheRead)}</TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {numCell(row.cacheWrite)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {row.cost > 0 ? fmtNumber(row.cost) : DASH}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Sheet
        open={Boolean(selectedRow)}
        onOpenChange={(open) => {
          if (!open) onSelect('');
        }}
      >
        <SheetContent side="right">
          {selectedRow ? (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono">{selectedRow.id}</SheetTitle>
                <SheetDescription>
                  {selectedRow.providerID
                    ? `Provider ${selectedRow.providerID}`
                    : 'Provider 未知（原样显示）'}{' '}
                  · 成本为 OpenCode 上报值，不折算积分
                </SheetDescription>
              </SheetHeader>
              <dl className="flex flex-col">
                <DetailRow label="会话步骤（steps，非请求数）" value={fmtInt(selectedRow.steps)} />
                <DetailRow label="输入 Token" value={numCell(selectedRow.input)} />
                <DetailRow label="输出 Token" value={numCell(selectedRow.output)} />
                <DetailRow label="推理 Token" value={numCell(selectedRow.reasoning)} />
                <DetailRow label="缓存读取 Token" value={numCell(selectedRow.cacheRead)} />
                <DetailRow label="缓存写入 Token" value={numCell(selectedRow.cacheWrite)} />
                <DetailRow
                  label="上报成本"
                  value={
                    selectedRow.cost > 0 ? fmtNumber(selectedRow.cost) : '—（OpenCode 未上报）'
                  }
                />
              </dl>
              <p className="text-[11px] text-muted-foreground">
                steps 是 OpenCode 会话步骤，不等于 HTTP 请求数；缓存读写单独展示，不并入 Token 构成。
              </p>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </Card>
  );
}
