import { Suspense } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { AppShell } from './shell';
import { Button } from '@/components/ui/button';

/**
 * 路由级懒加载：首屏只加载外壳与当前页，Recharts / 各特性页按需拉取。
 * 这样首屏不必为「用量」「网关」等重页面买单。
 */
const OverviewPage = lazyRouteComponent(() => import('@/features/overview/OverviewPage'), 'OverviewPage');
const ProvidersPage = lazyRouteComponent(() => import('@/features/providers/ProvidersPage'), 'ProvidersPage');
const QuotaPage = lazyRouteComponent(() => import('@/features/quota/QuotaPage'), 'QuotaPage');
const AccountsPage = lazyRouteComponent(() => import('@/features/accounts/AccountsPage'), 'AccountsPage');
const LogsPage = lazyRouteComponent(() => import('@/features/logs/LogsPage'), 'LogsPage');
const DiagnosticsPage = lazyRouteComponent(() => import('@/features/diagnostics/DiagnosticsPage'), 'DiagnosticsPage');
const UsagePage = lazyRouteComponent(() => import('@/features/usage/UsagePage'), 'UsagePage');
const GatewayLayout = lazyRouteComponent(() => import('@/features/gateway/GatewayLayout'), 'GatewayLayout');
const SchedulerPage = lazyRouteComponent(() => import('@/features/gateway/SchedulerPage'), 'SchedulerPage');
const GatewayUsagePage = lazyRouteComponent(
  () => import('@/features/gateway/GatewayUsagePage'),
  'GatewayUsagePage',
);
const CombosPage = lazyRouteComponent(() => import('@/features/gateway/CombosPage'), 'CombosPage');
const KeysPage = lazyRouteComponent(() => import('@/features/gateway/KeysPage'), 'KeysPage');
const FreeProvidersPage = lazyRouteComponent(
  () => import('@/features/gateway/FreeProvidersPage'),
  'FreeProvidersPage',
);
const LocalAnswersPage = lazyRouteComponent(
  () => import('@/features/gateway/LocalAnswersPage'),
  'LocalAnswersPage',
);
const ReportsPage = lazyRouteComponent(() => import('@/features/reports/ReportsPage'), 'ReportsPage');
const SettingsPage = lazyRouteComponent(() => import('@/features/settings/SettingsPage'), 'SettingsPage');

/**
 * 懒加载路由的统一 Suspense 包装：外壳（侧边/顶栏）先渲染，页面 chunk 到达后替换
 * 局部 fallback，不阻塞整页。`lazyRouteComponent` 若已被 TanStack 包好 Suspense，
 * 这层只是幂等的兜底。
 */
type RouteComponent = () => React.ReactElement | null;

function withSuspense(Component: React.ComponentType<any>): RouteComponent {
  return function LazyRoute() {
    return (
      <Suspense fallback={<RoutePending />}>
        <Component />
      </Suspense>
    );
  };
}

const Suspended = {
  OverviewPage: withSuspense(OverviewPage as React.ComponentType),
  ProvidersPage: withSuspense(ProvidersPage as React.ComponentType),
  QuotaPage: withSuspense(QuotaPage as React.ComponentType),
  AccountsPage: withSuspense(AccountsPage as React.ComponentType),
  LogsPage: withSuspense(LogsPage as React.ComponentType),
  DiagnosticsPage: withSuspense(DiagnosticsPage as React.ComponentType),
  UsagePage: withSuspense(UsagePage as React.ComponentType),
  ReportsPage: withSuspense(ReportsPage as React.ComponentType),
  SettingsPage: withSuspense(SettingsPage as React.ComponentType),
  GatewayLayout: withSuspense(GatewayLayout as React.ComponentType),
};

/** 搜索参数即状态：保持页面自己约定的一组键（provider/range/lines/filter…）。 */
const keepSearch = (search: Record<string, unknown>): Record<string, unknown> => search;

function RoutePending() {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
      正在加载页面…
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <h1 className="text-base font-medium text-foreground">页面不存在</h1>
      <div>检查地址，或按 Ctrl/⌘ + K 打开命令面板。</div>
    </div>
  );
}

/** 路由渲染错误边界：单页异常时给出可读信息与重试，而不是白屏。 */
function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div role="alert" className="m-4 flex max-w-xl flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <h1 className="font-semibold text-destructive">页面渲染出错</h1>
      <p className="text-muted-foreground">{error instanceof Error ? error.message : '未知错误'}</p>
      <Button size="sm" variant="outline" onClick={reset}>
        重试
      </Button>
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Suspended.OverviewPage,
});
const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers',
  component: Suspended.ProvidersPage,
  validateSearch: keepSearch,
});
const quotaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quota',
  component: Suspended.QuotaPage,
  validateSearch: keepSearch,
});
const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: Suspended.AccountsPage,
  validateSearch: keepSearch,
});
const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  component: Suspended.LogsPage,
  validateSearch: keepSearch,
});
const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: Suspended.DiagnosticsPage,
  validateSearch: keepSearch,
});
const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/usage',
  component: Suspended.UsagePage,
  validateSearch: keepSearch,
});
const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  component: Suspended.ReportsPage,
  validateSearch: keepSearch,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: Suspended.SettingsPage,
  validateSearch: keepSearch,
});

const gatewayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateway',
  component: Suspended.GatewayLayout,
  validateSearch: keepSearch,
});
const gatewayIndexRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: '/',
  component: SchedulerPage,
});
const gatewayUsageRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'usage',
  component: GatewayUsagePage,
  validateSearch: keepSearch,
});
const gatewayCombosRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'combos',
  component: CombosPage,
});
const gatewayKeysRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'keys',
  component: KeysPage,
});
const gatewayFreeRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'free',
  component: FreeProvidersPage,
});
const gatewayLocalRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'local-answers',
  component: LocalAnswersPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  providersRoute,
  quotaRoute,
  accountsRoute,
  logsRoute,
  diagnosticsRoute,
  usageRoute,
  reportsRoute,
  settingsRoute,
  gatewayRoute.addChildren([
    gatewayIndexRoute,
    gatewayUsageRoute,
    gatewayCombosRoute,
    gatewayKeysRoute,
    gatewayFreeRoute,
    gatewayLocalRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 150,
  defaultPendingMinMs: 300,
  defaultErrorComponent: RouteError,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}