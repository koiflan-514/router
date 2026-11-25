/**
 * 匿名演示数据（`--demo`）。
 *
 * 演示模式**绝不 spawn 进程、绝不读真实文件、绝不连真实网关**（04 §1、07 §8.3）。
 * 所有值均为虚构：example-*、slot-a、全零加序号 UUID、示例端口与虚构时间。
 */

import { toProviderStatus } from './normalize.mjs';

const NOW = () => new Date().toISOString();

const PROVIDER_RAW = [
  {
    id: 'qoder-cn',
    title: 'Qoder 国内版',
    port: 8789,
    on: true,
    up: true,
    models: 11,
    pid: 41234,
    pids: [41234],
    control: 'router',
    oc: true,
    ocUserOwned: false,
    auth: { ok: true, state: 'expiring', expiresAt: '2026-11-14T00:00:00.000Z', label: '凭证即将到期' },
  },
  {
    id: 'qoder',
    title: 'Qoder 国际版',
    port: 8790,
    on: true,
    up: false,
    models: null,
    pid: null,
    pids: [],
    control: 'router',
    oc: true,
    ocUserOwned: false,
    auth: { ok: true, state: 'valid', expiresAt: null, label: '已登录（example-user）' },
  },
  {
    id: 'trae-local',
    title: 'Trae',
    port: 8787,
    on: true,
    up: true,
    models: 7,
    pid: 41235,
    pids: [41235],
    control: 'router',
    oc: false,
    ocUserOwned: false,
    auth: { ok: true, state: 'valid', expiresAt: null, label: '已登录（example-user、example-user-b）' },
  },
  {
    id: 'codearts',
    title: 'CodeArts Agent',
    port: 10087,
    on: true,
    up: true,
    models: 9,
    pid: 41236,
    pids: [41236, 41237],
    control: 'router',
    oc: true,
    ocUserOwned: false,
    auth: { ok: true, state: 'valid', expiresAt: null, label: '已登录（example-user）' },
  },
  {
    id: 'zcode',
    title: 'ZCode',
    port: 20131,
    on: true,
    up: true,
    models: 5,
    pid: 41238,
    pids: [41238],
    control: 'tool',
    oc: true,
    ocUserOwned: false,
    auth: { ok: true, state: 'valid', expiresAt: null, label: '已登录（example-user）' },
  },
  {
    id: 'workbuddy',
    title: 'WorkBuddy 国内版',
    port: 7863,
    on: false,
    up: true,
    models: 6,
    pid: 41239,
    pids: [41239],
    control: 'router',
    oc: false,
    ocUserOwned: false,
    auth: { ok: true, state: 'valid', expiresAt: '2026-12-11T00:00:00.000Z', label: '已登录（example-user）' },
  },
  {
    id: 'workbuddy-global',
    title: 'WorkBuddy 国际版',
    port: 7864,
    on: true,
    up: true,
    models: 6,
    pid: 41240,
    pids: [41240],
    control: 'router',
    oc: true,
    ocUserOwned: false,
    auth: { ok: false, state: 'missing', expiresAt: null, label: '未登录（账号池为空）' },
  },
  {
    id: 'loomy',
    title: 'Loomy（讯飞）',
    port: 8791,
    on: true,
    up: true,
    models: 4,
    pid: 41241,
    pids: [41241],
    control: 'router',
    oc: true,
    ocUserOwned: true,
    auth: { ok: true, state: 'unknown', expiresAt: null, label: '已登录（会话型）' },
  },
  {
    id: 'raccoon',
    title: '商汤小浣熊',
    port: 8793,
    on: true,
    up: true,
    models: 9,
    pid: 41242,
    pids: [41242],
    control: 'router',
    oc: true,
    ocUserOwned: false,
    auth: { ok: true, state: 'valid', expiresAt: '2026-12-14T09:41:44.000Z', label: '已登录（个人版）' },
  },
  {
    id: 'gateway',
    title: '统一网关',
    port: 8785,
    on: true,
    up: true,
    models: 32,
    pid: 41200,
    pids: [41200],
    control: 'router',
    oc: true,
    ocUserOwned: false,
    auth: { ok: true, state: 'valid', expiresAt: null, label: '聚合 8 家反代' },
  },
];

