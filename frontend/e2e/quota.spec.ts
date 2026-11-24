import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers';

/** 额度页：筛选/排序、环形 gauge、WorkBuddy 天数与「未知总量不画假进度」。 */
test.describe('额度页', () => {
  test('环形 gauge 用真实剩余/总量，未知总量不显示百分比', async ({ page }) => {
    await gotoPage(page, '/quota', '额度');

    // 有总量：SVG 暴露剩余/总量与百分比。
    const known = page.getByRole('img', { name: /加购额度：剩余 96 \/ 800 credits，12%/ });
    await expect(known).toBeVisible();

    // 无总量：明确写「总量未知」，且 aria-label 不得伪造百分比。
    const unknown = page.getByRole('img', { name: /可用积分：总量未知，剩余 9,291 credits/ });
    await expect(unknown).toBeVisible();
    await expect(unknown).not.toHaveAttribute('aria-label', /%/);
    await expect(page.getByText('未提供总量，暂不显示占比；剩余量按原单位展示。')).toBeVisible();
  });

  test('WorkBuddy 凭证天数单独展示，不并入 credits', async ({ page }) => {
    await gotoPage(page, '/quota', '额度');
    await expect(page.getByText('凭证天数', { exact: true })).toBeVisible();
    await expect(page.getByText('29', { exact: true })).toBeVisible();
    await expect(page.getByText('天', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('凭证 / 续期天数不并入 credits 汇总。')).toBeVisible();
    await expect(page.getByText('凭证天数单独展示，不并入 credits')).toBeVisible();
  });

  test('状态筛选（全部/可查/不可用/需处理）只改变可见卡片并保留计数', async ({ page }) => {
    await gotoPage(page, '/quota', '额度');
    const filters = page.getByRole('group', { name: '按状态筛选额度' });
    await expect(filters.getByRole('button', { name: /^全部/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await filters.getByRole('button', { name: /^不可用/ }).click();
    await expect(filters.getByRole('button', { name: /^不可用/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('CodeArts Agent', { exact: true })).toBeVisible();
    await expect(page.getByText('Qoder 国内版', { exact: true })).toHaveCount(0);

    await filters.getByRole('button', { name: /^可查/ }).click();
    await expect(page.getByText('Qoder 国内版', { exact: true })).toBeVisible();
    await expect(page.getByText('CodeArts Agent', { exact: true })).toHaveCount(0);

    await filters.getByRole('button', { name: /^全部/ }).click();
    await expect(page.getByText('CodeArts Agent', { exact: true })).toBeVisible();
  });

  test('排序方式与方向切换（名称 + 升/降序）', async ({ page }) => {
    await gotoPage(page, '/quota', '额度');
    const select = page.getByRole('combobox', { name: '额度排序方式' });
    await select.click();
    await page.getByRole('option', { name: '名称', exact: true }).click();
    await expect(select).toContainText('名称');

    const dir = page.getByRole('button', { name: /当前(升|降)序，点击改为/ });
    const before = await dir.getAttribute('aria-label');
    await dir.click();
    await expect(dir).not.toHaveAttribute('aria-label', before ?? '');
  });

  test('URL provider 非法时回退「全部」并提示一次', async ({ page }) => {
    await gotoPage(page, '/quota?provider=nope', '额度');
    await expect(page.getByText('URL 参数已回退默认值')).toBeVisible();
    await expect(page.getByText(/provider「nope」不在已知清单/)).toBeVisible();
    await expect(page.getByText('加购额度')).toBeVisible();
  });
});