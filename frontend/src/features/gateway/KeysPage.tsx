import { Copy, KeyRound, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingState, StaleNotice } from '@/components/shared/states';
import { TimeText } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiGet } from '@/lib/api';
import { DASH, fmtInt } from '@/lib/format';
import { CliCommand, InfoNote } from './gateway-shared';

/**
 * 网关密钥清单（只读）。
 *
 * 桥接已提供 `GET /api/gateway/keys`：`data` 是**数组**，元素只含公开元数据
 * （id/name/prefix/enabled/disabled/whitelist/quota/usedTokens/时间/note），**没有 hash 或明文**。
 * 为兼容旧形状，同时接受 `{ supported, keys[], text }`。读取失败时优雅降级为终端提示，不白屏。
 */
const keyMetaSchema = z.looseObject({
  id: z.string().default(''),
  name: z.string().default(''),
  prefix: z.string().default(''),
  enabled: z.boolean().optional(),
  disabled: z.boolean().optional(),
  providers: z.array(z.string()).default([]),
  models: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([]),
  quota: z.number().nullable().optional(),
  tokenQuota: z.number().nullable().optional(),
  usedTokens: z.number().default(0),
  createdAt: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  note: z.string().default(''),
});
type KeyMeta = z.infer<typeof keyMetaSchema>;

const keysPayloadSchema = z.union([
  z.array(keyMetaSchema),
  z.looseObject({
    supported: z.boolean().default(true),
    keys: z.array(keyMetaSchema).default([]),
    text: z.string().optional(),
  }),
]);

type KeyState = 'enabled' | 'disabled' | 'unknown';

function keyState(k: KeyMeta): KeyState {
  if (k.disabled === true || k.enabled === false) return 'disabled';
  if (k.enabled === true || k.disabled === false) return 'enabled';
  return 'unknown';
}

function keyQuota(k: KeyMeta): number | null {
  const q = k.tokenQuota ?? k.quota;
  return typeof q === 'number' && Number.isFinite(q) ? q : null;
}

function whitelist(values: string[]): string {
  if (!values.length) return '不限制';
  return values.join('、');
}

