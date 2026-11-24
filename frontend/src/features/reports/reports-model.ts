import type { GatewayStatus, ProviderStatus, QuotaRow, UsageRange, UsageStats } from '@/lib/contract';
import type { GatewayUsage } from '@/lib/schemas';
import { DASH } from '@/lib/format';
import {
  gatewayDayPoints,
  gatewayProviderRows,
  gatewayTotals,
  schedulerLanes,
  type GatewayAggRow,
  type GatewayDayPoint,
  type GatewayTotals,
} from '@/features/gateway/gateway-model';
import {
  bucketGauge,
  bucketListOf,
  bucketStatus,
  isWorkBuddyProvider,
  normalizeQuotaRow,
  quotaCoverage,
  rowStatus,
  summarizeQuota,
  type QuotaProviderLayer,
} from '@/features/quota/quota-model';
import {
  activityPoints,
  hasDailyTokens,
  rangeLabel,
  tokenBreakdown,
  tokenComposition,
  toModelDetail,
  toolsSummary,
  type ActivityPoint,
  type ModelDetail,
} from '@/features/usage/usage-model';

/**
 * 报表页纯逻辑：把 5 个现有只读数据源拼成一份可导出、可复述的模型。
 *
 * 口径红线：
 * - steps ≠ HTTP 请求数；gateway requests 单独成列，两者不相加。
 * - cost ≠ 积分余额；不折算、不跨厂商求和。
 * - 额度只做来源覆盖与告警，不跨 provider 汇总余额。
 * - 没有数据就留空，不生成趋势、不补 0、不编造结论。
 */

export type ReportSourceState = 'ok' | 'loading' | 'error' | 'stale' | 'empty';

export interface ReportSourceStatus {
  key: string;
  label: string;
  state: ReportSourceState;
  detail?: string;
}

export interface ReportConclusion {
  tone: 'info' | 'success' | 'warning' | 'destructive';
  text: string;
}

export interface ReportUsageProviderRow {
  provider: string;
  steps: number;
  cost: number;
  tokens: number;
  share: number | null;
}

export interface ReportQuotaRowSummary {
  provider: string;
  title: string;
  available: boolean;
  status: ReturnType<typeof rowStatus>;
  accounts: number;
  fetchedAt: string | null;
  buckets: Array<{
    id: string;
    label: string;
    remaining: number | null;
    total: number | null;
    unit: string;
    pct: number | null;
    status: ReturnType<typeof bucketStatus>;
  }>;
}

export interface ReportProviderRow {
  id: string;
  title: string;
  on: boolean;
  up: boolean;
  overlay: boolean;
  auth: ProviderStatus['auth']['state'];
  drift: ProviderStatus['drift'];
}

export interface ReportModel {
  generatedAt: string;
  range: UsageRange;
  rangeLabel: string;
  sources: ReportSourceStatus[];
  conclusions: ReportConclusion[];
  usage: {
    sessions: number;
    prompts: number;
    steps: number;
    activeDays: number;
    streak: number;
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      composition: number;
      cacheRead: number;
      cacheWrite: number;
    };
    tools: { rate: number; calls: number; succeeded: number; failed: number; pending: number } | null;
    daily: ActivityPoint[];
    dailyTokensAvailable: boolean;
    providerRows: ReportUsageProviderRow[];
    modelRows: ModelDetail[];
    topModel: ModelDetail | null;
  };
  gateway: {
    days: number;
    totals: GatewayTotals;
    daily: GatewayDayPoint[];
    providerRows: GatewayAggRow[];
    running: number | null;
    providers: number | null;
    cooling: number | null;
  };
  quota: {
    coverage: { available: number; total: number; ratio: number | null };
    alerts: string[];
    providers: ReportQuotaRowSummary[];
    workbuddyDays: Array<{ provider: string; title: string; days: number | null; expiry: string | null }>;
  };
  providers: ReportProviderRow[];
  providerIssues: number;
}