const ACCOUNT_GROUPS = [
  {
    id: 'workbuddy',
    title: 'WorkBuddy 国内版',
    kind: 'workbuddy',
    switchable: true,
    accounts: [
      {
        key: 'slot-a',
        name: 'example-user',
        uid: null,
        enabled: true,
        active: true,
        detail: '凭证剩 29 天',
        health: { level: 'ok', notes: [] },
      },
      {
        key: 'slot-b',
        name: 'example-user-b',
        uid: null,
        enabled: true,
        active: false,
        detail: '凭证剩 12 天',
        health: { level: 'warn', notes: ['凭证即将到期，建议重新登录'] },
      },
    ],
  },
  {
    id: 'codearts',
    title: 'CodeArts Agent',
    kind: 'codearts',
    switchable: true,
    accounts: [
      {
        key: 'acct-1',
        name: 'example-user',
        uid: null,
        enabled: true,
        active: true,
        detail: '桌面端登录',
        health: { level: 'ok', notes: [] },
      },
      {
        key: 'acct-2',
        name: 'example-user-b',
        uid: null,
        enabled: true,
        active: false,
        detail: '上游返回失效',
        health: { level: 'error', notes: ['需要重新登录授权'] },
      },
    ],
  },
  {
    id: 'trae-local',
    title: 'Trae',
    kind: 'trae',
    switchable: true,
    accounts: [
      {
        key: 'trae-01',
        name: 'example-user',
        uid: null,
        enabled: true,
        active: true,
        detail: '积分 0（冷却中）',
        health: { level: 'warn', notes: ['账号积分已用尽，处于冷却'] },
      },
    ],
  },
  {
    id: 'zcode',
    title: 'ZCode',
    kind: 'zcode',
    switchable: true,
    accounts: [
      {
        key: 'z-1',
        name: 'example-user',
        uid: null,
        enabled: true,
        active: true,
        detail: '可用',
        health: { level: 'ok', notes: [] },
      },
    ],
  },
  {
    id: 'qoder-cn',
    title: 'Qoder 国内版',
    kind: 'qoder',
    switchable: false,
    accounts: [
      {
        key: 'qoder-cn',
        name: 'example-user',
        uid: null,
        enabled: true,
        active: true,
        detail: '凭证剩 29 天',
        health: { level: 'unknown', notes: [] },
      },
    ],
  },
  { id: 'loomy', title: 'Loomy（讯飞）', kind: 'loomy', switchable: false, accounts: [] },
  {
    id: 'raccoon',
    title: '商汤小浣熊',
    kind: 'raccoon',
    switchable: false,
    accounts: [
      {
        key: 'raccoon-personal',
        name: '个人版',
        uid: null,
        enabled: true,
        active: true,
        detail: '登录于 2026/11/14',
        health: { level: 'ok', notes: [] },
      },
    ],
  },
];

const QUOTA_ROWS = [
  {
    provider: 'qoder-cn',
    kind: 'qoder',
    title: 'Qoder 国内版',
    available: true,
    account: 'example-user',
    buckets: [
      { id: 'addon', label: '加购额度', total: 800, used: 704, remaining: 96, unit: 'credits' },
      { id: 'plan', label: '套餐额度', total: 500, used: 120, remaining: 380, unit: 'credits' },
    ],
    checkin: { supported: false, claimable: false, claimed: false, rewardCredits: 0, note: '活动未开放' },
    error: null,
    fetchedAt: '2026-11-12T03:00:00.000Z',
  },
  {
    provider: 'workbuddy',
    kind: 'workbuddy',
    title: 'WorkBuddy 国内版',
    available: true,
    account: 'example-user',
    buckets: [
      { id: 'credits', label: '积分', total: 2000, used: 1500, remaining: 500, unit: 'credits' },
      { id: 'credential', label: '凭证有效期', remaining: 29, unit: 'days' },
    ],
    checkin: { supported: false, claimed: false, rewardCredits: 0 },
    error: null,
    fetchedAt: '2026-11-12T03:00:00.000Z',
  },
  {
    provider: 'raccoon',
    kind: 'raccoon',
    title: '商汤小浣熊',
    available: true,
    account: '个人版',
    buckets: [{ id: 'points', label: '可用积分', remaining: 9291, unit: 'credits' }],
    detail: ['每日 291 · 赠送 9000', '9 个模型有倍率'],
    error: null,
    fetchedAt: '2026-11-12T03:00:00.000Z',
  },
  {
    provider: 'codearts',
    kind: 'codearts',
    title: 'CodeArts Agent',
    available: false,
    reason: '上游返回失效',
    accounts: [],
    buckets: [],
    error: '需要重新登录授权',
    fetchedAt: '2026-11-12T03:00:00.000Z',
  },
];

