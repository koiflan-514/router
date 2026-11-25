import type { GatewayProviderSnap } from '@/lib/contract';
import type { Combo, GatewayUsage } from '@/lib/schemas';

/**
 * 网关页的纯派生逻辑：按天聚合、Top 表、错误率、调度 lane 指标、降级链可用性。
 *
 * 口径：这里是**网关转发的 HTTP 请求**；与 `/usage` 的 OpenCode 会话 steps 不同，
 * 不互相换算、不相加。未知字段一律 null / `—`，不猜 0。
 */

function numOf(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOf(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

export interface GatewayDayPoint {
  day: string;
  label: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  avgDurationMs: number | null;
  errorRate: number | null;
}

export function gatewayDayPoints(usage: GatewayUsage): GatewayDayPoint[] {
  return usage.byDay
    .map((row) => {
      const day = strOf(row, 'day');
      const requests = numOf(row, 'requests') ?? 0;
      const errors = numOf(row, 'errors') ?? 0;
      const inputTokens = numOf(row, 'inputTokens') ?? 0;
      const outputTokens = numOf(row, 'outputTokens') ?? 0;
      const avgDurationMs = numOf(row, 'avgDurationMs');
      return {
        day,
        label: day.length >= 10 ? day.slice(5) : day,
        requests,
        errors,
        inputTokens,
        outputTokens,
        avgDurationMs,
        errorRate: requests > 0 ? errors / requests : null,
      };
    })
    .filter((row) => row.day.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
}

export interface GatewayAggRow {
  label: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  errorRate: number | null;
  /** 请求占总量；总量为 0 时为 null。 */
  share: number | null;
}

function aggRows(
  rows: Array<Record<string, unknown>>,
  key: 'provider' | 'model',
  totalRequests: number,
): GatewayAggRow[] {
  return rows
    .map((row) => {
      const label = strOf(row, key) || (key === 'model' ? strOf(row, 'id') : '');
      const requests = numOf(row, 'requests') ?? 0;
      const errors = numOf(row, 'errors') ?? 0;
      return {
        label: label || '—',
        requests,
        errors,
        inputTokens: numOf(row, 'inputTokens') ?? 0,
        outputTokens: numOf(row, 'outputTokens') ?? 0,
        errorRate: requests > 0 ? errors / requests : null,
        share: totalRequests > 0 ? requests / totalRequests : null,
      };
    })
    .filter((row) => row.label !== '—')
    .sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));
}

export function gatewayProviderRows(usage: GatewayUsage): GatewayAggRow[] {
  return aggRows(usage.byProvider, 'provider', usage.requests);
}

export function gatewayModelRows(usage: GatewayUsage): GatewayAggRow[] {
  return aggRows(usage.byModel, 'model', usage.requests);
}

export interface GatewayTotals {
  requests: number;
  errors: number;
  errorRate: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgDurationMs: number | null;
}

export function gatewayTotals(usage: GatewayUsage): GatewayTotals {
  const points = gatewayDayPoints(usage);
  let durationWeight = 0;
  let durationSum = 0;
  for (const point of points) {
    if (point.avgDurationMs === null) continue;
    durationWeight += point.requests;
    durationSum += point.avgDurationMs * point.requests;
  }
  return {
    requests: usage.requests,
    errors: usage.errors,
    errorRate: usage.requests > 0 ? usage.errors / usage.requests : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    avgDurationMs: durationWeight > 0 ? durationSum / durationWeight : null,
  };
}

export function shareRatio(value: number, total: number): number | null {
  return total > 0 ? value / total : null;
}

/** 冷却剩余（毫秒）与是否仍在冷却。缺失 / 非有限 / 已过期都视为无冷却。 */
export function cooldownState(
  provider: GatewayProviderSnap,
  now: number,
): { active: boolean; until: number | null; iso: string | null; kind: string | null } {
  const until =
    typeof provider.cooldownUntil === 'number' && Number.isFinite(provider.cooldownUntil)
      ? provider.cooldownUntil
      : null;
  const active = until !== null && until > now;
  return {
    active,
    until: active ? until : null,
    iso: active && until !== null ? new Date(until).toISOString() : null,
    kind: active ? (provider.cooldownKind ?? null) : null,
  };
}

export type LaneStatus = 'cooling' | 'running' | 'busy' | 'stopped' | 'unknown';

export interface SchedulerLane {
  id: string;
  status: LaneStatus;
  running: boolean;
  dialect: GatewayProviderSnap['dialect'];
  port: number | null;
  weight: number;
  /** 相对当前批次最大手动权重的百分比（仅用于条形宽度）。 */
  weightPct: number;
  inFlight: number;
  /** 相对本批最大并发的百分比（至少 1 作为分母）。 */
  loadPct: number;
  successRate: number | null;
  /** 最近一次调用时间；null/0 表示从未调用。 */
  lastUsedAt: number | null;
  consecutiveFails: number;
  sticky: number;
  quotaRatio: number | null;
  cooldown: ReturnType<typeof cooldownState>;
}

export function maxWeightOf(providers: GatewayProviderSnap[]): number {
  return providers.reduce((max, p) => (Number.isFinite(p.weight) && p.weight > max ? p.weight : max), 0);
}

export function schedulerLanes(providers: GatewayProviderSnap[], now: number): SchedulerLane[] {
  const maxWeight = maxWeightOf(providers);
  const maxInFlight = providers.reduce(
    (max, p) => (Number.isFinite(p.inFlight) && p.inFlight > max ? p.inFlight : max),
    0,
  );
  return providers.map((provider) => {
    const cooldown = cooldownState(provider, now);
    const status: LaneStatus = cooldown.active
      ? 'cooling'
      : !provider.running
        ? 'stopped'
        : provider.inFlight > 0
          ? 'busy'
          : 'running';
    const lastUsedAt =
      typeof provider.lastUsedAt === 'number' && provider.lastUsedAt > 0 ? provider.lastUsedAt : null;
    // 没有样本 = 没有 lastUsedAt，或 lastUsedAt 缺失但仍被兜底成 0。
    // 反过来，successRate=0 且确有 lastUsedAt 是真的全失败，必须保留 0。
    const successRate = lastUsedAt === null ? null : provider.successRate;
    return {
      id: provider.id,
      status,
      running: provider.running,
      dialect: provider.dialect,
      port: provider.port,
      weight: provider.weight,
      weightPct: maxWeight > 0 ? Math.max(0, Math.min(100, (provider.weight / maxWeight) * 100)) : 0,
      inFlight: provider.inFlight,
      loadPct:
        maxInFlight > 0 ? Math.max(0, Math.min(100, (provider.inFlight / Math.max(1, maxInFlight)) * 100)) : 0,
      successRate,
      lastUsedAt,
      consecutiveFails: provider.consecutiveFails,
      sticky: provider.sticky ?? 0,
      quotaRatio: provider.quotaRatio,
      cooldown,
    };
  });
}

const COOLDOWN_KINDS: Record<string, string> = {
  auth: '凭据失效',
  permission: '权限受限',
  billing: '额度不足',
  rate_limit: '限流',
  overloaded: '上游过载',
  context_window: '上下文溢出',
  invalid_request: '请求非法',
  upstream: '上游错误',
  upstream_5xx: '上游 5xx',
  upstream_4xx: '上游 4xx',
  timeout: '超时',
};

export function cooldownKindLabel(kind: string | null | undefined): string {
  if (!kind) return '未知原因';
  return COOLDOWN_KINDS[kind] ?? kind;
}

export type ComboStepStatus = 'ready' | 'cooldown' | 'offline' | 'unknown';

export interface ComboStep {
  index: number;
  raw: string;
  provider: string | null;
  model: string;
  status: ComboStepStatus;
  cooldownKind: string | null;
}

function splitRing(model: string): { provider: string | null; model: string } {
  const i = model.indexOf('/');
  if (i <= 0) return { provider: null, model };
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}

export function comboSteps(
  combo: Combo,
  providers: GatewayProviderSnap[] | null,
  now: number,
): ComboStep[] {
  const byId = new Map(providers?.map((p) => [p.id, p]) ?? []);
  return combo.models.map((raw, index) => {
    const ring = splitRing(raw);
    if (!ring.provider) {
      return { index, raw, provider: null, model: ring.model, status: 'unknown', cooldownKind: null };
    }
    const provider = byId.get(ring.provider);
    if (!provider) {
      return {
        index,
        raw,
        provider: ring.provider,
        model: ring.model,
        status: 'unknown',
        cooldownKind: null,
      };
    }
    const cooldown = cooldownState(provider, now);
    const status: ComboStepStatus = cooldown.active
      ? 'cooldown'
      : provider.running
        ? 'ready'
        : 'offline';
    return {
      index,
      raw,
      provider: ring.provider,
      model: ring.model,
      status,
      cooldownKind: cooldown.kind,
    };
  });
}

export interface ComboReadiness {
  ready: number;
  total: number;
  status: 'ready' | 'partial' | 'down' | 'unknown';
}

export function comboReadiness(steps: ComboStep[]): ComboReadiness {
  const total = steps.length;
  const ready = steps.filter((step) => step.status === 'ready').length;
  const known = steps.filter((step) => step.status !== 'unknown').length;
  if (total === 0) return { ready: 0, total: 0, status: 'down' };
  if (known === 0) return { ready, total, status: 'unknown' };
  if (ready === total) return { ready, total, status: 'ready' };
  if (ready > 0) return { ready, total, status: 'partial' };
  return { ready, total, status: 'down' };
}