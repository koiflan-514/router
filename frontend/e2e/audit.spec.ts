import { expect, test, type Page } from '@playwright/test';

/**
 * 深度冒烟：逐页收集 pageerror / console error，并覆盖几条关键交互。
 * 只跑 demo 桥接，不触发任何写操作。
 */

const ALL_PAGES = [
  '/',
  '/providers',
  '/quota',
  '/accounts',
  '/logs',
  '/diagnostics',
  '/usage',
  '/gateway',
  '/gateway/usage',
  '/gateway/combos',
  '/gateway/keys',
  '/gateway/free',
  '/gateway/local-answers',
  '/settings',
];

function watchErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 忽略资源类噪声（favicon / 图片），其余都算问题
    if (/favicon|Failed to load resource: the server responded with a status of 404/i.test(t)) return;
    errs.push(`console: ${t}`);
  });
  return errs;
}

for (const path of ALL_PAGES) {
  test(`无运行时错误：${path}`, async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto(path);
    // 等主内容区域出现（不是空壳）
    await expect(page.locator('#main')).toBeVisible();
    await page.waitForTimeout(250);
    expect(errs, `${path} 出现运行时错误`).toEqual([]);
  });
}

test('命令面板可搜索并跳转', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '总览', level: 1 })).toBeVisible();
  await page.keyboard.press('Control+KeyK');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const input = dialog.getByPlaceholder('搜索页面或操作…');
  await input.fill('额度');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/quota/);
});

test('用量时间范围切换写入 URL', async ({ page }) => {
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: '用量', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '24h' }).click();
  await expect(page).toHaveURL(/range=24h/);
});

test('设置页主题切换真实生效', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await page.getByText('浅色', { exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await page.getByText('深色', { exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});