const LOG_SAMPLE = {
  'trae-local': [
    '2026-11-12 03:00:00 INFO  trae2api ready on 127.0.0.1:8787',
    '2026-11-12 03:00:01 INFO  model list refreshed: 7',
    '2026-11-12 03:00:05 WARN  account trae-01 credits exhausted, cooling down',
    '2026-11-12 03:00:06 INFO  switched to next account in pool',
    '2026-11-12 03:00:09 INFO  request ok model=glm-5.3-flash durationMs=1840',
  ],
  'qoder-cn': [
    '2026-11-12 03:00:00 INFO  qodbuddy2pi listening :8789',
    '2026-11-12 03:00:02 WARN  credential expires in 2 days',
  ],
  gateway: [
    '2026-11-12 03:00:00 INFO  router-gateway listening 127.0.0.1:8785 (open mode)',
    '2026-11-12 03:00:04 INFO  route trae-local/glm-5.3-flash ok attempts=1',
  ],
};

const DOCTOR_TEXT = [
  'router 自检',
  '────────────────────────────────────────────',
  '  ✓ node v22.19.0',
  '  ✓ 状态文件是合法 JSON',
  '  ✗ 端口 7863 未监听（WorkBuddy 国内版）',
  '  ✗ opencode 配置缺 1 家',
  '────────────────────────────────────────────',
  '  2 项需要处理',
].join('\n');

const HEALTH_TEXT = [
  'AI 路由体检',
  '──────────────────────────────────────────────',
  '✓ Qoder 国内版         http://127.0.0.1:8789/v1  11 个模型',
  '✓ Trae                 http://127.0.0.1:8787/v1  7 个模型',
  '✗ WorkBuddy 国内版      http://127.0.0.1:7863/v1  不可达 (ECONNREFUSED)',
  '──────────────────────────────────────────────',
  '! 1 项需要处理',
].join('\n');

/** 匿名网关密钥：1 个停用、1 个带 token 配额（绝不含 hash / 明文）。 */
const DEMO_KEYS = [
  {
    id: 'key_example01',
    name: 'dev',
    prefix: 'zsk_example1',
    enabled: true,
    disabled: false,
    providers: ['trae-local'],
    models: [],
    ips: [],
    tokenQuota: 0,
    quota: 0,
    usedTokens: 12345,
    createdAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    note: '',
  },
  {
    id: 'key_example02',
    name: '旧密钥（示例）',
    prefix: 'zsk_example2',
    enabled: false,
    disabled: true,
    providers: [],
    models: ['glm-*'],
    ips: ['127.0.0.1/32'],
    tokenQuota: 0,
    quota: 0,
    usedTokens: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    note: '已停用',
  },
  {
    id: 'key_example03',
    name: 'ci',
    prefix: 'zsk_example3',
    enabled: true,
    disabled: false,
    providers: ['qoder-cn', 'zcode'],
    models: [],
    ips: [],
    tokenQuota: 2000000,
    quota: 2000000,
    usedTokens: 640000,
    createdAt: '2026-11-05T00:00:00.000Z',
    expiresAt: null,
    note: '自动化用',
  },
];

/** 匿名结构化体检：1 家不可达（WorkBuddy 国内版）。 */
const DEMO_HEALTH_PROVIDERS = [
  {
    id: 'qoder-cn',
    title: 'Qoder 国内版',
    url: 'http://127.0.0.1:8789/v1',
    reachable: true,
    httpStatus: 200,
    models: 11,
    auth: { state: 'expiring', expiresAt: '2026-11-14T00:00:00.000Z' },
    probe: null,
    error: null,
  },
  {
    id: 'trae-local',
    title: 'Trae',
    url: 'http://127.0.0.1:8787/v1',
    reachable: true,
    httpStatus: 200,
    models: 7,
    auth: { state: 'valid', expiresAt: null },
    probe: null,
    error: null,
  },
  {
    id: 'codearts',
    title: 'CodeArts Agent',
    url: 'http://127.0.0.1:10087/v1',
    reachable: true,
    httpStatus: 401,
    models: null,
    auth: { state: 'valid', expiresAt: null },
    probe: null,
    error: null,
  },
  {
    id: 'workbuddy',
    title: 'WorkBuddy 国内版',
    url: 'http://127.0.0.1:7863/v1',
    reachable: false,
    httpStatus: 0,
    models: null,
    auth: { state: 'missing', expiresAt: null },
    probe: null,
    error: 'connect failed',
  },
];

