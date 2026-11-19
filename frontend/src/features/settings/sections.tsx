import { useEffect, useState, type ReactNode } from 'react';
import {
  CircleCheck,
  CircleAlert,
  CircleHelp,
  FlaskConical,
  Gauge,
  Laptop,
  Moon,
  Palette,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Terminal,
  TriangleAlert,
  Plug,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorState, LoadingState, StaleNotice } from '@/components/shared/states';
import { ProviderChip } from '@/components/shared/status';
import { DASH } from '@/lib/format';
import { providerColorVar } from '@/lib/provider';
import type { PanelEnv } from '@/lib/schemas';
import type { ProviderStatus } from '@/lib/contract';
import type { Res } from '@/lib/query';
import { useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import {
  RANGE_LABEL,
  USAGE_RANGES,
  useDefaultProvider,
  useDefaultRange,
  type PrefRange,
} from './preferences';

function SectionCard({
  title,
  description,
  icon,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer ? <CardFooter className="border-t pt-3">{footer}</CardFooter> : null}
    </Card>
  );
}

function DefRow({
  label,
  children,
  mono,
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 text-right break-all', mono && 'font-mono text-xs')}>{children}</dd>
    </div>
  );
}

function Value({ v }: { v: string | number | null | undefined }) {
  if (v === null || v === undefined || v === '') return <span className="text-muted-foreground">{DASH}</span>;
  return <>{v}</>;
}

/** 系统是否要求减少动效（对齐 FR-187）；仅读取，不改变系统设置。 */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduce(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return reduce;
}

/* ---------------------------------------------------------------- 外观 */

const THEME_OPTIONS: Array<{ value: Theme; label: string; hint: string; icon: typeof Moon }> = [
  { value: 'dark', label: '深色', hint: '始终使用深色', icon: Moon },
  { value: 'light', label: '浅色', hint: '始终使用浅色', icon: Sun },
  { value: 'system', label: '跟随系统', hint: '随操作系统主题切换', icon: Laptop },
];

