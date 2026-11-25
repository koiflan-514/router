import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers';

/** 网关六个只读子页：调度 lane、用量图、降级链阶梯、密钥、免费供应商、本地应答。 */
test.describe('网关', () => {
  test('调度快照：lane 指标、状态与只读约束', async ({ page }) => {
    await gotoPage(page, '/gateway', '调度快照');

    await expect(page.getByText('网关状态', { exact: true })).toBeVisible();
    await expect(page.getByText('权重', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('并发', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('成功率', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('额度比', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('粘性会话', { exact: true }).first()).toBeVisible();

    // 三个网关页的 chip 用 compact：可见文本只有中文名，id 只进 title / aria-label。
    const traeChip = page.locator('[title*="(trae-local)"]').first();
    await expect(traeChip).toBeVisible();
    await expect(traeChip).toContainText('Trae');
    await expect(page.getByText('运行中', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible();

    // 调度页不提供任何选择/开关控件。
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });

  test('网关用量：天数切换进 URL，请求/Token 双图与按天明细', async ({ page }) => {
    await gotoPage(page, '/gateway/usage', '网关用量');
    await expect(page.getByRole('img', { name: '网关每日请求与错误面积图' })).toBeVisible();
    await expect(page.getByRole('img', { name: '网关每日输入输出 Token 堆叠面积图' })).toBeVisible();
    await expect(page.getByText('Provider Top', { exact: true })).toBeVisible();
    await expect(page.getByText('模型 Top', { exact: true })).toBeVisible();
    await expect(page.getByText('按天明细')).toBeVisible();

    const tabs = page.getByRole('navigation', { name: '统计天数' });
    await tabs.getByRole('link', { name: '近 30 天' }).click();
    await expect(page).toHaveURL(/days=30/);
    await expect(page.getByText(/近 30 天网关转发的请求与 Token 计数/)).toBeVisible();
  });

  test('降级链：有序阶梯、策略与每一环状态', async ({ page }) => {
    await gotoPage(page, '/gateway/combos', '降级链');
    await expect(page.getByText('combo:fast')).toBeVisible();
    await expect(page.getByText('combo:smart')).toBeVisible();
    await expect(page.getByText('顺序降级 fallback')).toBeVisible();
    await expect(page.getByText('轮换 round-robin')).toBeVisible();
    await expect(page.getByText('第 1 / 2 环').first()).toBeVisible();
    await expect(page.getByText('第 2 / 2 环').first()).toBeVisible();
    await expect(page.getByText('就绪', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/第一个产出正文的赢/)).toBeVisible();
  });

  test('密钥：只显示前缀与用量，不泄露 hash/明文', async ({ page }) => {
    await gotoPage(page, '/gateway/keys', '密钥');
    await expect(page.getByText('共 3 个密钥')).toBeVisible();
    await expect(page.getByText(/启用 2/)).toBeVisible();
    await expect(page.getByText(/禁用 1/)).toBeVisible();
    await expect(page.getByText('zsk_example1', { exact: true })).toBeVisible();
    await expect(page.getByText('已禁用', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('progressbar', { name: /密钥 zsk_example3 已用 Token 占比/ }),
    ).toBeVisible();

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/\b[0-9a-f]{64}\b/i);
    expect(body).not.toContain('zsk_plain');
  });

  test('免费供应商与本地应答：只读清单，开关全部禁用', async ({ page }) => {
    await gotoPage(page, '/gateway/free', '免费供应商');
    await expect(page.getByText('OpenCode Zen', { exact: true })).toBeVisible();
    await expect(page.getByText('OpenRouter', { exact: true })).toBeVisible();
    await expect(page.getByText('Groq', { exact: true })).toBeVisible();
    await expect(page.getByText('可用', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('待配置', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('本机', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/这些供应商由网关直接调用/).first()).toBeVisible();

    await page.goto('/gateway/local-answers');
    await expect(page.getByRole('heading', { name: '本地应答', level: 1 })).toBeVisible();
    await expect(page.getByText(/共 5 项/)).toBeVisible();
    await expect(page.getByText(/开启 2/)).toBeVisible();
    await expect(page.getByText(/关闭 3/)).toBeVisible();
    for (const label of ['额度检查', '命令前缀', '会话标题', '补全建议', '文件路径']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(5);
    for (let i = 0; i < 5; i += 1) {
      await expect(switches.nth(i)).toBeDisabled();
    }
  });
});