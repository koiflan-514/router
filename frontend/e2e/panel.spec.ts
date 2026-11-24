import { expect, test } from '@playwright/test';

/** 九个页面都要能加载并渲染出标题（演示数据）。 */
const PAGES: Array<[string, string]> = [
  ['/', '总览'],
  ['/providers', '服务'],
  ['/quota', '额度'],
  ['/accounts', '账号'],
  ['/logs', '日志'],
  ['/diagnostics', '诊断'],
  ['/usage', '用量'],
  ['/reports', '报表'],
  ['/gateway', '调度快照'],
  ['/gateway/usage', '网关用量'],
  ['/settings', '设置'],
];

test.describe('网页面板（demo）', () => {
  for (const [to, heading] of PAGES) {
    test(`${to} 渲染「${heading}」`, async ({ page }) => {
      await page.goto(to);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      // 顶栏与导航常驻
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    });
  }

  test('总览显示 provider 与演示标记', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('trae-local').first()).toBeVisible();
    await expect(page.getByText('演示', { exact: true }).first()).toBeVisible();
  });

  test('命令面板可用键盘打开', async ({ page }) => {
    await page.goto('/');
    // 等应用挂载完成（窗口监听在 useEffect 中注册），否则按键会打在挂载之前。
    await expect(page.getByRole('heading', { name: '总览', level: 1 })).toBeVisible();
    await page.keyboard.press('Control+KeyK');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder('搜索页面或操作…')).toBeVisible();
  });

  test('端到端无控制台错误（首次加载）', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '总览', level: 1 })).toBeVisible();
    // 过滤掉与 favicon/资源无关的噪声：仍不应有页面级错误
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });
});
