import { type ReactNode } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import { Check, Laptop, Moon, RefreshCw, Search, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useEnv, useInvalidateAll } from '@/lib/query';
import { useTheme, type Theme } from '@/lib/theme';
import { TaskCenter } from './task-center';

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const items: Array<{ value: Theme; label: string; icon: ReactNode }> = [
    { value: 'light', label: '浅色', icon: <Sun className="size-4" /> },
    { value: 'dark', label: '深色', icon: <Moon className="size-4" /> },
    { value: 'system', label: '跟随系统', icon: <Laptop className="size-4" /> },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="切换主题">
          {theme === 'light' ? <Sun className="size-4" /> : theme === 'dark' ? <Moon className="size-4" /> : <Laptop className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((it) => (
          <DropdownMenuItem key={it.value} onSelect={() => setTheme(it.value)}>
            {it.icon}
            {it.label}
            {theme === it.value ? <Check className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ leading }: { leading?: ReactNode }) {
  const env = useEnv();
  const invalidate = useInvalidateAll();
  const fetching = useIsFetching();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
      {leading}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>范围：{env.data?.mode === 'demo' ? '演示' : '本机'}</span>
        <span aria-hidden>·</span>
        <span
          className={env.data?.gateway.reachable === true ? 'text-success' : env.data?.gateway.reachable === false ? undefined : 'text-muted-foreground'}
        >
          网关 {env.data?.gateway.reachable === true ? '可达' : env.data?.gateway.reachable === false ? '不可达' : '未知'}
        </span>
        {env.data?.nodeVersion ? (
          <>
            <span aria-hidden>·</span>
            <span>node {env.data.nodeVersion}</span>
          </>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="打开命令面板"
          title="命令面板 (Ctrl/⌘ + K)"
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