export interface BuildReportInput {
  range: UsageRange;
  usage: UsageStats | null;
  quotaRows: QuotaRow[] | null;
  providers: ProviderStatus[] | null;
  gatewayUsage: GatewayUsage | null;
  gatewayStatus: GatewayStatus | null;
  gatewayDays: number;
  sources: ReportSourceStatus[];
  now?: number;
}

function providerRowsFromUsage(usage: UsageStats): {
  providerRows: ReportUsageProviderRow[];
  modelRows: ModelDetail[];
  topModel: ModelDetail | null;
} {
  const modelRows = usage.models
    .map(toModelDetail)
    .sort((a, b) => b.steps - a.steps || a.key.localeCompare(b.key));
  const map = new Map<string, { provider: string; steps: number; cost: number; tokens: number }>();
  const totalSteps = modelRows.reduce((sum, row) => sum + Math.max(0, row.steps), 0);
  for (const row of modelRows) {
    const provider = row.providerID || DASH;
    const cur = map.get(provider) ?? { provider, steps: 0, cost: 0, tokens: 0 };
    cur.steps += Math.max(0, row.steps);
    cur.cost += Math.max(0, row.cost);
    cur.tokens += (row.input ?? 0) + (row.output ?? 0) + (row.reasoning ?? 0);
    map.set(provider, cur);
  }
  const providerRows = [...map.values()]
    .map((row) => ({
      ...row,
      share: totalSteps > 0 ? row.steps / totalSteps : null,
    }))
    .sort((a, b) => b.steps - a.steps || a.provider.localeCompare(b.provider));
  return { providerRows, modelRows, topModel: modelRows[0] ?? null };
}

function quotaSummaryRows(layers: QuotaProviderLayer[]): ReportQuotaRowSummary[] {
  return layers.map((row) => ({
    provider: row.provider,
    title: row.title,
    available: row.available,
    status: rowStatus(row),
    accounts: row.accounts.length,
    fetchedAt: row.fetchedAt,
    buckets: bucketListOf(row).map((bucket) => {
      const gauge = bucketGauge(bucket);
      return {
        id: bucket.id,
        label: bucket.label || bucket.id,
        remaining: gauge.remaining,
        total: gauge.total,
        unit: gauge.unit,
        pct: gauge.pct,
        status: bucketStatus(bucket),
      };
    }),
  }));
}

