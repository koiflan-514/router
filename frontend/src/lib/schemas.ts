import { z } from 'zod';
import { authStateSchema, quotaRowSchema } from './contract';

/** 桥接各端点的响应载荷 schema。宽松解析，容忍后端增量字段。 */

export const envSchema = z.looseObject({
  mode: z.enum(['real', 'demo']).default('real'),
  readOnly: z.boolean().default(false),
  root: z.string().default(''),
  nodeVersion: z.string().default(''),
  platform: z.string().default(''),
  panelVersion: z.string().default(''),
  gateway: z
    .looseObject({
      url: z.string().default(''),
      // 真实模式下桥接无法便宜地判定可达性时会返回 null（未知），不能当成 false。
      reachable: z.boolean().nullable().default(false),
    })
    .default({ url: '', reachable: false }),
});
export type PanelEnv = z.infer<typeof envSchema>;

export const providersResponseSchema = z.looseObject({
  providers: z.array(z.unknown()).default([]),
});

export const gatewayStatusEnvelope = z.looseObject({
  ok: z.boolean().default(true),
  version: z.string().default(''),
  pid: z.number().nullable().default(null),
  uptimeSec: z.number().default(0),
  strict: z.boolean().default(false),
  openMode: z.boolean().default(true),
  quotaSnapshotAt: z.number().nullable().optional(),
  providers: z
    .array(
      z.looseObject({
        id: z.string(),
        running: z.boolean().default(false),
        dialect: z.enum(['openai', 'anthropic', 'both']).nullable().default(null),
        port: z.number().nullable().default(null),
        weight: z.number().default(0),
        quotaRatio: z.number().nullable().default(null),
        inFlight: z.number().default(0),
        consecutiveFails: z.number().default(0),
        successRate: z.number().default(0),
        cooldownUntil: z.number().nullable().optional(),
        cooldownKind: z.string().nullable().optional(),
        sticky: z.number().optional(),
      }),
    )
    .default([]),
});

export const gatewayUsageSchema = z.looseObject({
  days: z.number().default(7),
  requests: z.number().default(0),
  errors: z.number().default(0),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  byDay: z.array(z.record(z.string(), z.unknown())).default([]),
  byProvider: z.array(z.record(z.string(), z.unknown())).default([]),
  byModel: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type GatewayUsage = z.infer<typeof gatewayUsageSchema>;

export const balanceSchema = z.looseObject({
  fetchedAt: z.string().nullable().default(null),
  providers: z.array(quotaRowSchema).default([]),
});
export type BalancePayload = z.infer<typeof balanceSchema>;

export const comboSchema = z.looseObject({
  name: z.string(),
  models: z.array(z.string()).default([]),
  strategy: z.string().default('fallback'),
  available: z.boolean().optional(),
});
export type Combo = z.infer<typeof comboSchema>;

export const freeProviderSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(''),
  category: z.string().default(''),
  local: z.boolean().default(false),
  hasKey: z.boolean().default(false),
  baseUrl: z.string().default(''),
  status: z.string().default(''),
  note: z.string().optional(),
});
export type FreeProvider = z.infer<typeof freeProviderSchema>;

export const localAnswersSchema = z.record(z.string(), z.boolean());
export type LocalAnswers = z.infer<typeof localAnswersSchema>;

export const healthProviderSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(''),
  url: z.string().default(''),
  reachable: z.boolean().default(false),
  httpStatus: z.number().default(0),
  models: z.number().nullable().default(null),
  auth: z
    .looseObject({
      state: authStateSchema.optional(),
      expiresAt: z.string().nullable().optional(),
    })
    .optional(),
  probe: z
    .looseObject({
      attempted: z.boolean().default(false),
      ok: z.boolean().default(false),
      model: z.string().default(''),
      durationMs: z.number().default(0),
      kind: z.string().default('unknown'),
      detail: z.string().default(''),
    })
    .nullable()
    .optional(),
  error: z.string().nullable().default(null),
});
export type HealthProvider = z.infer<typeof healthProviderSchema>;

export const healthSchema = z.looseObject({
  ok: z.boolean().default(false),
  issues: z.number().default(0),
  providers: z.array(healthProviderSchema).default([]),
  text: z.string().optional(),
  probeRequested: z.boolean().default(false),
});
export type HealthPayload = z.infer<typeof healthSchema>;

export const accountsPayloadSchema = z.looseObject({
  providers: z.array(z.unknown()).default([]),
});

export const accountCheckPayloadSchema = z.looseObject({
  providers: z.array(z.unknown()).default([]),
});
