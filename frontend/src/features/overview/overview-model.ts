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

/* ==========================================================================
 * Fluent 总览扩展派生（全部由既有后端字段推导，不新增数据源）
 * ========================================================================== */

export interface DailyPoint {
  /** ISO 日期（activity[].date 原样，可能缺失）。 */
  date: string | null;
  steps: number;
}

/** 近 N 天 activity 序列（按数组顺序，不排序也不补零日期，避免伪造）。 */
export function activitySeries(u: UsageStats | null | undefined): DailyPoint[] {
  const list = u?.activity ?? [];
  return list.map((a) => ({ date: a.date ?? null, steps: a.steps ?? 0 }));
}

/** 只取有值的数值序列（供 sparkline 使用）；少于 2 点交给 Sparkline 显示占位。 */
export function activityValues(u: UsageStats | null | undefined): number[] {
  return activitySeries(u).map((p) => p.steps);
}

/** 首尾对比：用于 KPI 趋势；任一缺失返回 null（不编造 0 基线）。 */
export function activityTrend(u: UsageStats | null | undefined): number | null {
  const v = activityValues(u);
  if (v.length < 2) return null;
  return v[v.length - 1] - v[0];
}

export interface HealthBreakdown {
  running: number;
  authOk: number;
  clientSynced: number;
  noDrift: number;
  /** 非叠加层条目数（叠加层不参与 on/off/客户端判定）。 */
  managed: number;
  /** 0–100；managed=0 时为 null（无法计算，不画成 0%）。 */
  score: number | null;
}

/**
 * 健康度 = 四项达标率的平均（运行 / 认证正常 / 客户端已写入 / 无漂移）。
 *
 * 口径与 SummaryStrip 一致：各项独立计数；网关叠加层不计入 managed，
 * 认证 unknown 计为不达标（与 isAuthIssue 对齐）。
 */
export function deriveHealth(providers: ProviderStatus[]): HealthBreakdown {
  const managed = providers.filter((p) => !p.overlay);
  const n = managed.length;
  const running = managed.filter((p) => p.up).length;
  const authOk = managed.filter((p) => !isAuthIssue(p.auth)).length;
  const clientSynced = managed.filter((p) => p.oc).length;
  const noDrift = managed.filter((p) => p.drift.length === 0).length;
  const score = n === 0 ? null : Math.round(((running + authOk + clientSynced + noDrift) / (n * 4)) * 100);
  return { running, authOk, clientSynced, noDrift, managed: n, score };
}

export interface QuotaTopRow {
  provider: string;
  title: string;
  /** 剩余占比 0–1；无法计算时为 null（buckets 无 total 或无数值）。 */
  ratio: number | null;
  /** 展示文本，复用 quotaSummaryText。 */
  text: string;
}

/** 额度 Top：按剩余占比降序，只含能算出占比的行；无占比的行排最后。 */
export function quotaTop(payload: { providers: QuotaRow[] } | null, limit = 5): QuotaTopRow[] {
  const rows: QuotaTopRow[] = (payload?.providers ?? []).map((r) => {
    const buckets = r.buckets ?? [];
    let ratio: number | null = null;
    for (const b of buckets) {
      if (typeof b.total === 'number' && b.total > 0 && typeof b.remaining === 'number') {
        ratio = Math.max(0, Math.min(1, b.remaining / b.total));
        break;
      }
    }
    return { provider: r.provider, title: r.title, ratio, text: quotaSummaryText(r) };
  });
  const known = rows.filter((r) => r.ratio !== null).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  const unknown = rows.filter((r) => r.ratio === null);
  return [...known, ...unknown].slice(0, limit);
}

export interface AttentionItem {
  id: string;
  provider: string;
  title: string;
  kind: 'drift' | 'auth';
  text: string;
}

/** 待处理事项：漂移与认证异常逐项展开（供右侧栏紧凑列表）。 */
export function attentionItems(providers: ProviderStatus[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const p of providers) {
    if (p.drift.length) {
      items.push({ id: `${p.id}-drift`, provider: p.id, title: p.title, kind: 'drift', text: driftDetailText(p) });
    }
    if (isAuthIssue(p.auth)) {
      items.push({ id: `${p.id}-auth`, provider: p.id, title: p.title, kind: 'auth', text: stateComboText(p) });
    }
  }
  return items;
}

/** 可领取数：后端显式 checkin.claimable=true 的来源数。 */
export function claimableCount(payload: { providers: QuotaRow[] } | null): number {
  return (payload?.providers ?? []).filter((r) => r.checkin?.claimable).length;
}

/**
 * 一个额度条的分桶展示数据（仅取第一个有 total 的桶，其余在详情页查看）。
 * 与 ProviderTable 的「额度摘要」口径一致：total>0 才画进度。
 */
export function quotaBarFor(row: QuotaRow | undefined): { pct: number; label: string } | null {
  if (!row) return null;
  for (const b of row.buckets ?? []) {
    if (typeof b.total === 'number' && b.total > 0 && typeof b.remaining === 'number') {
      const pct = Math.max(0, Math.min(100, (b.remaining / b.total) * 100));
      const label = b.label?.trim() || '额度';
      return { pct, label };
    }
  }
  return null;
}
