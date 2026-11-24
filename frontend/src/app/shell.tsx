import { useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Menu, Router as RouterIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { LiveBadge } from '@/components/shared/live-badge';
import { useEnv } from '@/lib/query';
import { cn } from '@/lib/cn';
import { NAV_SECTIONS, navItems } from './nav';
import { Topbar } from './topbar';
import { CommandPalette } from './command-palette';

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2 py-2',
        compact && 'h-12 py-0',
      )}
    >
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-rest text-primary-foreground shadow-2"
      >
        <RouterIcon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-display text-ramp-14 font-semibold text-text-primary">
          Router 控制台
        </span>
        <span className="truncate text-[11px] text-text-tertiary">本机回环桥接</span>
      </div>
    </div>
  );
}

/** 导航项：左侧 3px accent 指示条 + layer 选中背景（Fluent NavigationView）。 */
function NavLink({
  to,
  label,
  icon: Icon,
  active,
  child = false,
  onNavigate,
}: {
  to: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  active: boolean;
  child?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      activeOptions={{ exact: to === '/' }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex items-center gap-2.5 rounded-md outline-none transition-[background-color,color] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        child ? 'ml-[26px] px-2.5 py-1.5 text-[12px]' : 'px-2.5 py-2 text-ramp-14',
        active
          ? 'bg-accent-selected font-medium text-text-primary'
          : 'text-text-secondary hover:bg-accent-subtle hover:text-text-primary',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent-rest transition-opacity duration-150',
          active ? 'opacity-100' : 'opacity-0',
          child && 'h-3',
        )}
      />
      {Icon ? (
        <Icon
          className={cn(
            'size-4 shrink-0',
            active ? 'text-accent-rest' : 'text-text-tertiary group-hover:text-text-secondary',
          )}
        />
      ) : null}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2">
      {NAV_SECTIONS.map((section) => {
        const items = navItems.filter((i) => (i.section ?? 'system') === section.id);
        if (!items.length) return null;
        return (
          <div key={section.id} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
              {section.label}
            </div>
            {items.map((item) => {
              const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
              return (
                <div key={item.id} className="flex flex-col gap-0.5">
                  <NavLink
                    to={item.to}
                    label={item.label}
                    icon={item.icon}
                    active={active}
                    onNavigate={onNavigate}
                  />
                  {item.children && active ? (
                    <div className="flex flex-col gap-0.5 border-l border-stroke-1 pb-1 pl-0">
                      {item.children.map((child) => {
                        const childActive = pathname === child.to;
                        return (
                          <NavLink
                            key={child.to}
                            to={child.to}
                            label={child.label}
                            active={childActive}
                            child
                            onNavigate={onNavigate}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function SidebarFooter() {
  const env = useEnv();
  const mode = env.data?.mode ?? 'real';
  return (
    <div className="flex flex-col gap-1.5 border-t border-stroke-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {env.data?.readOnly ? (
          <LiveBadge kind="readonly" tone="warning" label="只读" hint="桥接以只读模式运行，页面不提供写操作" />
        ) : null}
        {mode === 'demo' ? (
          <LiveBadge kind="demo" tone="info" label="演示数据" hint="桥接处于 demo 模式，数据为固定夹具" />
        ) : null}
      </div>
      <span className="truncate text-[10px] text-text-tertiary" title={env.data?.root ?? undefined}>
        {env.data?.root ? `root: ${env.data.root}` : '本机回环桥接'}
      </span>
    </div>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="mica flex h-full text-foreground">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-accent-rest px-3 py-1.5 text-primary-foreground shadow-8 focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
      >
        跳到主内容
      </a>

      {/* 240px 固定侧边导航（>=900px 显示；窄屏折叠为 Sheet） */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-stroke-1 bg-surface-1/60 [@media(min-width:900px)]:flex">
        <div className="px-2 pt-3">
          <Brand />
        </div>
        <SidebarNav />
        <SidebarFooter />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 gap-2 p-0">
          <div className="px-2 pt-3">
            <Brand />
          </div>
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
          <SidebarFooter />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          leading={
            <Button
              variant="ghost"
              size="icon-sm"
              className="[@media(min-width:900px)]:hidden"
              aria-label="打开导航"
              aria-haspopup="dialog"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-4" />
            </Button>
          }
        />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {/* 内容区：居中、最大 1600px、响应式 padding；页面上浮为 layer-1 */}
          <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-5 lg:px-8 lg:py-6">
            <div className="page-enter">
              <Outlet />
            </div>
          </div>
        </main>
        <footer className="flex shrink-0 items-center gap-2 border-t border-stroke-1 px-4 py-1.5 text-[11px] text-text-tertiary [@media(max-width:899px)]:hidden">
          <span>只读面板 · 写操作请在对应功能页触发</span>
          <span aria-hidden className="ml-auto">
            Fluent 2
          </span>
        </footer>
      </div>

      <CommandPalette />
    </div>
  );
}
