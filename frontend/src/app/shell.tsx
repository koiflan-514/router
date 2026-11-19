import { useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Menu, Router as RouterIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useEnv } from '@/lib/query';
import { cn } from '@/lib/cn';
import { navItems } from './nav';
import { Topbar } from './topbar';
import { CommandPalette } from './command-palette';

function Brand() {
  const env = useEnv();
  const mode = env.data?.mode ?? 'real';
  return (
    <div className="flex h-14 items-center gap-2 border-b border-border px-4">
      <RouterIcon className="size-5 text-primary" />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-semibold">Router 控制台</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {env.data?.root ? `root: ${env.data.root}` : '本机回环桥接'}
        </span>
      </div>
      {mode === 'demo' ? <Badge variant="info" className="ml-auto">DEMO</Badge> : null}
      {env.data?.readOnly ? <Badge variant="warning" className="ml-auto">只读</Badge> : null}
    </div>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="主导航" className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      {navItems.map((item) => {
        const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
        const Icon = item.icon;
        return (
          <div key={item.id}>
            <Link
              to={item.to}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
              activeOptions={{ exact: item.to === '/' }}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
            {item.children && active ? (
              <div className="ml-6 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
                {item.children.map((child) => {
                  const childActive = pathname === child.to;
                  return (
                    <Link
                      key={child.to}
                      to={child.to}
                      onClick={onNavigate}
                      className={cn(
                        'rounded px-2 py-1 text-xs outline-none transition-colors',
                        childActive
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {child.label}
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex h-full bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground"
      >
        跳到主内容
      </a>

      <aside className="hidden w-56 shrink-0 flex-col border-r border-border md:flex">
        <Brand />
        <SidebarNav />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <Brand />
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          leading={
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-4" />
            </Button>
          }
        />
        <main id="main" className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}
