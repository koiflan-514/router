import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { MetricCard } from '@/components/shared/metric-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DASH } from '@/lib/format';
import { useEnv, useInvalidateAll, useProviders } from '@/lib/query';
import { useTheme } from '@/lib/theme';
import {
  AppearanceCard,
  ConnectionCard,
  LocalPreferencesCard,
  ProvidersCard,
  RefreshPolicyCard,
  RuntimeModesCard,
} from './sections';

/**
 * 设置页（`/settings`，FR-180–189）。
 *
 * 只做三件事：呈现只读的运行环境与刷新策略、切换本机主题、保存纯本地浏览器偏好。
 * 运行模式（dev/start/--demo/--read-only）是桥接的启动参数，页面**不提供**切换入口。
 */
export function SettingsPage() {
  const env = useEnv();
  const providers = useProviders();
  const invalidateAll = useInvalidateAll();
  const { theme, resolved } = useTheme();

  const resolvedLabel = resolved === 'dark' ? '深色' : '浅色';
  const themeLabel = theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色';
  const gatewayUrl = env.data?.gateway.url ?? '';
  // 三态：true=可达 / false=不可达 / null=未知（未查询），不能把未知说成不可达。
  const gatewayReachable = env.data ? env.data.gateway.reachable : null;
  const gatewayText =
    gatewayReachable === null ? '网关状态未知' : gatewayReachable ? '网关可达' : '网关不可达';
  const gatewayTone =
    gatewayReachable === null ? 'default' : gatewayReachable ? 'success' : 'warning';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="设置"
        description="主题、刷新策略、运行模式与桥接连接；运行模式由启动参数决定，页面不提供切换。"
        actions={
          <Button variant="outline" size="sm" onClick={invalidateAll}>
            <RefreshCw className="size-4" />
            立即刷新全部数据
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="当前主题"
          value={resolvedLabel}
          sub={theme === 'system' ? `${themeLabel}（当前生效 ${resolvedLabel}）` : `固定 ${themeLabel}`}
          hint="本机浏览器偏好"
        />
        <MetricCard
          label="刷新间隔摘要"
          value="provider 5s"
          sub="额度 / 用量 120s · 网关 5s / 60s"
          hint="页面不可见时暂停"
        />
        <MetricCard
          label="工作范围"
          value={env.data ? (env.data.mode === 'demo' ? '演示' : '本机') : DASH}
          sub={
            env.data ? (
              env.data.readOnly ? (
                <Badge variant="warning">只读</Badge>
              ) : (
                <Badge variant="muted">可写</Badge>
              )
            ) : (
              '桥接不可达'
            )
          }
          tone={env.data?.mode === 'demo' ? 'info' : 'default'}
        />
        <MetricCard
          label="桥接"
          value={env.data?.panelVersion || DASH}
          sub={env.data ? gatewayText : '未连接'}
          hint={gatewayUrl || undefined}
          tone={env.data ? gatewayTone : 'warning'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AppearanceCard />
        <LocalPreferencesCard providers={(providers.data ?? []).map((p) => ({ id: p.id, title: p.title }))} />
        <ConnectionCard env={env} />
        <RefreshPolicyCard onRefresh={invalidateAll} />
        <div className="lg:col-span-2">
          <RuntimeModesCard env={env.data} />
        </div>
        <div className="lg:col-span-2">
          <ProvidersCard providers={providers} />
        </div>
      </div>
    </div>
  );
}
