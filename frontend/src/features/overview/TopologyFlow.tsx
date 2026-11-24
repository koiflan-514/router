import { ArrowRight, Waypoints } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Surface } from '@/components/shared/surface';
import { cn } from '@/lib/cn';
import type { ProviderStatus } from '@/lib/contract';

/**
 * 服务拓扑 / 流向条：来源 provider（十三家）→ 统一网关 → 客户端。
 *
 * 纯展示：只使用 providers 列表里真实存在的条目；不伪造流量数字，
 * 也不暗示「请求经过网关」以外的因果（部分 provider 是直连）。
 * 网关为叠加层（overlay），单独以 accent 胶囊强调。
 */
export function TopologyFlow({
  providers,
  className,
}: {
  providers: ProviderStatus[];
  className?: string;
}) {
  const sources = providers.filter((p) => !p.overlay);
  const overlays = providers.filter((p) => p.overlay);
  const running = sources.filter((p) => p.up).length;
  const upOverlays = overlays.filter((p) => p.up).length;

  return (
    <Surface
      level={2}
      padding="none"
      className={cn('flex flex-col gap-2 px-3 py-2.5', className)}
      role="group"
      aria-label="服务拓扑：来源服务 → 统一网关 → 客户端"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
          <Waypoints aria-hidden className="size-3.5" />
          拓扑
        </span>

        <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label={`来源服务 ${sources.length} 个，运行 ${running} 个`}>
          {sources.map((p) => (
            <span
              key={p.id}
              title={`${p.title}（${p.id}）：${p.up ? '运行中' : '已停止'}`}
              className="inline-flex items-center gap-1 rounded-[4px] border border-stroke-1 bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-secondary"
            >
              <span
                aria-hidden
                className={cn('size-1.5 rounded-full', p.up ? 'bg-success' : 'bg-text-tertiary/50')}
              />
              <span className="max-w-[7rem] truncate">{p.title}</span>
            </span>
          ))}
          {sources.length === 0 ? (
            <span className="text-[11px] text-text-tertiary">未返回来源服务</span>
          ) : null}
        </div>

        <ArrowRight aria-hidden className="size-4 shrink-0 text-text-tertiary" />

        <div className="flex flex-wrap items-center gap-1">
          {overlays.length ? (
            overlays.map((p) => (
              <Badge key={p.id} variant={p.up ? 'info' : 'muted'} className="gap-1">
                <span aria-hidden className={cn('size-1.5 rounded-full', p.up ? 'bg-info' : 'bg-text-tertiary/60')} />
                {p.title}
              </Badge>
            ))
          ) : (
            <Badge variant="muted">统一网关（未返回）</Badge>
          )}
          <span className="text-[11px] text-text-tertiary">
            {overlays.length ? `${upOverlays}/${overlays.length} 运行` : '—'}
          </span>
        </div>

        <ArrowRight aria-hidden className="size-4 shrink-0 text-text-tertiary" />

        <div className="flex items-center gap-1" aria-label="客户端">
          {['OpenCode', 'Codex', 'Claude'].map((c) => (
            <span
              key={c}
              className="rounded-[4px] border border-dashed border-stroke-2 px-1.5 py-0.5 text-[11px] text-text-tertiary"
            >
              {c}
            </span>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-text-tertiary">
        来源 {sources.length} 个 · 运行 {running} 个 · 网关为叠加层（on==up，不参与开关统计）；这里只展示目录结构，不代表实时流量。
      </p>
    </Surface>
  );
}
