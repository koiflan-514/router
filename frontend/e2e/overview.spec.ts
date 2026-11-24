import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers';

/**
 * 总览页 Fluent 新结构：KPI 瓦片、拓扑条、右栏、provider 矩阵筛选/排序/详情抽屉。
 * 只读页不得出现任何写操作控件。
 */

test.describe('总览页', () => {
  test('KPI 瓦片、拓扑条与右栏齐备', async ({ page }) => {
    await gotoPage(page, '/', '总览');

    const kpi = page.getByRole('region', { name: '关键指标' });
    await expect(kpi).toBeVisible();
    for (const label of ['运行中 / 已启用', '漂移 / 异常', '认证告警', '额度可领取']) {
      await expect(kpi.getByText(label, { exact: true })).toBeVisible();
    }

    const topology = page.getByRole('group', { name: /服务拓扑/ });
    await expect(topology).toBeVisible();
    await expect(topology.getByText(/来源 \d+ 个 · 运行 \d+ 个/)).toBeVisible();

    const aside = page.getByRole('complementary', { name: '健康度与待处理事项' });
    await expect(aside).toBeVisible();
    for (const title of ['健康度', '额度 Top', '近 7 天用量', '待处理事项']) {
      await expect(aside.getByRole('heading', { name: title })).toBeVisible();
    }

    // 近 7 天大图与 KPI 同源。
    await expect(page.getByRole('img', { name: /近 7 天会话步骤趋势/ })).toBeVisible();
  });

  test('provider 矩阵：关键词筛选写 URL，且只保留匹配行', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    await expect(table).toBeVisible();

    await page.getByLabel('按 provider 名称或 ID 筛选').fill('Trae');
    await expect(page).toHaveURL(/q=Trae/);
    await expect(table.getByRole('row', { name: /Trae/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /Qoder 国内版/ })).toHaveCount(0);
    await expect(page.getByText(/共 10 条/)).toBeVisible();

    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page).not.toHaveURL(/q=Trae/);
    await expect(table.getByRole('row', { name: /Qoder 国内版/ })).toBeVisible();
  });

  test('provider 矩阵：点击表头排序，aria-sort 与 URL 同步', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    const portHeader = table.getByRole('columnheader', { name: /端口/ });

    await expect(portHeader).toHaveAttribute('aria-sort', 'none');
    await table.getByRole('button', { name: '端口', exact: true }).click();
    await expect(page).toHaveURL(/sort=port/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect(portHeader).toHaveAttribute('aria-sort', 'ascending');

    await table.getByRole('button', { name: '端口', exact: true }).click();
    await expect(page).toHaveURL(/dir=desc/);
    await expect(portHeader).toHaveAttribute('aria-sort', 'descending');
  });

  test('provider 详情抽屉：点击打开、字段完整、Esc 关闭', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    await table.getByRole('button', { name: /Qoder 国内版.*查看详情/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/provider=qoder-cn/);
    await expect(page).toHaveURL(/panel=provider/);
    for (const label of ['开关 on', '进程 up', '客户端 oc', '认证 auth', '全部 PID', 'control']) {
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(dialog.getByRole('link', { name: '前往服务页' })).toBeVisible();
    await expect(dialog.getByText(/本页写操作|不在本页写操作/)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/panel=provider/);
  });

  test('总览不渲染写操作控件（启动/停止/重启/同步/签到）', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    await expect(
      page.getByRole('button', { name: /^(启动|停止|重启|同步|签到|恢复整池|全开|全关)$/ }),
    ).toHaveCount(0);
    // 只读说明仍然可见，避免用户误以为这里是操作台。
    await expect(page.getByText('本页只读，操作请前往对应功能页。')).toBeVisible();
  });

  test.describe('宽屏 1440px', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('右栏固定在矩阵右侧（≥1280px）', async ({ page }) => {
      await gotoPage(page, '/', '总览');
      const matrix = page.locator('section[aria-label="provider 状态矩阵"]');
      const aside = page.getByRole('complementary', { name: '健康度与待处理事项' });
      const matrixBox = await matrix.boundingBox();
      const asideBox = await aside.boundingBox();
      expect(matrixBox).not.toBeNull();
      expect(asideBox).not.toBeNull();
      expect(asideBox!.x).toBeGreaterThan(matrixBox!.x + matrixBox!.width / 2);
      // 顶部对齐（允许 1px 亚像素差）。
      expect(Math.abs(asideBox!.y - matrixBox!.y)).toBeLessThanOrEqual(2);
    });
  });
});