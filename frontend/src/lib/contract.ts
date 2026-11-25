import { z } from 'zod';

/**
 * 领域契约（对齐 frontend/docs/00-design-baseline.md §6 与 05-backend-contract.md）。
 *
 * 这一层是前端与桥接之间唯一的缝：UI 只消费这些类型，不碰 CLI 的原生字段。
 * 所有 schema 默认忽略未知字段（Zod object 默认剥离），便于后端增量兼容。
 */

export const authStateSchema = z.enum(['valid', 'expiring', 'expired', 'missing', 'unknown']);
export type AuthState = z.infer<typeof authStateSchema>;

export const driftKindSchema = z.enum(['stopped', 'notSynced', 'stillRunning']);
export type DriftKind = z.infer<typeof driftKindSchema>;

export const authStatusSchema = z.object({
  ok: z.boolean(),
  state: authStateSchema,
  expiresAt: z.string().nullable(),
  label: z.string().default(''),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const providerStatusSchema = z.object({
  id: z.string(),
  title: z.string(),
  on: z.boolean(),
  up: z.boolean(),
  models: z.number().nullable(),
  port: z.number(),
  pid: z.number().nullable(),
  pids: z.array(z.number()).default([]),
  control: z.string().default(''),
  oc: z.boolean(),
  ocUserOwned: z.boolean().default(false),
  auth: authStatusSchema,
  drift: z.array(driftKindSchema).default([]),
  /** 叠加层（网关）没有独立开关：on 直接等于 up。 */
  overlay: z.boolean().default(false),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const accountSchema = z.object({
  key: z.string(),
  name: z.string(),
  uid: z.string().nullable().default(null),
  enabled: z.boolean(),
  active: z.boolean(),
  detail: z.string().default(''),
  health: z
    .object({
      level: z.enum(['ok', 'warn', 'error', 'unknown']).default('unknown'),
      notes: z.array(z.string()).default([]),
    })
    .default({ level: 'unknown', notes: [] }),
});
export type Account = z.infer<typeof accountSchema>;

export const accountGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string().default(''),
  switchable: z.boolean().default(false),
  accounts: z.array(accountSchema).default([]),
});
export type AccountGroup = z.infer<typeof accountGroupSchema>;

export const quotaBucketSchema = z.object({
  id: z.string(),
  label: z.string(),
  total: z.number().nullable().optional(),
  used: z.number().nullable().optional(),
  remaining: z.number().nullable(),
  unit: z.string(),
  resetDate: z.string().nullable().optional(),
  expiring: z.number().nullable().optional(),
});
export type QuotaBucket = z.infer<typeof quotaBucketSchema>;

export const checkinSchema = z.object({
  supported: z.boolean().default(false),
  claimable: z.boolean().optional(),
  claimed: z.boolean().optional(),
  rewardCredits: z.number().optional(),
  note: z.string().optional(),
});

export const quotaRowSchema = z.object({
  provider: z.string(),
  kind: z.string().default(''),
  title: z.string(),
  available: z.boolean().default(true),
  reason: z.string().optional(),
  detail: z.string().optional(),
  account: z.string().nullable().optional(),
  buckets: z.array(quotaBucketSchema).optional(),
  accounts: z.array(z.record(z.string(), z.unknown())).optional(),
  serviceRunning: z.boolean().optional(),
  checkin: checkinSchema.optional(),
  error: z.string().nullable().optional(),
  fetchedAt: z.string().nullable().optional(),
});
export type QuotaRow = z.infer<typeof quotaRowSchema>;

export const gatewayProviderSnapSchema = z.object({
  id: z.string(),
  running: z.boolean().default(false),
  dialect: z.enum(['openai', 'anthropic', 'both']).nullable().default(null),
  port: z.number().nullable().default(null),
  weight: z.number().default(0),
  quotaRatio: z.number().nullable().default(null),
  inFlight: z.number().default(0),
  consecutiveFails: z.number().default(0),
  successRate: z.number().default(0),
  lastUsedAt: z.number().nullable().default(null),
  cooldownUntil: z.number().nullable().optional(),
  cooldownKind: z.string().nullable().optional(),
  sticky: z.number().optional(),
});
export type GatewayProviderSnap = z.infer<typeof gatewayProviderSnapSchema>;

export const gatewayStatusSchema = z.object({
  ok: z.boolean().default(true),
  version: z.string().default(''),
  pid: z.number().nullable().default(null),
  uptimeSec: z.number().default(0),
  strict: z.boolean().default(false),
  openMode: z.boolean().default(true),
  quotaSnapshotAt: z.number().nullable().optional(),
  providers: z.array(gatewayProviderSnapSchema).default([]),
});
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;

export const usageRangeSchema = z.enum(['24h', '7d', '30d', 'all']);
export type UsageRange = z.infer<typeof usageRangeSchema>;

/** OpenCode 官方 experimental.session.stats 的 `data` 载荷（宽松解析）。 */
export const usageStatsSchema = z
  .looseObject({
    range: z.object({ from: z.number(), to: z.number() }).optional(),
    sessions: z.number().default(0),
    subagents: z.number().default(0),
    prompts: z.number().default(0),
    steps: z.number().default(0),
    tokens: z
      .object({
        input: z.number().default(0),
        output: z.number().default(0),
        reasoning: z.number().default(0),
        cache: z.object({ read: z.number().default(0), write: z.number().default(0) }).optional(),
      })
      .default({ input: 0, output: 0, reasoning: 0 }),
    cost: z.number().default(0),
    tools: z
      .object({
        totals: z
          .object({
            calls: z.number().default(0),
            succeeded: z.number().default(0),
            failed: z.number().default(0),
          })
          .optional(),
      })
      .optional(),
    activeDays: z.number().default(0),
    streak: z.number().default(0),
    activity: z.array(z.looseObject({ date: z.string().optional(), steps: z.number().optional() })).default([]),
    models: z
      .array(
        z.object({
          id: z.string(),
          providerID: z.string().default(''),
          steps: z.number().default(0),
          tokens: z.record(z.string(), z.number()).optional(),
          cost: z.number().default(0),
        }),
      )
      .default([]),
  });
export type UsageStats = z.infer<typeof usageStatsSchema>;

export const actionNameSchema = z.enum([
  'Start',
  'Stop',
  'StopKeepOpenCode',
  'Restart',
  'OnlyEnable',
  'Disable',
  'EnableAll',
  'DisableAll',
  'Sync',
  'SwitchAccountPreview',
  'SwitchAccount',
  'EnableAllAccounts',
  'Login',
  'AddAccount',
  'Probe',
  'RefreshModels',
  'RefreshQuota',
]);
export type ActionName = z.infer<typeof actionNameSchema>;

export const taskSchema = z.object({
  actionId: z.string(),
  action: actionNameSchema,
  providerIds: z.array(z.string()).default([]),
  accountKey: z.string().nullable().optional(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  truncated: z.boolean().default(false),
  refreshStatus: z.enum(['pending', 'confirmed', 'failed', 'notRequired']).default('pending'),
});
export type Task = z.infer<typeof taskSchema>;

/** 桥接统一响应包络。 */
export const envelopeSchema = z.object({
  schemaVersion: z.number().default(1),
  generatedAt: z.string(),
  ok: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      provider: z.string().optional(),
      retryable: z.boolean().default(false),
    })
    .nullable()
    .optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** 桥接响应的原始包络（`data` 为未知载荷，便于按端点各自解析）。 */
export interface EnvelopeLike {
  schemaVersion?: number;
  generatedAt?: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; provider?: string; retryable: boolean } | null;
}

/** 资源状态：给 React 组件用的统一"数据 + 新鲜度"视图。 */
export interface ResourceView<T> {
  data: T | null;
  lastSuccessAt: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  stale: boolean;
  loading: boolean;
}

export const actionCatalog: Record<
  ActionName,
  { label: string; risk: 'normal' | 'high'; needsProvider: boolean; needsAccount?: boolean; confirm: string }
> = {
  Start: { label: '启动', risk: 'normal', needsProvider: true, confirm: '启动该反代进程' },
  Stop: { label: '停止', risk: 'normal', needsProvider: true, confirm: '停止进程并同步移除客户端配置' },
  StopKeepOpenCode: { label: '停止（保留客户端）', risk: 'normal', needsProvider: true, confirm: '停止进程，保留 opencode provider' },
  Restart: { label: '重启', risk: 'normal', needsProvider: true, confirm: '停止并重新启动该反代' },
  OnlyEnable: { label: '仅启用此家', risk: 'high', needsProvider: true, confirm: '关闭其他已启用的 provider，只保留此家' },
  Disable: { label: '关闭', risk: 'normal', needsProvider: true, confirm: '关闭开关、停止进程并同步客户端' },
  EnableAll: { label: '全部启用', risk: 'high', needsProvider: true, confirm: '启用全部 provider 并启动' },
  DisableAll: { label: '全部关闭', risk: 'high', needsProvider: true, confirm: '关闭全部 provider 并停止进程' },
  Sync: { label: '同步客户端', risk: 'normal', needsProvider: false, confirm: '让 opencode/provider 与开关一致' },
  SwitchAccountPreview: { label: '预览切换', risk: 'normal', needsProvider: true, needsAccount: true, confirm: '只预览账号切换影响，不写配置' },
  SwitchAccount: { label: '切换账号', risk: 'normal', needsProvider: true, needsAccount: true, confirm: '切换账号并重启对应反代' },
  EnableAllAccounts: { label: '恢复整池', risk: 'high', needsProvider: true, confirm: '让该 provider 全部账号重新参与轮询' },
  Login: { label: '登录', risk: 'normal', needsProvider: true, confirm: '打开外部终端完成登录（面板只等待）' },
  AddAccount: { label: '添加账号', risk: 'normal', needsProvider: true, confirm: '打开外部终端完成浏览器登录（面板只等待）' },
  Probe: { label: '真实试打', risk: 'high', needsProvider: true, confirm: '会调用真实模型，可能消耗额度并等待较久' },
  RefreshModels: { label: '刷新模型列表', risk: 'normal', needsProvider: false, confirm: '清空网关模型缓存并重新拉取' },
  RefreshQuota: { label: '刷新额度', risk: 'normal', needsProvider: false, confirm: '采集额度快照（影响调度权重）' },
};
