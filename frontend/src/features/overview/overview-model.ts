import {
  DASH,
  fmtNumber,
} from '@/lib/format';
import type { AuthState, ProviderStatus, QuotaRow, UsageStats } from '@/lib/contract';
import type { QuotaPayload } from '@/lib/query';

/**
 * 总览页的纯派生逻辑（对齐 00 设计基线 §7 状态口径 / 03 界面设计 §3.1）。
 *
 * 这里只做「由后端字段逐项推导」的展示辅助：不猜 drift、不把 null 当 0、
 * 不把 steps 当请求数、不把不同单位相加。所有数字都能在 provider / quota / usage
 * 明细里找到对应项，保证汇总「可解释」。
 */

/** 计入「认证提醒」的状态：unknown 不得渲染为正常，同样需要提醒。 */
export const AUTH_ISSUE_STATES: readonly AuthState[] = ['expiring', 'expired', 'missing', 'unknown'];

export function isAuthIssue(auth: ProviderStatus['auth']): boolean {
  return AUTH_ISSUE_STATES.includes(auth.state);
}

export interface OverviewSummary {
  /** 明细条目数（含网关叠加层）。 */
  total: number;
  /** on=true 数（网关叠加层 on==up，仍如实计数）。 */
  enabled: number;
  /** up=true 数，与 enabled 独立计算。 */
  running: number;
  /** auth.state ∈ {expiring,expired,missing,unknown} 数。 */
  authIssues: number;
  /** drift 非空数（由后端字段派生，UI 不猜）。 */
  drifted: number;
}

export function deriveSummary(providers: ProviderStatus[]): OverviewSummary {
  let enabled = 0;
  let running = 0;
  let authIssues = 0;
  let drifted = 0;
  for (const p of providers) {
    if (p.on) enabled += 1;
    if (p.up) running += 1;
    if (isAuthIssue(p.auth)) authIssues += 1;
    if (p.drift.length > 0) drifted += 1;
  }
  return { total: providers.length, enabled, running, authIssues, drifted };
}

const DRIFT_TEXT: Record<string, string> = {
  stopped: '开关=开、进程=停止',
  notSynced: '开关=开、opencode 未写入',
  stillRunning: '开关=关、进程仍在运行',
};

export function driftDetailText(p: ProviderStatus): string {
  if (!p.drift.length) return DASH;
  return p.drift.map((d) => DRIFT_TEXT[d] ?? d).join('；');
}

/** 四态组合的一句话说明，用于详情面板与异常入口（列出"具体组合"而非只写"异常"）。 */
export function stateComboText(p: ProviderStatus): string {
  const parts = [p.on ? '开关=开' : '开关=关', p.up ? '进程=运行' : '进程=停止'];
  if (p.ocUserOwned) parts.push('opencode=用户自管');
  else parts.push(p.oc ? 'opencode=已写入' : 'opencode=未写入');
  return parts.join('、');
}

/** 漂移行的「下一步」文案与目标页（本页只跳转，不写操作）。 */
export function driftNextStep(drift: ProviderStatus['drift']): { label: string; to: 'providers' | 'logs' } | null {
  if (drift.includes('stopped')) return { label: '启动 / 查看日志', to: 'providers' };
  if (drift.includes('notSynced')) return { label: '同步客户端', to: 'providers' };
  if (drift.includes('stillRunning')) return { label: '停止进程', to: 'providers' };
  return null;
}

export interface UsageKpi {
  sessions: number;
  prompts: number;
  subagents: number;
  steps: number;
  input: number;
  output: number;
  reasoning: number;
  /** input + output + reasoning；缓存读/写不重复累计。 */
  tokenTotal: number;
  cacheRead: number;
  cacheWrite: number;
  toolSucceeded: number;
  toolFailed: number;
  /** 已发起但既未成功也未失败（calls - succeeded - failed），可能为 0。 */
  toolUnfinished: number;
  toolCalls: number;
  /** 成功率 0–1；无法计算时为 null（不伪造）。 */
  toolRate: number | null;
  toolsReported: boolean;
}

