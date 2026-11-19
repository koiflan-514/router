import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  accountGroupSchema,
  gatewayStatusSchema,
  providerStatusSchema,
  quotaRowSchema,
  usageStatsSchema,
} from '../src/lib/contract';
import { healthSchema } from '../src/lib/schemas';

import accounts from '../fixtures/accounts.json';
import gatewayStatus from '../fixtures/gateway-status.json';
import health from '../fixtures/health.json';
import providers from '../fixtures/providers.json';
import quota from '../fixtures/quota.json';
import usage from '../fixtures/usage.json';

/** 所有 `/api/*` fixture 都使用统一 envelope：{schemaVersion, generatedAt, ok, data}。 */
const envelopeOf = <T extends z.ZodType>(data: T) =>
  z.object({
    schemaVersion: z.number(),
    generatedAt: z.string(),
    ok: z.boolean(),
    data,
  });

const allFixtures = { providers, accounts, quota, gatewayStatus, usage, health };

describe('fixtures：统一 envelope 形状', () => {
  for (const [name, value] of Object.entries(allFixtures)) {
    it(`${name} 是 ok:true 的匿名 envelope，日期固定`, () => {
      expect((value as { ok: unknown }).ok).toBe(true);
      expect((value as { schemaVersion: unknown }).schemaVersion).toBe(1);
      expect((value as { generatedAt: string }).generatedAt).toBe('2026-11-12T03:00:00.000Z');
    });
  }
});

describe('fixtures：契约解析', () => {
  it('providers.json = 9 家 + gateway', () => {
    const parsed = envelopeOf(z.array(providerStatusSchema)).parse(providers);
    const ids = parsed.data.map((p) => p.id);
    expect(parsed.data).toHaveLength(10);
    expect(ids).toEqual(
      expect.arrayContaining([
        'qoder-cn',
        'qoder',
        'trae-local',
        'codearts',
        'zcode',
        'workbuddy',
        'workbuddy-global',
        'loomy',
        'raccoon',
        'gateway',
      ]),
    );
  });

  it('providers.json 覆盖三种 drift', () => {
    const parsed = envelopeOf(z.array(providerStatusSchema)).parse(providers);
    const drifts = new Set(parsed.data.flatMap((p) => p.drift));
    expect(drifts.has('stopped')).toBe(true);
    expect(drifts.has('notSynced')).toBe(true);
    expect(drifts.has('stillRunning')).toBe(true);
  });

  it('providers.json 中 ocUserOwned 的网关 on==up', () => {
    const parsed = envelopeOf(z.array(providerStatusSchema)).parse(providers);
    const gw = parsed.data.find((p) => p.id === 'gateway');
    expect(gw?.overlay).toBe(true);
    expect(gw?.on).toBe(gw?.up);
    // 每条都带 auth 与 on/up/oc/ocUserOwned。
    for (const p of parsed.data) {
      expect(typeof p.on).toBe('boolean');
      expect(typeof p.up).toBe('boolean');
      expect(typeof p.oc).toBe('boolean');
      expect(typeof p.ocUserOwned).toBe('boolean');
      expect(typeof p.auth.state).toBe('string');
    }
  });

  it('accounts.json 含多账号、空账号池与不可切换组', () => {
    const parsed = envelopeOf(z.array(accountGroupSchema)).parse(accounts);
    const multi = parsed.data.find((g) => g.accounts.length >= 3);
    expect(multi?.accounts.some((a) => a.active)).toBe(true);
    expect(multi?.accounts.some((a) => !a.enabled)).toBe(true);
    expect(parsed.data.some((g) => g.accounts.length === 0)).toBe(true);
    expect(parsed.data.some((g) => g.switchable === false)).toBe(true);
  });

  it('quota.json 含 credits 与 days 两类桶', () => {
    const parsed = envelopeOf(
      z.object({ fetchedAt: z.string().nullable().default(null), providers: z.array(quotaRowSchema) }),
    ).parse(quota);
    const units = new Set(parsed.data.providers.flatMap((r) => (r.buckets ?? []).map((b) => b.unit)));
    expect(units.has('credits')).toBe(true);
    expect(units.has('days')).toBe(true);
    expect(parsed.data.providers.some((r) => r.available === false)).toBe(true);
  });

  it('gateway-status.json 含冷却中的 provider', () => {
    const parsed = envelopeOf(gatewayStatusSchema).parse(gatewayStatus);
    expect(parsed.data.providers.length).toBeGreaterThan(0);
    expect(parsed.data.providers.some((p) => typeof p.cooldownUntil === 'number')).toBe(true);
  });

  it('usage.json 解析为 UsageStats', () => {
    const parsed = envelopeOf(usageStatsSchema).parse(usage);
    expect(parsed.data.steps).toBeGreaterThan(0);
    expect(parsed.data.models.length).toBeGreaterThan(0);
  });

  it('health.json 解析为健康载荷并含不可达项', () => {
    const parsed = envelopeOf(healthSchema).parse(health);
    expect(parsed.data.providers.some((p) => p.reachable === false)).toBe(true);
  });
});

describe('fixtures：匿名与安全（NFR-108/109）', () => {
  const blob = JSON.stringify(allFixtures);

  it('不包含绝对路径 / home 目录', () => {
    expect(blob).not.toMatch(/[A-Za-z]:\\/);
    expect(blob).not.toContain('/Users/');
    expect(blob).not.toContain('/home/');
  });

  it('不包含邮箱、Bearer 或密钥形态', () => {
    expect(blob).not.toMatch(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(blob).not.toMatch(/\bBearer\b/);
    expect(blob).not.toMatch(/\b(sk|zsk|pt|pk)-[A-Za-z0-9._-]{8,}/);
    expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });

  it('仅使用 example-* 系虚构用户名', () => {
    const parsed = envelopeOf(z.array(accountGroupSchema)).parse(accounts);
    for (const g of parsed.data) {
      for (const a of g.accounts) {
        expect(a.name.startsWith('example-user')).toBe(true);
      }
    }
  });
});
