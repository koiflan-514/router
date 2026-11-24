import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * 逐页无障碍扫描（WCAG 2.1 A/AA 规则集）。
 *
 * 失败口径：只把 axe 的 `serious` / `critical` 视为失败；`moderate` / `minor`
 * 仅记录，不阻塞（对齐 docs/09-testing.md §2.6「零 critical/serious」）。
 *
 * 已知缺陷基线：审计时发现、但按任务边界（不改 `src/**`）不能在本轮修复的
 * serious 违规登记在 `KNOWN` 里，扫描结果会先扣掉它们再判失败。命中基线时用
 * `console.warn` 打印 id / impact / target，避免"静默通过"；完整清单与修复建议见
 * `tests/a11y/README.md`。基线不是豁免：新出现的 serious/critical 一律失败。
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

interface PageTarget {
  path: string;
  name: string;
}

const PAGES: PageTarget[] = [
  { path: '/', name: '总览' },
  { path: '/providers', name: '服务' },
  { path: '/quota', name: '额度' },
  { path: '/accounts', name: '账号' },
  { path: '/logs', name: '日志' },
  { path: '/diagnostics', name: '诊断' },
  { path: '/usage', name: '用量' },
  { path: '/reports', name: '报表' },
  { path: '/gateway', name: '网关·调度快照' },
  { path: '/gateway/usage', name: '网关·用量' },
  { path: '/gateway/combos', name: '网关·降级链' },
  { path: '/gateway/keys', name: '网关·密钥' },
  { path: '/gateway/free', name: '网关·免费供应商' },
  { path: '/gateway/local-answers', name: '网关·本地应答' },
  { path: '/settings', name: '设置' },
];

/**
 * 已登记、待修复的 serious 违规（按页面）。
 *
 * 本轮 Fluent 重构后为校验配色/结构而清空：此前的 label-content-name-mismatch、
 * definition-list、aria-progressbar-name 已分别通过「sr-only 可见词」「dl/div 结构」
 * 「Progress aria-label」修复。新出现的 serious/critical 一律失败，不再有豁免。
 */
const KNOWN: Record<string, Array<{ id: string; why: string }>> = {};

function describeViolations(
  violations: Array<{ id: string; impact?: string | null; help: string; nodes: Array<{ target: ReadonlyArray<unknown> }> }>,
): string {
  return violations
    .map(
      (v) =>
        `${v.id} [${v.impact ?? 'none'}] ${v.help}\n` +
        v.nodes.map((n) => `  target=${n.target.map(String).join(' ')}`).join('\n'),
    )
    .join('\n');
}

for (const page of PAGES) {
  test(`axe：${page.name}（${page.path}）无严重违规`, async ({ page: pw }) => {
    await pw.goto(page.path);
    // 路由懒加载：先等页面级 h1 出现，再让异步数据/图表落位后扫描。
    await expect(pw.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(pw.locator('#main')).toBeVisible();
    await pw.waitForTimeout(400);

    const results = await new AxeBuilder({ page: pw }).withTags([...TAGS]).analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );

    const knownIds = new Set((KNOWN[page.path] ?? []).map((k) => k.id));
    const known = blocking.filter((v) => knownIds.has(v.id));
    const unexpected = blocking.filter((v) => !knownIds.has(v.id));

    // 已知缺陷也打印出来，保证报告与测试输出一致，不能"悄悄通过"。
    for (const v of known) {
      console.warn(
        `[a11y 已知缺陷] ${page.path} ${v.id} [${v.impact}] ${v.help}\n` +
          v.nodes.map((n) => `  target=${n.target.map(String).join(' ')}`).join('\n'),
      );
    }

    // 结构化输出：失败信息里带 id / impact / target，便于直接建单。
    expect(
      unexpected.map((v) => v.id),
      `发现未登记的 serious/critical 违规：\n${describeViolations(unexpected)}`,
    ).toEqual([]);
  });
}

test('axe：命令面板弹层无严重违规', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Control+KeyK');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('option').first()).toBeVisible();
  await page.waitForTimeout(200);

  const results = await new AxeBuilder({ page }).withTags([...TAGS]).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    blocking.map((v) => v.id),
    `命令面板发现 serious/critical 违规：\n${describeViolations(blocking)}`,
  ).toEqual([]);
});

/**
 * 浅色主题抽检：默认主题是深色，浅色 token 也要满足同一口径。
 * 用 localStorage 在应用挂载前切到浅色，避免测试中动画/重渲染干扰。
 */
const LIGHT_PAGES: PageTarget[] = [
  { path: '/', name: '总览' },
  { path: '/quota', name: '额度' },
  { path: '/usage', name: '用量' },
  { path: '/reports', name: '报表' },
  { path: '/gateway', name: '网关·调度快照' },
];

for (const page of LIGHT_PAGES) {
  test(`axe（浅色）：${page.name}（${page.path}）无严重违规`, async ({ page: pw }) => {
    await pw.addInitScript(() => {
      localStorage.setItem('router-panel-theme', 'light');
    });
    await pw.goto(page.path);
    await expect(pw.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(pw.locator('#main')).toBeVisible();
    await expect(pw.locator('html')).toHaveClass(/light/);
    await pw.waitForTimeout(400);

    const results = await new AxeBuilder({ page: pw }).withTags([...TAGS]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      blocking.map((v) => v.id),
      `浅色主题发现 serious/critical 违规：\n${describeViolations(blocking)}`,
    ).toEqual([]);
  });
}