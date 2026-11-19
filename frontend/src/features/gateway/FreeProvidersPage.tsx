import { Cloud } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { DataState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useGatewayFree } from '@/lib/query';
import type { FreeProvider } from '@/lib/schemas';
import { DASH } from '@/lib/format';
import { CliCommand, GatewayUnreachable, InfoNote, isUnreachable } from './gateway-shared';

function statusBadge(p: FreeProvider): ReactNode {
  if (p.status === 'ok') return <Badge variant="success">可用</Badge>;
  if (p.status === 'needs-key') return <Badge variant="warning">待配置</Badge>;
  if (p.status === 'down') return <Badge variant="destructive">不可用</Badge>;
  return <Badge variant="muted">未知</Badge>;
}

function isPending(p: FreeProvider): boolean {
  return p.status === 'needs-key' || (!p.hasKey && !p.local);
}

function FreeTable({ providers }: { providers: FreeProvider[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>标题</TableHead>
            <TableHead>类别</TableHead>
            <TableHead>本机</TableHead>
            <TableHead>有 key</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>Base URL</TableHead>
            <TableHead>说明</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-mono text-xs">{p.id}</TableCell>
              <TableCell className="font-medium">{p.title || p.id}</TableCell>
              <TableCell className="text-muted-foreground">{p.local ? '本机' : p.category || DASH}</TableCell>
              <TableCell>{p.local ? <Badge variant="info">本机</Badge> : '否'}</TableCell>
              <TableCell>{p.hasKey ? '是' : <span className="text-muted-foreground">否</span>}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  {statusBadge(p)}
                  {isPending(p) ? <span className="text-xs text-muted-foreground">待配置</span> : null}
                </div>
              </TableCell>
              <TableCell className="max-w-56 truncate font-mono text-xs" title={p.baseUrl}>
                {p.baseUrl || DASH}
              </TableCell>
              <TableCell className="max-w-64 text-xs text-muted-foreground">{p.note || DASH}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** 免费供应商只读清单：3 家本机免账号 + 15 家有免费额度需 key。 */
export function FreeProvidersPage() {
  const res = useGatewayFree();

  if (isUnreachable(res.error)) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="免费供应商" description="由网关直接当上游，不参与 on/off。" />
        <GatewayUnreachable message={res.error?.message} onRetry={res.refetch} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="免费供应商"
        description="网关可直接当上游的免费供应商清单：本机免账号 3 家 + 有免费额度需 key 15 家。只读，不参与 on/off。"
      />

      <InfoNote>
        这些供应商由网关直接调用，<strong>不是</strong>本机反代（没有 PID/日志，也不在 provider 开关里）。
        上游 key 存于加密的 <CliCommand>gateway/data/providers.json</CliCommand>，面板只显示「有没有 key」，
        <strong>不显示 key 值</strong>。配置 key：<CliCommand>node router.mjs providers key &lt;id&gt; &lt;key&gt;</CliCommand>
      </InfoNote>

      <DataState
        res={res}
        loadingLabel="正在读取免费供应商清单…"
        onRetry={res.refetch}
        isEmpty={(d) => d.length === 0}
        empty={
          <Empty
            icon={<Cloud />}
            title="没有免费供应商清单"
            description={
              <>
                读不到清单时用 CLI 查看：
                <br />
                <CliCommand className="mt-1 inline-block">node router.mjs providers list</CliCommand>
              </>
            }
          />
        }
      >
        {(data) => {
          const locals = data.filter((p) => p.local);
          const clouds = data.filter((p) => !p.local);
          const pending = data.filter(isPending).length;
          return (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>共 {data.length} 家</span>
                <span aria-hidden>·</span>
                <span>本机 {locals.length} 家</span>
                <span aria-hidden>·</span>
                <span>需 key {clouds.length} 家</span>
                <span aria-hidden>·</span>
                <span className={pending > 0 ? 'text-warning' : undefined}>待配置 {pending} 家</span>
              </div>

              <section className="flex flex-col gap-2">
                <h2 className="text-xs font-medium text-muted-foreground">本机免账号（不需要 key）</h2>
                {locals.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    没有本机供应商
                  </div>
                ) : (
                  <FreeTable providers={locals} />
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-xs font-medium text-muted-foreground">有免费额度（需要 key）</h2>
                {clouds.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    没有需要 key 的供应商
                  </div>
                ) : (
                  <FreeTable providers={clouds} />
                )}
              </section>
            </div>
          );
        }}
      </DataState>
    </div>
  );
}
