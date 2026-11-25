import { expect, test } from '@playwright/test';
import { envelope, fulfillJson, gotoPage } from './helpers';

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

    // 近 7 天趋势只出现在右栏一次（底部不再重复画 sparkline）。
    const trends = page.getByRole('img', { name: /近 7 天会话步骤趋势/ });
    await expect(trends).toHaveCount(1);
    await expect(trends).toBeVisible();

    // 额度卡不再借用 steps 趋势：它的可访问描述里不能出现「步骤」。
    const claimCard = kpi.getByRole('group', { name: '额度可领取' });
    await expect(claimCard).toBeVisible();
    await expect(claimCard.getByText(/可领取来自后端 checkin；不推断历史趋势/)).toBeVisible();
    await expect(claimCard).not.toContainText('步骤');
  });

  test('汇总只出现在矩阵表头，不再有重复的 SummaryStrip', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const matrixPanel = page.locator('section[aria-label="provider 状态矩阵"]');
    // 矩阵 SectionHeader 的 description 仍携带汇总口径。
    await expect(matrixPanel.getByText(/运行 \d+\/\d+ · 已启用 \d+\/\d+ · 漂移 \d+ · 认证告警 \d+/)).toBeVisible();
    // 旧汇总条（含「汇总」标题与重复的 stat）已经移除。
    await expect(page.getByText('汇总', { exact: true })).toHaveCount(0);
  });

  test('底部用量概览是紧凑条，不再重复四张 KPI 卡', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const strip = page.getByRole('region', { name: '用量概览（近 7 天）' });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('heading', { name: /用量概览 · 近 7 天/ })).toBeVisible();
    await expect(strip.getByText('会话 / 提示')).toBeVisible();
    await expect(strip.getByText('工具成功率')).toBeVisible();
    await expect(strip.getByRole('link', { name: '在用量页查看详情' })).toBeVisible();
    // 四张旧 KPI 卡（aria-label="用量指标（近 7 天）"）已删除。
    await expect(page.getByRole('region', { name: '用量指标（近 7 天）' })).toHaveCount(0);
  });

  test('provider 矩阵：关键词筛选写 URL，且只保留匹配行', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    await expect(table).toBeVisible();

    await page.getByLabel('按 provider 名称或 ID 筛选').fill('Trae');
    await expect(page).toHaveURL(/q=Trae/);
    await expect(table.getByRole('row', { name: /Trae/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /Qoder 国内版/ })).toHaveCount(0);
    await expect(page.getByText(/共 \d+ 条/)).toBeVisible();

    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page).not.toHaveURL(/q=Trae/);
    await expect(table.getByRole('row', { name: /Qoder 国内版/ })).toBeVisible();
  });

  test('provider 矩阵：点击表头排序，aria-sort 与 URL 同步', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    // 端口与模型数合并为一列（排序键仍是 port）。
    const portHeader = table.getByRole('columnheader', { name: /端口·模型/ });

    await expect(portHeader).toHaveAttribute('aria-sort', 'none');
    await table.getByRole('button', { name: '端口·模型', exact: true }).click();
    await expect(page).toHaveURL(/sort=port/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect(portHeader).toHaveAttribute('aria-sort', 'ascending');

    await table.getByRole('button', { name: '端口·模型', exact: true }).click();
    await expect(page).toHaveURL(/dir=desc/);
    await expect(portHeader).toHaveAttribute('aria-sort', 'descending');

    // 「进程·漂移」合并列：排序键仍是 up，URL 落 sort=up，aria-sort 同步。
    const upHeader = table.getByRole('columnheader', { name: /进程·漂移/ });
    await expect(upHeader).toHaveAttribute('aria-sort', 'none');
    const upButton = table.getByRole('button', { name: '进程·漂移', exact: true });
    await expect(upButton).toHaveAttribute('title', '按进程状态排序；漂移徽标并入本列，明细见行详情');
    await upButton.click();
    await expect(page).toHaveURL(/sort=up/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect(upHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  test('矩阵无漂移的行不出现「运行中 —」（不被读成进程未知）', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    await expect(table.locator('tbody tr').first()).toBeVisible();
    // 无漂移的健康行（无 data-drift-row）只显示「运行中」，不追加漂移空态占位。
    const healthy = table.locator('tbody tr:not([data-drift-row])');
    await expect(healthy.first()).toBeVisible();
    await expect(healthy.first()).toContainText('运行中');
    await expect(healthy.first().locator('td').nth(2)).not.toContainText('—');
    await expect(table).not.toContainText('运行中 —');
    // 页面其它地方（拓扑条/卡片）同样不得出现该误导组合。
    await expect(page.locator('body')).not.toContainText('运行中 —');
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

    test('矩阵 7 列全部可见：额度列不被容器裁切', async ({ page }) => {
      await gotoPage(page, '/', '总览');
      const region = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
      await expect(region).toBeVisible();
      const box = await region.boundingBox();
      expect(box).not.toBeNull();

      const quotaHeader = region.getByRole('columnheader', { name: '额度' });
      await expect(quotaHeader).toBeVisible();
      const quotaBox = await quotaHeader.boundingBox();
      expect(quotaBox).not.toBeNull();
      // 最后一列完整落在滚动容器内（右侧不越界）。
      expect(quotaBox!.x + quotaBox!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
      // 容器本身不产生横向滚动（不需要拖动才能看全）。
      const overflow = await region.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      // 7 列：Provider / 开关 / 进程 / 认证 / 客户端 / 端口·模型 / 额度。
      await expect(region.getByRole('columnheader')).toHaveCount(7);
      // 「跳转」列已移除（行内不再有服务/日志/诊断链接，改由详情抽屉承载）。
      await expect(region.getByRole('link')).toHaveCount(0);
    });

    test('矩阵行高一致，且行内无漂移二级小字', async ({ page }) => {
      await gotoPage(page, '/', '总览');
      const region = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
      const rows = region.locator('tbody tr');
      await expect(rows.first()).toBeVisible();
      const heights = await rows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
      expect(new Set(heights).size).toBe(1);
      // 行内徽标都是一行：任何单元格高度都不超过行高（不出现换行撑高）。
      const cells = await rows.first().locator('td').evaluateAll((els) =>
        els.map((el) => ({ h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.scrollWidth - el.clientWidth) })),
      );
      for (const c of cells) expect(c.h).toBeLessThanOrEqual(heights[0]);
      // 漂移明细文案（driftDetailText）不应作为二级小字出现在表格里。
      await expect(region.getByText(/开关=开、进程=停止/)).toHaveCount(0);
      await expect(region.getByText(/开关=关、进程仍在运行/)).toHaveCount(0);
    });
  });

  test.describe('右栏「近 7 天用量」的数据真实性', () => {
    test('成功：数据时间条里「用量」显示成功时间', async ({ page }) => {
      await gotoPage(page, '/', '总览');
      const usageSource = page.locator('[data-source="用量"]');
      await expect(usageSource).toHaveAttribute('data-source-state', 'ok');
      const text = (await usageSource.textContent())?.trim() ?? '';
      // 成功时不是「失败」，也不是空占位 —。
      expect(text).not.toContain('失败');
      expect(text.replace('用量', '').trim()).not.toBe('—');
      await expect(page.locator('[data-usage-state="error"]')).toHaveCount(0);
    });

    test('失败：右栏显式报错并可区分于「没有 activity」（route 拦截 /api/usage）', async ({ page }) => {
      await page.route('**/api/usage**', (route) =>
        fulfillJson(
          route,
          envelope(null, false, { code: 'UPSTREAM', message: '用量接口不可用（模拟失败）', retryable: true }),
          502,
        ),
      );
      await gotoPage(page, '/', '总览');

      const aside = page.getByRole('complementary', { name: '健康度与待处理事项' });
      const alert = aside.locator('[data-usage-state="error"]');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('用量读取失败：用量接口不可用（模拟失败）');
      // 失败不是空态：不得渲染「没有 activity」占位。
      await expect(aside.getByText(/没有 activity 序列/)).toHaveCount(0);
      await expect(aside.getByRole('link', { name: /去用量页重试/ })).toBeVisible();
      // 数据时间条把「用量」标成失败（不再静默显示为「—」）。
      const usageSource = page.locator('[data-source="用量"]');
      await expect(usageSource).toContainText('失败');
      await expect(usageSource).toHaveAttribute('data-source-state', 'error');
    });
  });
});
