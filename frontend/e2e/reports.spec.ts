import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  emptyGatewayStatus,
  emptyGatewayUsage,
  emptyQuota,
  emptyUsage,
  envelope,
  fulfillJson,
  gotoPage,
} from './helpers';

/**
 * `/reports` 报表页：只读汇总、空/失败降级、范围切换、导出与打印。
 * 全部通过 demo 桥接或就地拦截 `/api/*`，不触碰真实进程。
 */

const REPORTS_API = [
  '**/api/usage**',
  '**/api/quota**',
  '**/api/providers**',
  '**/api/gateway/usage**',
  '**/api/gateway/status**',
];

test.describe('报表页', () => {
  test('加载后渲染来源状态、结论、KPI 与图表', async ({ page }) => {
    await gotoPage(page, '/reports', '报表');

    // 五个来源都必须给出显式状态，不能静默缺项。
    await expect(page.getByText('OpenCode 用量：正常')).toBeVisible();
    await expect(page.getByText('额度：正常')).toBeVisible();
    await expect(page.getByText('Provider 状态：正常')).toBeVisible();
    await expect(page.getByText('网关用量：正常')).toBeVisible();
    await expect(page.getByText('网关调度：正常')).toBeVisible();

    // 报告摘要与六块 KPI。
    await expect(page.getByText('报告摘要', { exact: true })).toBeVisible();
    for (const label of [
      '会话 / 步骤',
      'Token 构成',
      '上报成本',
      '活跃 / 连续',
      '工具成功率',
      '额度覆盖',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // 图表只在有真实活动时绘制；demo 有数据。
    await expect(page.getByRole('img', { name: '报表每日 steps 面积图' })).toBeVisible();
    await expect(page.getByText('模型 Top', { exact: true })).toBeVisible();
    await expect(page.getByText('Provider 用量 Top', { exact: true })).toBeVisible();
  });

  test('加载中显示汇总提示，数据到达后替换', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const pattern of REPORTS_API) {
      await page.route(pattern, async (route) => {
        await gate;
        // 放行给 demo 桥接（不重复实现数据）。
        await route.continue();
      });
    }

    await page.goto('/reports');
    await expect(
      page.getByText('正在汇总 OpenCode 用量、额度、Provider 与网关数据…'),
    ).toBeVisible();
    await expect(page.getByText('等待数据源返回后生成结论…')).toBeVisible();

    release();
    await expect(page.getByText('OpenCode 用量：正常')).toBeVisible();
    await expect(page.getByRole('img', { name: '报表每日 steps 面积图' })).toBeVisible();
  });

  test('全部数据源成功但为空：不伪造数值，各区块给出空状态', async ({ page }) => {
    await page.route('**/api/usage**', (r) => fulfillJson(r, envelope(emptyUsage)));
    await page.route('**/api/quota**', (r) => fulfillJson(r, envelope(emptyQuota)));
    await page.route('**/api/providers**', (r) => fulfillJson(r, envelope([])));
    await page.route('**/api/gateway/usage**', (r) => fulfillJson(r, envelope(emptyGatewayUsage)));
    await page.route('**/api/gateway/status**', (r) => fulfillJson(r, envelope(emptyGatewayStatus)));

    await gotoPage(page, '/reports', '报表');

    await expect(page.getByText('OpenCode 用量：空')).toBeVisible();
    await expect(page.getByText('额度：空')).toBeVisible();
    await expect(page.getByText('Provider 状态：空')).toBeVisible();
    await expect(page.getByText('网关用量：空')).toBeVisible();
    await expect(page.getByText('网关调度：空')).toBeVisible();

    await expect(page.getByText('该范围没有按日活动')).toBeVisible();
    await expect(page.getByText('没有 provider 用量')).toBeVisible();
    await expect(page.getByText('没有模型用量')).toBeVisible();
    await expect(page.getByText('没有 provider 状态')).toBeVisible();
    await expect(page.getByText('没有额度数据')).toBeVisible();
    await expect(page.getByText('该窗口没有网关 provider 聚合。')).toBeVisible();
  });

  test('部分数据源失败：错误条 + 失败徽标，其余来源照常展示', async ({ page }) => {
    await page.route('**/api/usage**', (route) =>
      fulfillJson(
        route,
        envelope(null, false, {
          code: 'UPSTREAM_UNAVAILABLE',
          message: '演示：OpenCode 统计暂不可用',
          retryable: false,
        }),
      ),
    );

    await gotoPage(page, '/reports', '报表');

    await expect(page.getByText(/OpenCode 用量：演示：OpenCode 统计暂不可用/)).toBeVisible();
    await expect(page.getByText('OpenCode 用量：失败')).toBeVisible();
    // 其他来源不受影响。
    await expect(page.getByText('额度：正常')).toBeVisible();
    await expect(page.getByText('Provider 状态：正常')).toBeVisible();
    // 失败的 usage 不应该被写成 0：KPI 用 `—` 表示不可用。
    await expect(page.getByText('无工具调用数据')).toBeVisible();
  });

  test('范围切换写入 URL，并同步网关自然日窗口说明', async ({ page }) => {
    await gotoPage(page, '/reports', '报表');

    const ranges = page.getByRole('group', { name: '时间范围' });
    await ranges.getByRole('button', { name: '24h' }).click();
    await expect(page).toHaveURL(/range=24h/);
    await expect(page.getByText(/范围\s*近 24 小时/)).toBeVisible();
    await expect(page.getByText('网关窗口近 1 天')).toBeVisible();

    await ranges.getByRole('button', { name: '全部' }).click();
    await expect(page).toHaveURL(/range=all/);
    await expect(page.getByText(/范围\s*全部历史/)).toBeVisible();
    await expect(page.getByText(/网关用量按自然日分片，桥接上限 90 天/)).toBeVisible();
  });

  test('CSV / JSON 导出由浏览器生成，打印按钮只调用一次 window.print', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __printCalls: number }).__printCalls = 0;
      window.print = () => {
        (window as unknown as { __printCalls: number }).__printCalls += 1;
      };
    });
    await gotoPage(page, '/reports', '报表');

    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /CSV 明细/ }).click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(/^router-report-7d-\d{4}-\d{2}-\d{2}\.csv$/);
    const csvPath = await csv.path();
    expect(csvPath).not.toBeNull();
    const csvText = await fs.readFile(csvPath!, 'utf8');
    expect(csvText).toContain('trae-local');
    expect(csvText).toContain('glm-5.3-flash');

    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /JSON 汇总/ }).click(),
    ]);
    expect(json.suggestedFilename()).toMatch(/^router-report-7d-\d{4}-\d{2}-\d{2}\.json$/);
    const jsonPath = await json.path();
    const parsed = JSON.parse(await fs.readFile(jsonPath!, 'utf8')) as {
      range?: string;
      sources?: Array<{ key: string }>;
    };
    expect(parsed.range).toBe('7d');
    expect(parsed.sources?.map((s) => s.key)).toEqual([
      'usage',
      'quota',
      'providers',
      'gatewayUsage',
      'gatewayStatus',
    ]);

    await page.getByRole('button', { name: /打印/ }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls))
      .toBe(1);
  });

  test.describe('窄屏 375px', () => {
    test.use({ viewport: { width: 375, height: 800 } });

    test('不横向溢出，关键操作仍可用', async ({ page }) => {
      await gotoPage(page, '/reports', '报表');
      await expect(page.getByRole('button', { name: /CSV 明细/ })).toBeVisible();
      await expect(page.getByRole('img', { name: '报表每日 steps 面积图' })).toBeVisible();

      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        const main = document.querySelector('#main') as HTMLElement | null;
        return {
          document: de.scrollWidth - de.clientWidth,
          body: document.body.scrollWidth - document.body.clientWidth,
          main: main ? main.scrollWidth - main.clientWidth : 0,
        };
      });
      expect(overflow.document).toBeLessThanOrEqual(1);
      expect(overflow.body).toBeLessThanOrEqual(1);
      expect(overflow.main).toBeLessThanOrEqual(1);
    });
  });
});