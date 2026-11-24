import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers';

/** 键盘与焦点：主导航 aria-current、跳过链接、命令面板、页面级快捷键不重复触发。 */
test.describe('键盘与焦点', () => {
  test('主导航 aria-current 精确对应当前页（含网关子页）', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: '主导航' });
    await gotoPage(page, '/reports', '报表');
    await expect(nav.getByRole('link', { name: '报表', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.goto('/usage');
    await expect(page.getByRole('heading', { name: '用量', level: 1 })).toBeVisible();
    await expect(nav.getByRole('link', { name: '用量', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.goto('/gateway/usage');
    await expect(page.getByRole('heading', { name: '网关用量', level: 1 })).toBeVisible();
    await expect(nav.getByRole('link', { name: '网关用量', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: '网关', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('Tab 首先聚焦跳过链接，Enter 跳到主内容', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: '跳到主内容' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('命令面板：Ctrl+K 开关、方向键选择、Esc 关闭、搜索报表', async ({ page }) => {
    await gotoPage(page, '/', '总览');

    await page.keyboard.press('Control+KeyK');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);

    const input = dialog.getByRole('combobox', { name: '搜索页面或操作' });
    const options = dialog.getByRole('option');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', /palette-opt-nav-providers/);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // 再次 Ctrl+K 打开，立即再按 Ctrl+K 应关闭（toggle，不产生第二个 dialog）。
    await page.keyboard.press('Control+KeyK');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Control+KeyK');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // 新页面已纳入命令面板索引。
    await page.keyboard.press('Control+KeyK');
    await input.fill('报表');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole('heading', { name: '报表', level: 1 })).toBeVisible();
  });

  test('额度页 `r` 刷新只触发一次，输入控件内不误触', async ({ page }) => {
    let quotaRequests = 0;
    await page.route('**/api/quota**', async (route) => {
      quotaRequests += 1;
      await route.continue();
    });

    await gotoPage(page, '/quota', '额度');
    await expect(page.getByText('加购额度')).toBeVisible();
    const before = quotaRequests;
    await page.keyboard.press('r');
    await expect.poll(() => quotaRequests).toBe(before + 1);

    // 焦点在弹层上下文时 `r` 必须交给弹层，而不是触发页面刷新。
    const sort = page.getByRole('combobox', { name: '额度排序方式' });
    await sort.click();
    await expect(page.getByRole('option', { name: '名称', exact: true })).toBeVisible();
    const afterPopover = quotaRequests;
    await page.keyboard.press('r');
    await page.waitForTimeout(400);
    expect(quotaRequests).toBe(afterPopover);
  });
});