const GATEWAY_STATUS = {
  ok: true,
  version: '1.0.0',
  pid: 41200,
  uptimeSec: 3600,
  strict: false,
  openMode: true,
  quotaSnapshotAt: 1762912800000,
  settings: { maxAttempts: 3, topN: 3, maxInFlight: 4 },
  providers: [
    { id: 'trae-local', running: true, dialect: 'openai', port: 8787, weight: 12.5, quotaRatio: 0.62, inFlight: 1, consecutiveFails: 0, successRate: 0.984, lastUsedAt: 1762912000000, cooldownUntil: 0, cooldownKind: 0, stickySessions: 2 },
    { id: 'qoder-cn', running: true, dialect: 'both', port: 8789, weight: 9.1, quotaRatio: 0.66, inFlight: 0, consecutiveFails: 0, successRate: 0.997, lastUsedAt: 1762912000000, cooldownUntil: 0, cooldownKind: 0, stickySessions: 0 },
    { id: 'workbuddy', running: false, dialect: null, port: null, weight: 0, quotaRatio: null, inFlight: 0, consecutiveFails: 4, successRate: 0.5, lastUsedAt: 1762911500000, cooldownUntil: 1762913100000, cooldownKind: 'upstream_5xx', stickySessions: 0 },
    { id: 'zcode', running: true, dialect: 'openai', port: 8791, weight: 7.5, quotaRatio: null, inFlight: 0, consecutiveFails: 0, successRate: 0, lastUsedAt: 0, cooldownUntil: 0, cooldownKind: 0, stickySessions: 0 },
  ],
};

const GATEWAY_USAGE = {
  days: [
    { day: '2026-11-11', requests: 128, errors: 3, inputTokens: 411200, outputTokens: 98200, avgDurationMs: 1840, providers: { 'trae-local': { requests: 80, errors: 1, inputTokens: 250000, outputTokens: 60000 }, 'qoder-cn': { requests: 48, errors: 2, inputTokens: 161200, outputTokens: 38200 } } },
    { day: '2026-11-12', requests: 64, errors: 0, inputTokens: 201000, outputTokens: 51000, avgDurationMs: 1610, providers: { 'trae-local': { requests: 40, errors: 0, inputTokens: 120000, outputTokens: 30000 }, 'qoder-cn': { requests: 24, errors: 0, inputTokens: 81000, outputTokens: 21000 } } },
  ],
  totals: { requests: 192, errors: 3, inputTokens: 612200, outputTokens: 149200, avgDurationMs: 1763 },
};

const COMBOS = [
  { name: 'fast', models: ['trae-local/glm-5.3-flash', 'zcode/glm-5.3'], strategy: 'fallback', id: 'combo:fast', context_length: 200000, supportsVision: false, supportsTools: true },
  { name: 'smart', models: ['qoder-cn/qwen3.8-max', 'codearts/gpt-5.1-codex'], strategy: 'round-robin', id: 'combo:smart', context_length: null, supportsVision: true, supportsTools: true },
];

const FREE_PROVIDERS = [
  { id: 'opencode-zen', title: 'OpenCode Zen', category: 'local', local: true, hasKey: true, baseUrl: 'http://127.0.0.1:7865/v1', status: 'ok', note: '本机免账号', format: 'openai', env: '', keySource: 'none', ok: true, reason: null, free: '本机免账号', freeModels: [] },
  { id: 'openrouter', title: 'OpenRouter', category: 'openai', local: false, hasKey: true, baseUrl: 'https://openrouter.ai/api/v1', status: 'ok', note: '部分模型免费', format: 'openai', env: 'OPENROUTER_API_KEY', keySource: 'file', ok: true, reason: null, free: '部分模型免费', freeModels: ['example/free-model'] },
  { id: 'groq', title: 'Groq', category: 'openai', local: false, hasKey: false, baseUrl: 'https://api.groq.com/openai/v1', status: 'needs-key', note: '需配置 key', format: 'openai', env: 'GROQ_API_KEY', keySource: 'none', ok: false, reason: '未配置 key', free: '有免费额度', freeModels: [] },
];

const USAGE_STATS = {
  sessions: 42,
  subagents: 7,
  prompts: 318,
  steps: 1940,
  tokens: { input: 812000, output: 204000, reasoning: 51000, cache: { read: 120000, write: 30000 } },
  cost: 12.34,
  tools: { totals: { calls: 512, succeeded: 498, failed: 14 } },
  activeDays: 9,
  streak: 3,
  activity: [
    { date: '2026-11-11', steps: 210 },
    { date: '2026-11-12', steps: 96 },
  ],
  models: [
    { id: 'glm-5.3-flash', providerID: 'trae-local', steps: 640, tokens: { input: 210000, output: 60000 }, cost: 3.2 },
    { id: 'qwen3.8-max', providerID: 'qoder-cn', steps: 410, tokens: { input: 160000, output: 42000 }, cost: 4.1 },
  ],
};

