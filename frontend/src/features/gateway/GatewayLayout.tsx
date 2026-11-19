import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/cn';

const TABS = [
  { label: '调度', to: '/gateway' },
  { label: '网关用量', to: '/gateway/usage' },
  { label: '降级链', to: '/gateway/combos' },
  { label: '密钥', to: '/gateway/keys' },
  { label: '免费供应商', to: '/gateway/free' },
  { label: '本地应答', to: '/gateway/local-answers' },
] as const;

export function GatewayLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="flex flex-col gap-4">
      {/* 这里刻意不用 h1：每个子页自己提供页面级 h1，避免一页出现两个一级标题。 */}
      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">统一网关</div>
        <p className="text-xs text-muted-foreground">
          叠加层：不参与 on/off；一个端口、双协议、跨供应商故障转移。
        </p>
      </div>
      <nav aria-label="网关子页" className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            aria-current={pathname === t.to ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              pathname === t.to ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}