export function deriveUsageKpi(u: UsageStats): UsageKpi {
  const input = u.tokens?.input ?? 0;
  const output = u.tokens?.output ?? 0;
  const reasoning = u.tokens?.reasoning ?? 0;
  const calls = u.tools?.totals?.calls ?? 0;
  const succeeded = u.tools?.totals?.succeeded ?? 0;
  const failed = u.tools?.totals?.failed ?? 0;
  const unfinished = Math.max(0, calls - succeeded - failed);
  // 成功率 = 成功 /（成功+失败）：未完成不计入分母，也避免在无完成调用时伪造 0%。
  const denom = succeeded + failed;
  const toolRate = denom > 0 ? succeeded / denom : null;
  return {
    sessions: u.sessions,
    prompts: u.prompts,
    subagents: u.subagents,
    steps: u.steps,
    input,
    output,
    reasoning,
    tokenTotal: input + output + reasoning,
    cacheRead: u.tokens?.cache?.read ?? 0,
    cacheWrite: u.tokens?.cache?.write ?? 0,
    toolSucceeded: succeeded,
    toolFailed: failed,
    toolUnfinished: unfinished,
    toolCalls: calls,
    toolRate,
    toolsReported: Boolean(u.tools?.totals),
  };
}

/** 查询成功但确实没有会话/步骤/模型时视为空（0 是真实值，不等于未查询）。 */
export function usageHasData(u: UsageStats): boolean {
  const k = deriveUsageKpi(u);
  return (
    k.sessions > 0 ||
    k.prompts > 0 ||
    k.steps > 0 ||
    k.tokenTotal > 0 ||
    u.models.length > 0
  );
}

export type QuotaIndex = Map<string, QuotaRow>;

export function buildQuotaIndex(payload: QuotaPayload | null): QuotaIndex {
  const idx: QuotaIndex = new Map();
  for (const row of payload?.providers ?? []) {
    if (!idx.has(row.provider)) idx.set(row.provider, row);
  }
  return idx;
}

/** 额度摘要（一行文字）：仅在接口给出数值时展示，未知显示 `—`。 */
export function quotaSummaryText(row: QuotaRow | undefined): string {
  if (!row) return DASH;
  if (row.available === false) return '不可用';
  const buckets = row.buckets ?? [];
  if (buckets.length > 0) {
    const b = buckets.find((x) => x.remaining !== null) ?? buckets[0];
    const total = typeof b.total === 'number' && b.total > 0 ? ` / ${fmtNumber(b.total)}` : '';
    const more = buckets.length > 1 ? `（共 ${buckets.length} 项）` : '';
    return `${fmtNumber(b.remaining)}${total} ${b.unit}${more}`.trim();
  }
  if (row.accounts && row.accounts.length > 0) {
    return `${row.accounts.length} 个账号`;
  }
  if (row.checkin?.claimable) return '可领取';
  if (row.reason) return row.reason;
  if (row.detail) return row.detail;
  return DASH;
}

export type SortKey = 'id' | 'on' | 'up' | 'auth' | 'client' | 'drift' | 'port' | 'models';
export type SortDir = 'asc' | 'desc';

export const SORT_KEYS: readonly SortKey[] = ['id', 'on', 'up', 'auth', 'client', 'drift', 'port', 'models'];

export function isSortKey(v: unknown): v is SortKey {
  return typeof v === 'string' && (SORT_KEYS as readonly string[]).includes(v);
}

export function isSortDir(v: unknown): v is SortDir {
  return v === 'asc' || v === 'desc';
}

const AUTH_RANK: Record<AuthState, number> = {
  expired: 0,
  missing: 1,
  expiring: 2,
  unknown: 3,
  valid: 4,
};

function sortValue(p: ProviderStatus, key: SortKey): number | string {
  switch (key) {
    case 'id':
      return p.id;
    case 'on':
      return p.on ? 1 : 0;
    case 'up':
      return p.up ? 1 : 0;
    case 'auth':
      return AUTH_RANK[p.auth.state];
    case 'client':
      return p.ocUserOwned ? 2 : p.oc ? 1 : 0;
    case 'drift':
      return p.drift.length;
    case 'port':
      return p.port > 0 ? p.port : Number.POSITIVE_INFINITY;
    case 'models':
      return p.models === null ? Number.POSITIVE_INFINITY : p.models;
  }
}

export function sortProviders(list: ProviderStatus[], key: SortKey, dir: SortDir): ProviderStatus[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return a.id.localeCompare(b.id);
  });
}

/** 关键词筛选（仅作用于 id/title），大小写不敏感。 */
export function filterProviders(list: ProviderStatus[], q: string, provider: string | undefined): ProviderStatus[] {
  const kw = q.trim().toLowerCase();
  return list.filter((p) => {
    if (provider && p.id !== provider) return false;
    if (!kw) return true;
    return p.id.toLowerCase().includes(kw) || p.title.toLowerCase().includes(kw);
  });
}
