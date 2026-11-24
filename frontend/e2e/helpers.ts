import type { Page, Route } from '@playwright/test';

/** 桥接 envelope 的统一构造，保持 `{schemaVersion,generatedAt,ok,data}` 形状。 */
export function envelope(data: unknown, ok = true, error?: { code: string; message: string; retryable?: boolean }) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok,
    ...(ok ? { data } : { error: { ...error, retryable: error?.retryable ?? false } }),
  };
}

export async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** OpenCode 用量：成功但完全为空（sessions/models/activity 都为 0）。 */
export const emptyUsage = {
  range: { from: 1762308000000, to: 1762912800000 },
  sessions: 0,
  subagents: 0,
  prompts: 0,
  steps: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  activeDays: 0,
  streak: 0,
  activity: [],
  models: [],
};

export const emptyQuota = {
  fetchedAt: null,
  providers: [],
  source: 'gateway-balance',
};

export const emptyGatewayUsage = {
  days: 7,
  requests: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  byDay: [],
  byProvider: [],
  byModel: [],
};

export const emptyGatewayStatus = {
  ok: true,
  version: '1.0.0',
  pid: null,
  uptimeSec: 0,
  strict: false,
  openMode: true,
  quotaSnapshotAt: null,
  providers: [],
};

/**
 * 等待页面外壳 + 标题落位，并让懒加载的图表/异步查询有机会填充。
 * 不用固定的长等待，只在断言确实需要时才加短延时。
 */
export async function gotoPage(page: Page, path: string, heading: RegExp | string) {
  await page.goto(path);
  await page.getByRole('heading', { level: 1, name: heading }).waitFor();
  await page.locator('#main').waitFor();
}