function buildConclusions(input: {
  usage: UsageStats | null;
  usageRows: ReturnType<typeof providerRowsFromUsage>;
  gatewayTotalsValue: GatewayTotals;
  gatewayDays: number;
  quota: ReturnType<typeof summarizeQuota>;
  coverage: ReturnType<typeof quotaCoverage>;
  quotaLayers: QuotaProviderLayer[];
  providers: ProviderStatus[] | null;
  sources: ReportSourceStatus[];
}): ReportConclusion[] {
  const out: ReportConclusion[] = [];
  const errors = input.sources.filter((s) => s.state === 'error');
  if (errors.length) {
    out.push({
      tone: 'warning',
      text: `${errors.map((s) => s.label).join('、')}读取失败；相关数字显示为 ${DASH}，不代表 0。`,
    });
  }

  const usage = input.usage;
  if (usage) {
    const tools = toolsSummary(usage);
    if (usage.sessions > 0 || usage.steps > 0) {
      out.push({
        tone: 'info',
        text: `范围内 ${usage.sessions} 个会话 / ${usage.prompts} 个提示 / ${usage.steps} 个会话步骤${
          tools ? `；工具成功率 ${(tools.rate * 100).toFixed(1)}%（失败 ${tools.failed} 次）` : ''
        }。`,
      });
    }
    const top = input.usageRows.topModel;
    if (top && top.steps > 0) {
      const total = input.usageRows.modelRows.reduce((sum, row) => sum + Math.max(0, row.steps), 0);
      const share = total > 0 ? (top.steps / total) * 100 : null;
      out.push({
        tone: 'info',
        text: `最忙模型 ${top.id}${top.providerID ? `（${top.providerID}）` : ''}：${top.steps} steps${
          share === null ? '' : `，占 ${share.toFixed(1)}%`
        }。`,
      });
    }
    if (usage.cost > 0) {
      out.push({
        tone: 'info',
        text: `OpenCode 上报成本 ${usage.cost}（客户端口径，不等于积分余额，不跨厂商求和）。`,
      });
    }
    if (!hasDailyTokens(usage)) {
      out.push({
        tone: 'info',
        text: 'OpenCode 未提供按日 Token：报表的趋势只展示 steps，不把总量平摊成假曲线。',
      });
    }
  }

  if (input.gatewayTotalsValue.requests > 0) {
    const rate = input.gatewayTotalsValue.errorRate;
    out.push({
      tone: rate !== null && rate >= 0.1 ? 'warning' : 'info',
      text: `网关近 ${input.gatewayDays} 天转发 ${input.gatewayTotalsValue.requests} 个请求，错误 ${input.gatewayTotalsValue.errors} 个${
        rate === null ? '' : `（错误率 ${(rate * 100).toFixed(1)}%）`
      }；该口径与 steps 不可相加。`,
    });
  }

  if (input.quota.total > 0) {
    out.push({
      tone: input.coverage.ratio !== null && input.coverage.ratio < 1 ? 'warning' : 'success',
      text: `额度覆盖 ${input.coverage.available}/${input.coverage.total} 家可查。`,
    });
  }
  if (input.quota.alerts.length) {
    const preview = input.quota.alerts.slice(0, 3).join('；');
    out.push({
      tone: 'warning',
      text: `${input.quota.alerts.length} 条额度提醒：${preview}${input.quota.alerts.length > 3 ? ' …' : ''}`,
    });
  }

  const workbuddyDays = input.quotaLayers
    .filter((row) => isWorkBuddyProvider(row.provider, row.kind))
    .flatMap((row) =>
      bucketListOf(row)
        .filter((bucket) => bucketStatus(bucket) === 'days')
        .map((bucket) => ({
          provider: row.provider,
          title: row.title,
          days: typeof bucket.remaining === 'number' ? bucket.remaining : null,
          expiry: bucket.resetDate ?? null,
        })),
    );
  if (workbuddyDays.length) {
    const item = workbuddyDays[0];
    out.push({
      tone: item.days !== null && item.days <= 7 ? 'warning' : 'info',
      text: `${item.title} 凭证有效期剩余 ${item.days === null ? DASH : item.days} 天（单独口径，不并入 credits）。`,
    });
  }

  if (input.providers && input.providers.length) {
    const down = input.providers.filter((p) => !p.up).length;
    const drift = input.providers.reduce((sum, p) => sum + p.drift.length, 0);
    if (down > 0) {
      out.push({ tone: 'warning', text: `${down} 家 provider 未运行或不可达。` });
    }
    if (drift > 0) {
      out.push({ tone: 'warning', text: `${drift} 项 provider 状态漂移（启用未运行 / 已关闭仍在运行 / 未同步客户端）。` });
    }
  }

  if (!out.length) {
    out.push({ tone: 'info', text: '当前范围没有足够数据生成结论；空状态不等于 0 消耗。' });
  }
  return out;
}

