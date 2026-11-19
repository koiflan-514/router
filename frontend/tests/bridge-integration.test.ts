import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  accountGroupSchema,
  providerStatusSchema,
  quotaRowSchema,
  usageStatsSchema,
  type EnvelopeLike,
} from '@/lib/contract';
import {
  balanceSchema,
  comboSchema,
  envSchema,
  freeProviderSchema,
  gatewayStatusEnvelope,
  gatewayUsageSchema,
  healthSchema,
  localAnswersSchema,
} from '@/lib/schemas';

/**
 * 桥接契约集成测试：拉起 `server/index.mjs --demo`，用**真实的 zod schema** 校验每个端点。
 * 目的：把"内核 schema 与桥接实现漂移"这类问题挡在合并前。
 *
 * 演示模式不 spawn 真实进程、不读真实文件，回环免 token。
 */

const PORT = Number(process.env.PANEL_TEST_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess | null = null;
let ready = false;

function killTree(proc: ChildProcess | null) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
}

async function waitForReady(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await delay(300);
  }
  return false;
}

async function getJson(path: string): Promise<EnvelopeLike> {
  const res = await fetch(`${BASE}${path}`);
  expect(res.status, `${path} HTTP 状态`).toBeLessThan(500);
  const body = (await res.json()) as EnvelopeLike;
  expect(body.ok, `${path} 应返回 ok:true`).toBe(true);
  return body;
}

const quotaPayload = z.looseObject({
  fetchedAt: z.string().nullable().default(null),
  providers: z.array(quotaRowSchema).default([]),
});

/**
 * `GET /api/gateway/keys` 的单条密钥。
 * `src/lib/schemas.ts` 目前没有密钥 schema（KeysPage 自带一份），这里按 05 §3.18
 * 的公开字段建同构 schema；`hash` 永远不应出现。
 */
const gatewayKeySchema = z.looseObject({
  id: z.string(),
  name: z.string().default(''),
  prefix: z.string().default(''),
  enabled: z.boolean().default(true),
  disabled: z.boolean().default(false),
  providers: z.array(z.string()).default([]),
  models: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([]),
  tokenQuota: z.number(),
  quota: z.number(),
  usedTokens: z.number(),
  createdAt: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  note: z.string().default(''),
});

beforeAll(async () => {
  child = spawn(process.execPath, ['server/index.mjs', '--demo', '--port', String(PORT)], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  ready = await waitForReady();
}, 30_000);

afterAll(() => {
  killTree(child);
});

describe('桥接契约（demo 模式）', () => {
  it('启动成功', () => {
    expect(ready, '桥接应在 20s 内就绪').toBe(true);
  });

  const cases: Array<[string, z.ZodType<unknown>]> = [
    ['/api/env', envSchema],
    ['/api/providers', z.array(providerStatusSchema)],
    ['/api/accounts', z.array(accountGroupSchema)],
    ['/api/accounts/check', z.array(accountGroupSchema)],
    ['/api/quota', quotaPayload],
    ['/api/usage?range=7d', usageStatsSchema],
    ['/api/gateway/status', gatewayStatusEnvelope],
    ['/api/gateway/usage?days=7', gatewayUsageSchema],
    ['/api/gateway/balance', balanceSchema],
    ['/api/gateway/combos', z.array(comboSchema)],
    ['/api/gateway/free', z.array(freeProviderSchema)],
    ['/api/gateway/local-answers', localAnswersSchema],
    ['/api/health-check', healthSchema],
  ];

  for (const [path, schema] of cases) {
    it(`${path} 符合契约`, async () => {
      if (!ready) return; // 启动失败时上面的用例已报错
      const body = await getJson(path);
      const parsed = schema.safeParse(body.data);
      if (!parsed.success) {
        throw new Error(`${path} 不符合 schema：${JSON.stringify(parsed.error.issues.slice(0, 4))}`);
      }
      expect(parsed.success).toBe(true);
    });
  }

  it('/api/gateway/keys 返回公开字段数组且绝不包含 hash', async () => {
    if (!ready) return;
    const body = await getJson('/api/gateway/keys');
    const payloadSchema = z.looseObject({
      supported: z.boolean().default(true),
      keys: z.array(gatewayKeySchema).default([]),
    });
    const parsed = payloadSchema.safeParse(body.data);
    if (!parsed.success) {
      throw new Error(`/api/gateway/keys 不符合 schema：${JSON.stringify(parsed.error.issues.slice(0, 4))}`);
    }
    const keys = parsed.data.keys as unknown as Array<Record<string, unknown>>;
    expect(parsed.data.supported).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
    // 演示模式要求：1 个停用 + 1 个有配额。
    expect(keys.some((k) => k.disabled === true)).toBe(true);
    expect(keys.some((k) => typeof k.tokenQuota === 'number' && k.tokenQuota > 0)).toBe(true);
    for (const key of keys) {
      expect('hash' in key, '密钥行不得包含 hash').toBe(false);
      expect(key.enabled).toBe(key.disabled !== true);
      expect(key.quota).toBe(key.tokenQuota);
    }
  });

  it('/api/health-check 返回结构化 providers', async () => {
    if (!ready) return;
    const body = await getJson('/api/health-check');
    const data = body.data as { structured?: boolean; providers?: Array<Record<string, unknown>>; issues?: unknown };
    expect(data.structured, 'structured 应为 true').toBe(true);
    expect(Array.isArray(data.providers), 'providers 应为数组').toBe(true);
    expect(typeof data.issues, 'issues 应为数字').toBe('number');
    const parsed = healthSchema.safeParse(body.data);
    if (!parsed.success) {
      throw new Error(`/api/health-check 不符合 schema：${JSON.stringify(parsed.error.issues.slice(0, 4))}`);
    }
    const providers = data.providers ?? [];
    expect(providers.length).toBeGreaterThan(0);
    // 演示 fixture 至少包含 1 家不可达。
    expect(providers.some((p) => p.reachable === false)).toBe(true);
  });

  it('/api/doctor 与 /api/logs 返回文本', async () => {
    if (!ready) return;
    for (const path of ['/api/doctor', '/api/logs?provider=trae-local&lines=10']) {
      const res = await fetch(`${BASE}${path}`);
      expect(res.status, path).toBe(200);
      expect((res.headers.get('content-type') ?? '').includes('text/plain')).toBe(true);
    }
  });
});