export function AppearanceCard() {
  const { theme, resolved, setTheme } = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const resolvedLabel = resolved === 'dark' ? '深色' : '浅色';
  const themeLabel = THEME_OPTIONS.find((o) => o.value === theme)?.label ?? theme;

  return (
    <SectionCard
      title="外观"
      icon={<Palette className="size-4" />}
      description="主题仅保存在本机浏览器，不写入后端。"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">主题</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {THEME_OPTIONS.map(({ value, label, hint, icon: Icon }) => {
            const id = `panel-theme-${value}`;
            const active = theme === value;
            return (
              <label
                key={value}
                htmlFor={id}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm outline-none transition-colors focus-within:ring-2 focus-within:ring-ring/50',
                  active
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-border hover:bg-accent/50',
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name="panel-theme"
                  value={value}
                  checked={active}
                  onChange={() => setTheme(value)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Icon className="size-4" aria-hidden />
                    {label}
                  </span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <Separator className="my-3" />

      <dl className="text-sm">
        <DefRow label="当前主题">
          {themeLabel}
          {theme === 'system' ? <span className="text-muted-foreground">（跟随系统）</span> : null}
        </DefRow>
        <DefRow label="当前生效">
          <span className="inline-flex items-center gap-1.5">
            {resolved === 'dark' ? <Moon className="size-3.5" aria-hidden /> : <Sun className="size-3.5" aria-hidden />}
            {resolvedLabel}
          </span>
        </DefRow>
        <DefRow label="存储位置">
          <code className="font-mono text-xs">localStorage: router-panel-theme</code>
        </DefRow>
        <DefRow label="减少动效">
          <span className="inline-flex items-center gap-1.5">
            {reducedMotion ? (
              <CircleCheck className="size-3.5 text-success" aria-hidden />
            ) : (
              <CircleAlert className="size-3.5 text-muted-foreground" aria-hidden />
            )}
            {reducedMotion ? '系统已要求减少动效' : '系统未要求减少动效'}
          </span>
        </DefRow>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        已尊重系统的 <code className="font-mono">prefers-color-scheme</code>（选择“跟随系统”时）
        与 <code className="font-mono">prefers-reduced-motion</code>（开启后页面动效降至最低）。
      </p>
    </SectionCard>
  );
}

/* ------------------------------------------------------ 本机浏览器偏好 */

export function LocalPreferencesCard({ providers }: { providers: Array<{ id: string; title: string }> }) {
  const { range, setRange, resetRange } = useDefaultRange();
  const { provider, setProvider, resetProvider } = useDefaultProvider();
  const [cleared, setCleared] = useState(false);

  return (
    <SectionCard
      title="本机浏览器偏好"
      icon={<SlidersHorizontal className="size-4" />}
      description="仅本机浏览器偏好（localStorage），不影响后端，也不改变桥接启动参数。"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetRange();
              resetProvider();
              setCleared(true);
            }}
          >
            清除本机偏好
          </Button>
          {cleared ? <span className="text-xs text-muted-foreground">已恢复默认</span> : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pref-default-range">默认时间范围</Label>
          <Select value={range} onValueChange={(v) => setRange(v as PrefRange)}>
            <SelectTrigger id="pref-default-range" aria-label="默认时间范围" className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USAGE_RANGES.map((r) => (
                <SelectItem key={r} value={r}>
                  {RANGE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            用量类页面（对齐 URL 参数 <code className="font-mono">range</code>）的初始值。当前为纯本地偏好，
            未改变任何数据请求。
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pref-default-provider">默认选中的 provider</Label>
          <Select
            value={provider ?? '__none__'}
            onValueChange={(v) => setProvider(v === '__none__' ? null : v)}
          >
            <SelectTrigger id="pref-default-provider" aria-label="默认选中的 provider" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">不默认选中</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2 rounded-sm"
                      style={{ backgroundColor: providerColorVar(p.id) }}
                    />
                    {p.title}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            服务 / 额度 / 账号 / 日志 / 诊断页的初始 <code className="font-mono">provider</code> 筛选。
            仅本机生效，不写后端。
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------- 连接信息（只读） */

export function ConnectionCard({ env }: { env: Res<PanelEnv> }) {
  const data = env.data;
  /** 三态：true / false / null（未知，未查询）。未知不得渲染成「不可达」。 */
  const gatewayReachable = data ? data.gateway.reachable : null;
  const bridgeError = env.error && !data;

  return (
    <SectionCard
      title="桥接与运行环境"
      icon={<Plug className="size-4" />}
      description="只读信息：来自 GET /api/env，页面不提供修改入口。"
      footer={
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Button variant="outline" size="sm" onClick={env.refetch}>
            <RefreshCw className="size-4" />
            重新读取环境
          </Button>
          <span>环境信息在会话内缓存；重启桥接或切换模式后需重新读取。</span>
        </div>
      }
    >
      {bridgeError ? (
        <div className="mb-3">
          <ErrorState error={env.error} onRetry={env.refetch} />
        </div>
      ) : null}
      {data && env.stale ? (
        <div className="mb-3">
          <StaleNotice lastSuccessAt={env.lastSuccessAt} />
        </div>
      ) : null}

      <dl className="text-sm">
        <DefRow label="工作范围">
          {data ? (
            data.mode === 'demo' ? (
              <span className="inline-flex items-center gap-1.5">
                <Badge variant="info">DEMO</Badge> 演示（匿名虚构数据）
              </span>
            ) : (
              <Badge variant="success">本机</Badge>
            )
          ) : (
            <Value v={null} />
          )}
        </DefRow>
        <DefRow label="只读模式">
          {data ? (
            data.readOnly ? (
              <Badge variant="warning">只读（写操作已在桥接层拦截）</Badge>
            ) : (
              <Badge variant="muted">可写</Badge>
            )
          ) : (
            <Value v={null} />
          )}
        </DefRow>
        <Separator className="my-1" />
        <DefRow label="桥接地址" mono>
          <Value v={data?.gateway.url} />
        </DefRow>
        <DefRow label="网关可达">
          {data ? (
            gatewayReachable === null ? (
              <span className="inline-flex items-center gap-1.5">
                <CircleHelp className="size-3.5 text-muted-foreground" aria-hidden />
                未知（未查询）
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                {gatewayReachable ? (
                  <CircleCheck className="size-3.5 text-success" aria-hidden />
                ) : (
                  <CircleAlert className="size-3.5 text-destructive" aria-hidden />
                )}
                {gatewayReachable ? '可达' : '不可达'}
              </span>
            )
          ) : (
            <Value v={null} />
          )}
        </DefRow>
        <DefRow label="router root" mono>
          <Value v={data?.root} />
        </DefRow>
        <DefRow label="Node 版本">
          <span className="font-mono text-xs">{data?.nodeVersion ? data.nodeVersion : DASH}</span>
        </DefRow>
        <DefRow label="平台">
          <span className="font-mono text-xs">
            <Value v={data?.platform} />
          </span>
        </DefRow>
        <DefRow label="面板版本">
          <span className="font-mono text-xs">
            <Value v={data?.panelVersion} />
          </span>
        </DefRow>
        <DefRow label="环境读取时间">
          <span className="text-xs text-muted-foreground">
            <Value v={env.lastSuccessAt ? new Date(env.lastSuccessAt).toLocaleString('zh-CN', { hour12: false }) : null} />
          </span>
        </DefRow>
      </dl>

      {data && gatewayReachable === false ? (
        <div
          role="status"
          className="mt-3 flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
        >
          <div className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-3.5" aria-hidden />
            统一网关不可达（未运行不等于失败）
          </div>
          <div className="text-muted-foreground">先启动网关，再复核状态：</div>
          <ol className="ml-4 list-decimal space-y-0.5 font-mono text-[11px] text-foreground">
            <li>node router.mjs gateway up</li>
            <li>node router.mjs gateway status</li>
          </ol>
          <div className="text-muted-foreground">
            若桥接本身不可达，请确认面板与桥接端口一致，并检查 8792 / 5173 是否被占用。
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

/* ------------------------------------------------------- 刷新策略（只读） */

const REFRESH_ROWS: Array<{ resource: string; policy: string; note: string }> = [
  { resource: 'Provider 状态', policy: '5 秒', note: '页面可见时轮询；同 key 请求去重' },
  { resource: '账号', policy: '不轮询', note: '进入页面 + 写操作完成后查询' },
  { resource: '额度', policy: '120 秒', note: '允许后端缓存，展示 fetchedAt' },
  { resource: 'OpenCode 用量', policy: '120 秒', note: '只读统计，不从日志反推' },
  { resource: '网关调度', policy: '5 秒', note: 'status 快照' },
  { resource: '网关用量', policy: '60 秒', note: 'usage 聚合' },
  { resource: '日志', policy: 'SSE 跟随', note: '页面可见且开启时；否则停止' },
  { resource: '健康检查', policy: '按需', note: '进入诊断页或显式执行；不后台试打' },
  { resource: '真实试打', policy: '从不自动', note: '仅诊断页显式触发' },
];

export function RefreshPolicyCard({ onRefresh }: { onRefresh: () => void }) {
  return (
    <SectionCard
      title="刷新策略"
      icon={<Gauge className="size-4" />}
      description="对齐设计基线 §8 的默认值；窗口不可见（document.hidden）时暂停轮询与 SSE，恢复可见立即补一次。"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onRefresh}>
            <RefreshCw className="size-4" />
            立即刷新全部数据
          </Button>
          <span className="text-xs text-muted-foreground">
            失效并重取 provider / 账号 / 额度 / 网关状态与余额。
          </span>
        </div>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>资源</TableHead>
            <TableHead className="w-24">间隔</TableHead>
            <TableHead>说明</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {REFRESH_ROWS.map((row) => (
            <TableRow key={row.resource}>
              <TableCell className="font-medium">{row.resource}</TableCell>
              <TableCell className="tabular-nums whitespace-nowrap">{row.policy}</TableCell>
              <TableCell className="text-muted-foreground">{row.note}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-3 text-xs text-muted-foreground">
        以上为当前构建的固定值；本页只读展示，暂不支持在页面上覆盖刷新间隔（不假装可切换）。
      </p>
    </SectionCard>
  );
}

/* --------------------------------------------------------- 运行模式说明 */

const MODE_ROWS: Array<{
  key: string;
  mode: string;
  command: string;
  url: string;
  spawn: string;
  realFiles: string;
  write: string;
  current: boolean;
}> = [
  { key: 'dev', mode: '开发', command: 'npm run dev', url: '127.0.0.1:5173', spawn: '是', realFiles: '是', write: '是', current: false },
  { key: 'prod', mode: '生产', command: 'npm run build + npm run start', url: '127.0.0.1:8792', spawn: '是', realFiles: '是', write: '是', current: false },
  { key: 'demo', mode: '演示', command: 'npm run start -- --demo', url: '127.0.0.1:8792', spawn: '否', realFiles: '否', write: '模拟', current: false },
  { key: 'readonly', mode: '只读', command: 'npm run start -- --read-only', url: '127.0.0.1:8792', spawn: '是', realFiles: '是', write: '拦截', current: false },
];

export function RuntimeModesCard({ env }: { env: PanelEnv | null }) {
  const rows = MODE_ROWS.map((row) => ({
    ...row,
    current: (row.key === 'demo' && env?.mode === 'demo') || (row.key === 'readonly' && env?.readOnly === true),
  }));

  return (
    <SectionCard
      title="运行模式"
      icon={<Terminal className="size-4" />}
      description="模式由桥接的启动参数决定，页面不提供切换入口。"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>模式</TableHead>
            <TableHead>启动命令</TableHead>
            <TableHead>访问地址</TableHead>
            <TableHead className="text-center">spawn CLI</TableHead>
            <TableHead className="text-center">读真实文件</TableHead>
            <TableHead className="text-center">允许写</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="font-medium whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5">
                  {row.mode}
                  {row.current ? <Badge variant="info">当前</Badge> : null}
                </span>
              </TableCell>
              <TableCell className="font-mono text-xs">{row.command}</TableCell>
              <TableCell className="font-mono text-xs">{row.url}</TableCell>
              <TableCell className="text-center">{row.spawn}</TableCell>
              <TableCell className="text-center">{row.realFiles}</TableCell>
              <TableCell className="text-center">{row.write}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground">
        <div className="flex items-start gap-1.5">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span>
            <span className="text-foreground">只读</span>：写操作在<strong className="font-medium">桥接层</strong>被拦截
            （POST /api/actions 与网关写端点直接返回错误），不靠前端隐藏按钮；同机 CLI 不受影响。
          </span>
        </div>
        <div className="flex items-start gap-1.5">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
          <span>
            <span className="text-foreground">演示</span>：不 spawn 任何进程、不访问真实文件，全部为匿名虚构数据，
            常驻 <Badge variant="info">DEMO</Badge> 标记；写操作只改内存中的模拟状态。
          </span>
        </div>
        <div className="flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            开发与生产模式会真实 spawn CLI 并读写真实文件，请在确认目标后使用。
            切换模式需要<strong className="font-medium">重启桥接</strong>（那是启动参数，不是页面开关）。
          </span>
        </div>
      </div>
    </SectionCard>
  );
}

/* --------------------------------------------------------- provider 一览 */

function BoolCell({ value }: { value: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', value ? 'text-foreground' : 'text-muted-foreground')}>
      <span
        aria-hidden
        className={cn('size-2 rounded-full', value ? 'bg-success' : 'bg-muted-foreground/40')}
      />
      {value ? '是' : '否'}
    </span>
  );
}

export function ProvidersCard({ providers }: { providers: Res<ProviderStatus[]> }) {
  return (
    <SectionCard
      title="Provider 一览"
      icon={<Plug className="size-4" />}
      description="来自 GET /api/providers 的只读快照（网关为叠加层：on 等于 up，无独立开关）。"
    >
      {providers.data === null ? (
        providers.error ? (
          <ErrorState error={providers.error} onRetry={providers.refetch} />
        ) : (
          <LoadingState label="正在读取 provider 状态…" />
        )
      ) : providers.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有可展示的 provider。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">端口</TableHead>
              <TableHead className="text-center">开关</TableHead>
              <TableHead className="text-center">进程</TableHead>
              <TableHead className="text-center">叠加层</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.data.map((p: ProviderStatus) => (
              <TableRow key={p.id}>
                <TableCell>
                  <ProviderChip id={p.id} title={p.title} />
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {Number.isFinite(p.port) && p.port > 0 ? p.port : DASH}
                </TableCell>
                <TableCell className="text-center">
                  <BoolCell value={p.on} />
                </TableCell>
                <TableCell className="text-center">
                  <BoolCell value={p.up} />
                </TableCell>
                <TableCell className="text-center">
                  {p.overlay ? <Badge variant="muted">叠加层</Badge> : <span className="text-muted-foreground">{DASH}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        本页只列出身份信息；启停、开关、同步等写操作在“服务”页进行。
      </p>
    </SectionCard>
  );
}