export function buildReportModel(input: BuildReportInput): ReportModel {
  const now = input.now ?? Date.now();
  const usage = input.usage;
  const quotaLayers = (input.quotaRows ?? []).map(normalizeQuotaRow);
  const quota = summarizeQuota(quotaLayers);
  const coverage = quotaCoverage(quotaLayers);
  const usageRows = usage
    ? providerRowsFromUsage(usage)
    : { providerRows: [], modelRows: [], topModel: null };
  const breakdown = usage ? tokenBreakdown(usage) : null;
  const tools = usage ? toolsSummary(usage) : null;
  const gatewayTotalsValue = input.gatewayUsage
    ? gatewayTotals(input.gatewayUsage)
    : {
        requests: 0,
        errors: 0,
        errorRate: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgDurationMs: null,
      };
  const gatewayStatus = input.gatewayStatus;
  const lanes = gatewayStatus ? schedulerLanes(gatewayStatus.providers, now) : [];
  const daily = usage ? activityPoints(usage) : [];
  const quotaProviders = quotaSummaryRows(quotaLayers);
  const workbuddyDays = quotaLayers
    .filter((row) => isWorkBuddyProvider(row.provider, row.kind))
    .flatMap((row) =>
      bucketListOf(row)
        .filter((bucket) => bucketStatus(bucket) === 'days')
        .map((bucket) => ({
          provider: row.provider,
          title: row.title,
          days: typeof bucket.remaining === 'number' ? bucket.remaining : null,
          expiry: bucket.resetDate ?? null,
        })),
    );

  const providers: ReportProviderRow[] = (input.providers ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    on: p.on,
    up: p.up,
    overlay: p.overlay,
    auth: p.auth.state,
    drift: p.drift,
  }));

  const conclusions = buildConclusions({
    usage,
    usageRows,
    gatewayTotalsValue,
    gatewayDays: input.gatewayDays,
    quota,
    coverage,
    quotaLayers,
    providers: input.providers,
    sources: input.sources,
  });

  return {
    generatedAt: new Date(now).toISOString(),
    range: input.range,
    rangeLabel: rangeLabel(input.range),
    sources: input.sources,
    conclusions,
    usage: {
      sessions: usage?.sessions ?? 0,
      prompts: usage?.prompts ?? 0,
      steps: usage?.steps ?? 0,
      activeDays: usage?.activeDays ?? 0,
      streak: usage?.streak ?? 0,
      cost: usage?.cost ?? 0,
      tokens: {
        input: usage?.tokens.input ?? 0,
        output: usage?.tokens.output ?? 0,
        reasoning: usage?.tokens.reasoning ?? 0,
        composition: usage ? tokenComposition(usage) : 0,
        cacheRead: usage?.tokens.cache?.read ?? 0,
        cacheWrite: usage?.tokens.cache?.write ?? 0,
      },
      tools,
      daily,
      dailyTokensAvailable: usage ? hasDailyTokens(usage) : false,
      providerRows: usageRows.providerRows,
      modelRows: usageRows.modelRows,
      topModel: usageRows.topModel,
    },
    gateway: {
      days: input.gatewayDays,
      totals: gatewayTotalsValue,
      daily: input.gatewayUsage ? gatewayDayPoints(input.gatewayUsage) : [],
      providerRows: input.gatewayUsage ? gatewayProviderRows(input.gatewayUsage) : [],
      running: gatewayStatus ? lanes.filter((lane) => lane.running).length : null,
      providers: gatewayStatus ? lanes.length : null,
      cooling: gatewayStatus ? lanes.filter((lane) => lane.cooldown.active).length : null,
    },
    quota: {
      coverage,
      alerts: quota.alerts,
      providers: quotaProviders,
      workbuddyDays,
    },
    providers,
    providerIssues: providers.filter((p) => !p.up || p.drift.length > 0).length,
  };
}

export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_HEADER = [
  'section',
  'name',
  'provider',
  'value',
  'steps',
  'requests',
  'errors',
  'input',
  'output',
  'reasoning',
  'cache_read',
  'cache_write',
  'cost',
  'remaining',
  'total',
  'unit',
  'status',
  'share',
];