/** 复制公开信息（前缀 / 名称）；密钥明文永远不会出现，因此不复制 secret。 */
function CopyButton({ text, label }: { text: string; label: string }) {
  async function onCopy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板');
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`, { description: text });
    } catch (err) {
      toast.error('复制失败', { description: (err as Error).message });
    }
  }
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`复制${label}`}
      title={`复制${label}`}
      onClick={() => void onCopy()}
      disabled={!text}
    >
      <Copy className="size-3.5" />
    </Button>
  );
}

function StateBadge({ state }: { state: KeyState }) {
  if (state === 'disabled') return <Badge variant="muted">已禁用</Badge>;
  if (state === 'enabled') return <Badge variant="success">启用中</Badge>;
  return (
    <span className="text-muted-foreground">
      <span className="sr-only">密钥状态未知</span>
      {DASH}
    </span>
  );
}

function KeysTable({ keys }: { keys: KeyMeta[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>前缀</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>Provider 白名单</TableHead>
            <TableHead>模型白名单</TableHead>
            <TableHead>IP 白名单</TableHead>
            <TableHead>配额 / 用量</TableHead>
            <TableHead>创建 / 到期</TableHead>
            <TableHead>备注</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k, i) => {
            const quota = keyQuota(k);
            const hasQuota = quota !== null && quota > 0;
            const pct = hasQuota ? Math.min(100, (k.usedTokens / (quota as number)) * 100) : null;
            return (
              <TableRow key={k.id || k.prefix || i}>
                <TableCell className="font-medium">{k.name || DASH}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <span className="font-mono text-xs">{k.prefix || DASH}</span>
                    {k.prefix ? <CopyButton text={k.prefix} label="密钥前缀" /> : null}
                  </span>
                </TableCell>
                <TableCell>
                  <StateBadge state={keyState(k)} />
                </TableCell>
                <TableCell className="text-xs">{whitelist(k.providers)}</TableCell>
                <TableCell className="font-mono text-xs">{whitelist(k.models)}</TableCell>
                <TableCell className="font-mono text-xs">{whitelist(k.ips)}</TableCell>
                <TableCell>
                  {hasQuota ? (
                    <div className="flex min-w-40 flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                        <span>{fmtInt(k.usedTokens)}</span>
                        <span className="text-muted-foreground">/ {fmtInt(quota)} tokens</span>
                      </div>
                      <Progress
                        value={pct ?? 0}
                        aria-label={`密钥 ${k.prefix || DASH} 已用 Token 占比`}
                        aria-valuetext={`${Math.round(pct ?? 0)}%`}
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      已用 {fmtInt(k.usedTokens)} tokens · 无上限
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <div className="flex flex-col">
                    <span>
                      创建 <TimeText iso={k.createdAt} />
                    </span>
                    <span>
                      到期 <TimeText iso={k.expiresAt} />
                    </span>
                  </div>
                </TableCell>
                <TableCell className="max-w-56 text-xs text-muted-foreground">{k.note || DASH}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** 读端点不可用时的优雅降级：说明 + 终端命令，不报错白屏。 */
function CliFallback({ reason }: { reason?: string | null }) {
  return (
    <div className="flex flex-col gap-3">
      {reason ? (
        <InfoNote tone="warning">
          读端点暂不可用（{reason}）。下面是可用的终端命令，密钥元数据请以 CLI 输出为准。
        </InfoNote>
      ) : null}
      <Empty
        icon={<KeyRound />}
        title="密钥清单暂不可读"
        description="桥接的 GET /gateway/keys 读取失败或未启用。密钥库只存 SHA-256，面板与 URL 永不含明文。"
      />
      <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
        <div className="font-medium text-foreground">终端命令</div>
        <CliCommand className="block">
          node router.mjs gateway key add --name dev --providers trae-local,zcode --days 30
        </CliCommand>
        <CliCommand className="block">node router.mjs gateway key add --name ci --models 'glm-*' --quota 2000000</CliCommand>
        <CliCommand className="block">node router.mjs gateway key list</CliCommand>
        <CliCommand className="block">node router.mjs gateway key disable &lt;前缀&gt;</CliCommand>
        <CliCommand className="block">node router.mjs gateway key rm &lt;前缀&gt;</CliCommand>
      </div>
    </div>
  );
}

/** 网关密钥（只存哈希）。明文只在创建时显示一次。 */
export function KeysPage() {
  const q = useQuery({
    queryKey: ['gateway', 'keys'],
    queryFn: () => apiGet('/gateway/keys', keysPayloadSchema),
    retry: false,
    staleTime: 30_000,
  });

  const payload = q.data;
  const keys: KeyMeta[] = payload == null ? [] : Array.isArray(payload) ? payload : payload.keys;
  // 数组（含空数组）说明端点已落地；旧包装形状用 supported/keys 判定。
  const supportsList =
    payload != null && (Array.isArray(payload) || payload.supported || payload.keys.length > 0);
  const lastSuccessAt = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null;
  const stale = Boolean(payload) && q.isError;
  const errorMessage = q.error instanceof Error ? q.error.message : null;

  const refresh = (
    <Button size="sm" variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}>
      <RefreshCw className="size-4" />
      刷新
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="密钥"
        description="网关访问密钥（谁可以调用本网关）。密钥库只存 SHA-256，无明文。"
        actions={refresh}
      />

      <InfoNote tone="info">
        明文<strong>只在创建时显示一次</strong>，之后无法读回；面板不缓存、不写日志、不进 URL。
        另：回环地址默认免密钥，且带了无效密钥也不拦——要收紧就设 <CliCommand>strict: true</CliCommand>，
        非回环来源永远需要有效密钥。
      </InfoNote>

      {payload != null ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>共 {keys.length} 个密钥</span>
          <span aria-hidden>·</span>
          <span>启用 {keys.filter((k) => keyState(k) === 'enabled').length}</span>
          <span aria-hidden>·</span>
          <span>禁用 {keys.filter((k) => keyState(k) === 'disabled').length}</span>
          <span aria-hidden>·</span>
          <span>状态未知 {keys.filter((k) => keyState(k) === 'unknown').length}</span>
        </div>
      ) : null}

      {stale ? <StaleNotice lastSuccessAt={lastSuccessAt} /> : null}

      {q.isPending && payload == null ? <LoadingState label="正在读取密钥清单…" /> : null}

      {payload != null ? (
        supportsList ? (
          keys.length === 0 ? (
            <Empty
              icon={<KeyRound />}
              title="密钥库为空"
              description="还没有创建任何网关密钥。用 CLI 创建：node router.mjs gateway key add --name dev"
            />
          ) : (
            <KeysTable keys={keys} />
          )
        ) : (
          <CliFallback reason={null} />
        )
      ) : q.isError ? (
        <CliFallback reason={errorMessage} />
      ) : null}

      <InfoNote>
        表列：名称 / 前缀 / 状态 / provider·模型·IP 白名单 / token 配额与用量 / 创建与到期时间 / 备注。
        白名单为空表示<strong>不限制</strong>；字段缺失显示 {DASH}，不猜 0。
      </InfoNote>
    </div>
  );
}