/** 人类可读的体检说明（结构化字段仍是唯一事实来源）。 */
function healthText(rows, issues) {
  const lines = ['AI 路由体检（结构化）', '─'.repeat(62)];
  for (const row of rows) {
    const mark = row.reachable && !row.error ? '✓' : '✗';
    const detail = row.reachable
      ? typeof row.models === 'number'
        ? `${row.models} 个模型`
        : '模型数未知'
      : `不可达 (${row.error ?? 'connect failed'})`;
    lines.push(`${mark} ${row.title}  ${row.url}  ${detail}`);
    if (row.probe?.attempted) {
      lines.push(`   试打 ${row.probe.model || '(无模型)'} → ${row.probe.ok ? '成功' : row.probe.kind} ${row.probe.durationMs}ms`);
    }
  }
  lines.push('─'.repeat(62), issues === 0 ? '全部通过' : `${issues} 项需要处理`);
  return lines.join('\n');
}

/** 匿名演示后端。所有方法都是纯内存，绝不触达真实世界。 */
export function createDemo() {
  const providers = PROVIDER_RAW.map(toProviderStatus);
  const pick = (provider) => (provider ? ACCOUNT_GROUPS.filter((g) => g.id === provider) : ACCOUNT_GROUPS);
  const issueGroups = ACCOUNT_GROUPS.map((g) => ({
    ...g,
    accounts: g.accounts.filter((a) => a.health.level === 'error' || a.health.level === 'warn'),
  })).filter((g) => g.accounts.length);

  return {
    providers: () => providers,
    accounts: (provider) => pick(provider),
    accountCheck: () => issueGroups,
    quota: (provider) => ({
      fetchedAt: NOW(),
      source: 'gateway-balance',
      stale: false,
      providers: provider ? QUOTA_ROWS.filter((r) => r.provider === provider) : QUOTA_ROWS,
    }),
    balance: () => ({ fetchedAt: NOW(), providers: QUOTA_ROWS }),
    logs: (provider, lines) => {
      const src = LOG_SAMPLE[provider] ?? LOG_SAMPLE['trae-local'];
      const sliced = src.slice(-Math.max(1, lines));
      return { text: sliced.join('\n'), lines: sliced.length, truncated: src.length > sliced.length };
    },
    logLine: (provider) => {
      const src = LOG_SAMPLE[provider] ?? LOG_SAMPLE['trae-local'];
      return src[Math.floor(Math.random() * src.length)];
    },
    doctor: () => ({ text: DOCTOR_TEXT, exitCode: 1 }),
    gatewayKeys: () => DEMO_KEYS.map((k) => ({ ...k, providers: [...k.providers], models: [...k.models], ips: [...k.ips] })),
    healthCheck: (provider, probe) => {
      const rows = (provider ? DEMO_HEALTH_PROVIDERS.filter((p) => p.id === provider) : DEMO_HEALTH_PROVIDERS).map((row) => {
        if (!probe || !row.reachable) return { ...row, probe: null };
        const model = row.id === 'trae-local' ? 'glm-5.3-flash' : row.id === 'qoder-cn' ? 'qwen3.8-max' : '(需鉴权，未试打)';
        return {
          ...row,
          probe:
            row.httpStatus === 401
              ? null
              : { attempted: true, ok: true, model, durationMs: 820, kind: 'success', detail: '' },
        };
      });
      const issues = rows.filter((r) => !r.reachable || r.httpStatus >= 400 && r.httpStatus !== 401 && r.httpStatus !== 403 || (r.probe && !r.probe.ok)).length;
      return {
        structured: true,
        exitCode: issues ? 1 : 0,
        issues,
        ok: issues === 0,
        truncated: false,
        providers: rows,
        text: healthText(rows, issues),
        probeRequested: Boolean(probe),
      };
    },
    usage: (range, from, to) => ({ ...USAGE_STATS, range: { from, to }, queryRange: range }),
    gatewayStatus: () => GATEWAY_STATUS,
    gatewayUsage: () => GATEWAY_USAGE,
    gatewayCombos: () => COMBOS,
    gatewayFree: () => FREE_PROVIDERS,
    gatewayLocalAnswers: () => ({ quota: true, prefix: true, title: false, suggestion: false, filepath: false }),
    env: () => ({
      mode: 'demo',
      readOnly: false,
      root: '',
      nodeVersion: `v${process.versions.node}`,
      platform: process.platform,
      panelVersion: '1.0.0',
      gateway: { url: 'http://127.0.0.1:8785', reachable: false },
    }),
  };
}
