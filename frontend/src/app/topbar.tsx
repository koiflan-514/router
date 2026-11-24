import { type ReactNode } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { Check, ChevronRight, Contrast, Laptop, Moon, RefreshCw, Search, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LiveBadge } from '@/components/shared/live-badge';
import { useEnv, useInvalidateAll } from '@/lib/query';
import { useTheme, type Theme } from '@/lib/theme';
import { navItems } from './nav';
import { TaskCenter } from './task-center';

function ThemeToggle() {
  const { theme, setTheme, contrast, setContrast } = useTheme();
  const items: Array<{ value: Theme; label: string; icon: ReactNode }> = [
    { value: 'light', label: '浅色', icon: <Sun className="size-4" /> },
    { value: 'dark', label: '深色', icon: <Moon className="size-4" /> },
    { value: 'system', label: '跟随系统', icon: <Laptop className="size-4" /> },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="切换主题">
          {theme === 'light' ? (
            <Sun className="size-4" />
          ) : theme === 'dark' ? (
            <Moon className="size-4" />
          ) : (
            <Laptop className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>外观</DropdownMenuLabel>
        {items.map((it) => (
          <DropdownMenuItem key={it.value} onSelect={() => setTheme(it.value)}>
            {it.icon}
            {it.label}
            {theme === it.value ? <Check aria-hidden className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>对比度</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setContrast(contrast === 'high' ? 'normal' : 'high')}>
          <Contrast className="size-4" />
          高对比
          {contrast === 'high' ? <Check aria-hidden className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 面包屑：section › 页面 › 网关子页。用纯文本，标题本身由页面 h1 承担。 */
function Breadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const item = navItems.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)));
  const child = item?.children?.find((c) => c.to === pathname);
  const crumbs = [item?.label ?? null, child?.label ?? null].filter(Boolean) as string[];
  return (
    <nav aria-label="面包屑与页面位置" className="flex min-w-0 items-center gap-1 text-[12px]">
      <span className="hidden shrink-0 text-text-tertiary sm:inline">Router</span>
      {crumbs.map((c, i) => (
        <span key={`${c}-${i}`} className="flex min-w-0 items-center gap-1">
          <ChevronRight aria-hidden className="size-3 shrink-0 text-text-tertiary" />
          <span
            aria-current={i === crumbs.length - 1 ? 'page' : undefined}
            className={
              i === crumbs.length - 1
                ? 'truncate font-medium text-text-primary'
                : 'truncate text-text-secondary'
            }
          >
            {c}
          </span>
        </span>
      ))}
    </nav>
  );
}

/** 实时状态胶囊：网关可达 / 只读 / 演示。只读语义，不提供动作。 */
function StatusPills() {
  const env = useEnv();
  const gateway = env.data?.gateway.reachable;
  const mode = env.data?.mode ?? 'real';
  const pills: ReactNode[] = [];
  if (gateway === true) {
    pills.push(
      <LiveBadge
        key="gw"
        kind="gateway"
        tone="live"
        pulse
        label="网关可达"
        hint={env.data?.gateway.url || '统一网关健康检查通过'}
      />,
    );
  } else if (gateway === false) {
    pills.push(
      <LiveBadge
        key="gw"
        kind="gateway"
        tone="danger"
        label="网关不可达"
        hint={env.data?.gateway.url || '统一网关不可达'}
      />,
    );
  } else {
    pills.push(
      <LiveBadge
        key="gw"
        kind="gateway"
        tone="idle"
        label="网关未知"
        hint="桥接未能判定网关可达性（未知 ≠ 不可达）"
      />,
    );
  }
  if (env.data?.readOnly) {
    pills.push(<LiveBadge key="ro" kind="readonly" tone="warning" label="只读" hint="只读模式：页面不提供写操作" />);
  }
  if (mode === 'demo') {
    pills.push(<LiveBadge key="demo" kind="demo" tone="info" label="演示" hint="demo 模式：数据来自固定夹具" />);
  }
  return <div className="flex items-center gap-1.5">{pills}</div>;
}

export function Topbar({ leading }: { leading?: ReactNode }) {
  const invalidate = useInvalidateAll();
  const fetching = useIsFetching();

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-stroke-1 bg-[color-mix(in_oklab,var(--mica-base)_78%,transparent)] px-2.5 backdrop-blur-[20px] sm:px-3">
      {leading}
      <Breadcrumb />
      <div className="ml-auto flex items-center gap-1.5">
        <div className="hidden md:block">
          <StatusPills />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="打开命令面板"
          title="搜索页面与操作 (Ctrl/⌘ + K)"
          onClick={() => window.dispatchEvent(new CustomEvent('panel:command'))}
        >
          <Search className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={fetching > 0 ? '正在刷新数据' : '刷新全部数据'}
          aria-busy={fetching > 0}
          onClick={invalidate}
        >
          <RefreshCw className={fetching > 0 ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
        <ThemeToggle />
        <TaskCenter />
      </div>
    </header>
  );
}