/** CSV 明细：KPI、OpenCode 按日/模型/provider、网关按日、额度桶。 */
export function reportCsv(model: ReportModel): string {
  const rows: Array<Array<string | number | null>> = [CSV_HEADER];
  for (const source of model.sources) {
    rows.push(['source', source.label, '', source.state, '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  }
  const kpi = (name: string, value: string | number | null) => {
    rows.push(['kpi', name, '', value, '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  };
  kpi('range', model.rangeLabel);
  kpi('sessions', model.usage.sessions);
  kpi('prompts', model.usage.prompts);
  kpi('steps', model.usage.steps);
  kpi('active_days', model.usage.activeDays);
  kpi('streak', model.usage.streak);
  kpi('cost', model.usage.cost);
  kpi('tokens_composition', model.usage.tokens.composition);
  kpi('tools_success_rate', model.usage.tools?.rate ?? null);
  kpi('gateway_requests', model.gateway.totals.requests);
  kpi('gateway_errors', model.gateway.totals.errors);
  kpi('gateway_error_rate', model.gateway.totals.errorRate);
  kpi('quota_available', model.quota.coverage.available);
  kpi('quota_total', model.quota.coverage.total);

  for (const point of model.usage.daily) {
    rows.push([
      'usage_daily',
      point.date,
      '',
      '',
      point.steps,
      '',
      '',
      point.input,
      point.output,
      point.reasoning,
      point.cacheRead,
      point.cacheWrite,
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  }
  for (const row of model.usage.providerRows) {
    rows.push([
      'usage_provider',
      row.provider,
      row.provider,
      '',
      row.steps,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      row.cost,
      '',
      '',
      '',
      '',
      row.share,
    ]);
  }
  for (const row of model.usage.modelRows) {
    rows.push([
      'usage_model',
      row.id,
      row.providerID,
      '',
      row.steps,
      '',
      '',
      row.input,
      row.output,
      row.reasoning,
      row.cacheRead,
      row.cacheWrite,
      row.cost,
      '',
      '',
      '',
      '',
      '',
    ]);
  }
  for (const point of model.gateway.daily) {
    rows.push([
      'gateway_daily',
      point.day,
      '',
      '',
      '',
      point.requests,
      point.errors,
      point.inputTokens,
      point.outputTokens,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  }
  for (const row of model.gateway.providerRows) {
    rows.push([
      'gateway_provider',
      row.label,
      row.label,
      '',
      '',
      row.requests,
      row.errors,
      row.inputTokens,
      row.outputTokens,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      row.share,
    ]);
  }
  for (const provider of model.quota.providers) {
    for (const bucket of provider.buckets) {
      rows.push([
        'quota_bucket',
        `${provider.provider}/${bucket.id}`,
        provider.provider,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        bucket.remaining,
        bucket.total,
        bucket.unit,
        bucket.status,
        '',
      ]);
    }
  }
  for (const provider of model.providers) {
    rows.push([
      'provider',
      provider.id,
      provider.id,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      `${provider.on ? 'on' : 'off'}/${provider.up ? 'up' : 'down'}/${provider.auth}`,
      '',
    ]);
  }

  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  return `\uFEFF${csv}\n`;
}

/** JSON 汇总：保留 null 与单位，方便二次处理；不写任何密钥/明文。 */
export function reportJson(model: ReportModel): string {
  return JSON.stringify(
    {
      generatedAt: model.generatedAt,
      range: model.range,
      rangeLabel: model.rangeLabel,
      sources: model.sources,
      conclusions: model.conclusions,
      usage: {
        sessions: model.usage.sessions,
        prompts: model.usage.prompts,
        steps: model.usage.steps,
        activeDays: model.usage.activeDays,
        streak: model.usage.streak,
        cost: model.usage.cost,
        tokens: model.usage.tokens,
        tools: model.usage.tools,
        daily: model.usage.daily,
        dailyTokensAvailable: model.usage.dailyTokensAvailable,
        providers: model.usage.providerRows,
        models: model.usage.modelRows,
      },
      gateway: model.gateway,
      quota: model.quota,
      providers: model.providers,
      providerIssues: model.providerIssues,
    },
    null,
    2,
  );
}