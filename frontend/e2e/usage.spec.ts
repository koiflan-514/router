import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { emptyUsage, envelope, fulfillJson, gotoPage } from './helpers';

/** 用量页：范围、图表、排序、导出与空状态；不与网关用量混淆。 */
test.describe('用量页', () => {
  test('范围切换写入 URL，图表与模型表同源更新', async ({ page }) => {
    await gotoPage(page, '/usage', '用量');
    await expect(page.getByRole('img', { name: '每日 steps 面积图' })).toBeVisible();
    await expect(page.getByText('模型 / Provider', { exact: true })).toBeVisible();
    await expect(page.getByText('Token 构成').first()).toBeVisible();

    const ranges = page.getByRole('group', { name: '时间范围' });
    await ranges.getByRole('button', { name: '24h' }).click();
    await expect(page).toHaveURL(/range=24h/);
    await expect(ranges.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/范围：/).first()).toBeVisible();

    await ranges.getByRole('button', { name: '30d' }).click();
    await expect(page).toHaveURL(/range=30d/);
    await expect(ranges.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');

    await ranges.getByRole('button', { name: '全部' }).click();
    await expect(page).toHaveURL(/range=all/);
    await expect(ranges.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('模型表排序：表头 aria-sort 与 search params 双向同步', async ({ page }) => {
    await gotoPage(page, '/usage', '用量');
    const table = page.getByRole('region', { name: '数据表格，可横向滚动' });
    const stepsHeader = table.getByRole('columnheader', { name: /Steps/ });
    await expect(stepsHeader).toHaveAttribute('aria-sort', 'descending');

    await table.getByRole('button', { name: 'Steps' }).click();
    await expect(page).toHaveURL(/sort=steps/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect(stepsHeader).toHaveAttribute('aria-sort', 'ascending');

    await table.getByRole('button', { name: '模型' }).click();
    await expect(page).toHaveURL(/sort=model/);
    await expect(page).toHaveURL(/dir=desc/);
  });

  test('CSV 导出下载包含当前范围、模型与每日活动', async ({ page }) => {
    await gotoPage(page, '/usage', '用量');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /导出 CSV/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^router-usage-7d-\d{4}-\d{2}-\d{2}\.csv$/);
    const path = await download.path();
    expect(path).not.toBeNull();
    const text = await fs.readFile(path!, 'utf8');
    expect(text).toContain('glm-5.3-flash');
    expect(text).toContain('trae-local');
    expect(text).toContain('2026-11-11');
  });

  test('空数据：空状态而不是 0 曲线，导出禁用', async ({ page }) => {
    await page.route('**/api/usage**', (route) => fulfillJson(route, envelope(emptyUsage)));
    await gotoPage(page, '/usage', '用量');

    await expect(page.getByText('该时间范围内没有用量数据')).toBeVisible();
    await expect(page.getByRole('button', { name: /导出 CSV/ })).toBeDisabled();
    await expect(page.getByRole('img', { name: '每日 steps 面积图' })).toHaveCount(0);
  });

  test('非法 range / sort 回退默认值并显式提示', async ({ page }) => {
    await gotoPage(page, '/usage?range=99d&sort=nope&dir=sideways', '用量');
    await expect(page.getByText('URL 参数已回退默认值')).toBeVisible();
    await expect(page.getByText(/range 仅支持 24h \/ 7d \/ 30d \/ all/)).toBeVisible();
    await expect(page.getByText(/sort \/ dir 取值非法/)).toBeVisible();
    await expect(page.getByRole('img', { name: '每日 steps 面积图' })).toBeVisible();
  });
});