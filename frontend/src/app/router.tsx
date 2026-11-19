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
const SettingsPage = lazyRouteComponent(() => import('@/features/settings/SettingsPage'), 'SettingsPage');

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
  component: OverviewPage,
});
const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers',
  component: ProvidersPage,
  validateSearch: keepSearch,
});
const quotaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quota',
  component: QuotaPage,
  validateSearch: keepSearch,
});
const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: AccountsPage,
  validateSearch: keepSearch,
});
const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  component: LogsPage,
  validateSearch: keepSearch,
});
const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: DiagnosticsPage,
  validateSearch: keepSearch,
});
const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/usage',
  component: UsagePage,
  validateSearch: keepSearch,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
  validateSearch: keepSearch,
});

const gatewayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateway',
  component: GatewayLayout,
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