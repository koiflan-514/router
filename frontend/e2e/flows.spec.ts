import { expect, test } from '@playwright/test';

/**
 * 关键流程 E2E（只读）：全部跑在 `--demo` 桥接上。
 *
 * 约束（docs/09-testing.md §1 P2）：不执行任何真实写操作。确认框一律点「取消」，
 * 不点「启动 / 停止 / 同步」等最终确认按钮。
 */

test.describe('服务页：选中 → 详情 → 确认框 → 取消', () => {
  test('点一行打开详情，启动确认框可用「取消」关闭且不提交', async ({ page }) => {
    await page.goto('/providers');
    await expect(page.getByRole('heading', { name: '服务', level: 1 })).toBeVisible();

    // 选择 trae-local 这一行（行本身可键盘聚焦/点击选中）。
    const row = page.getByRole('row', { name: /trae-local/ });
    await expect(row).toBeVisible();
    await row.click();

    // 详情区出现：用它的固定说明文案做锚点，避免与表格里的同名 chip 混淆。
    await expect(page.getByText('四个状态互不推导，请分别确认。')).toBeVisible();
    await expect(page).toHaveURL(/provider=trae-local/);

    // 「启动」只打开确认框，不做任何写入。
    await page.getByRole('button', { name: '启动', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: '确认启动？' })).toBeVisible();
    await expect(dialog.getByText('启动该反代进程', { exact: true })).toBeVisible();

    // 取消后关闭，且焦点默认落在「取消」上（危险操作不能一个 Enter 过去）。
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();
    // URL 仍在服务页，没有提交任务。
    await expect(page).toHaveURL(/\/providers/);
  });
});

/**
 * 读取 search param 的语义值。
 *
 * TanStack Router 默认序列化器会把"看起来像 JSON 的字符串"（如 '0'、'200'）再
 * JSON 编码一次，于是生成 `follow="0"` 这样的参数（解析是对称的，但 URL 不直观）。
 * 这里统一按语义断言，避免把编码细节写死；该现象已记录在回报的缺陷清单里。
 */
function searchParam(page: import('@playwright/test').Page, key: string): string | null {
  const raw = new URL(page.url()).searchParams.get(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return raw;
  }
}

test.describe('日志页：过滤、跟随、行数档位都进 URL', () => {
  test('过滤给出匹配计数与空提示', async ({ page }) => {
    await page.goto('/logs?provider=trae-local');
    await expect(page.getByRole('heading', { level: 1, name: /^日志/ })).toBeVisible();
    // 等快照正文渲染完成（过滤针对已加载文本）。
    await expect(page.getByRole('log').first()).toBeVisible();

    const filter = page.getByRole('textbox', { name: '过滤日志' });
    await filter.fill('INFO');
    await expect(page.getByText(/^\d+ \/ \d+ 行匹配$/)).toBeVisible();
    await expect(page).toHaveURL(/filter=INFO/);

    await filter.fill('zzz-没有这种日志');
    await expect(page.getByText(/^0 \/ \d+ 行匹配$/)).toBeVisible();
    await expect(page.getByText('没有匹配当前过滤的日志')).toBeVisible();
  });

  test('跟随开关写入 follow=1 / follow=0', async ({ page }) => {
    await page.goto('/logs?provider=trae-local');
    await expect(page.getByRole('heading', { level: 1, name: /^日志/ })).toBeVisible();

    const follow = page.getByRole('switch', { name: '跟随最新日志' });
    await expect(follow).toBeChecked();

    await follow.click();
    await expect(follow).not.toBeChecked();
    await expect.poll(() => searchParam(page, 'follow')).toBe('0');

    await follow.click();
    await expect(follow).toBeChecked();
    await expect.poll(() => searchParam(page, 'follow')).toBe('1');
  });

  test('行数档位写入 lines=200', async ({ page }) => {
    await page.goto('/logs?provider=trae-local');
    await expect(page.getByRole('heading', { level: 1, name: /^日志/ })).toBeVisible();

    await page.getByRole('combobox', { name: '尾部行数' }).click();
    await page.getByRole('option', { name: '200 行', exact: true }).click();
    await expect.poll(() => searchParam(page, 'lines')).toBe('200');
    await expect(page.getByRole('combobox', { name: '尾部行数' })).toContainText('200 行');
  });
});

test.describe('网关六个子页', () => {
  const SUBS: Array<[string, string]> = [
    ['调度', '调度快照'],
    ['网关用量', '网关用量'],
    ['降级链', '降级链'],
    ['密钥', '密钥'],
    ['免费供应商', '免费供应商'],
    ['本地应答', '本地应答'],
  ];

  test('逐个点击子导航，h1 与页面一致', async ({ page }) => {
    await page.goto('/gateway');
    await expect(page.getByRole('heading', { name: '调度快照', level: 1 })).toBeVisible();

    const tabs = page.getByRole('navigation', { name: '网关子页' });
    for (const [tab, heading] of SUBS) {
      await tabs.getByRole('link', { name: tab, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      // 当前项通过 aria-current 暴露，而不是只靠颜色。
      await expect(tabs.getByRole('link', { name: tab, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });
});

test.describe('移动端 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('侧栏隐藏，抽屉导航可打开并跳转', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '总览', level: 1 })).toBeVisible();

    // 固定侧栏在窄屏隐藏。
    await expect(page.locator('aside').first()).toBeHidden();

    const openNav = page.getByRole('button', { name: '打开导航' });
    await expect(openNav).toBeVisible();
    await openNav.click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: '主导航' })).toBeVisible();

    await drawer.getByRole('link', { name: '服务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '服务', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/providers$/);
    await expect(drawer).toBeHidden();
  });
});

test.describe('命令面板', () => {
  test('方向键移动选中项 + Enter 跳转', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '总览', level: 1 })).toBeVisible();

    // 空查询时顺序为「总览 → 服务 → …」：↓ 一次到「服务」，Enter 跳转。
    await page.keyboard.press('Control+KeyK');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: '搜索页面或操作' });
    await expect(input).toBeVisible();
    const options = dialog.getByRole('option');
    // 空查询时顺序为「总览 → 服务 → …」：首项默认选中，↓ 一次到「服务」。
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expect(options.first()).toContainText('总览');

    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(1)).toContainText('服务');
    await expect(options.first()).toHaveAttribute('aria-selected', 'false');

    // 输入框通过 aria-activedescendant 指向当前项（不逐项 tabindex）。
    await expect(input).toHaveAttribute('aria-activedescendant', /palette-opt-nav-providers/);

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/providers$/);
    await expect(page.getByRole('heading', { name: '服务', level: 1 })).toBeVisible();

    // 输入过滤后 Enter 也生效（额度）。
    await page.keyboard.press('Control+KeyK');
    await expect(dialog).toBeVisible();
    await input.fill('额度');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/quota$/);
    await expect(page.getByRole('heading', { name: '额度', level: 1 })).toBeVisible();
  });
});

test.describe('未知路由', () => {
  test('/nope 显示「页面不存在」', async ({ page }) => {
    await page.goto('/nope');
    await expect(page.getByRole('heading', { name: '页面不存在', level: 1 })).toBeVisible();
    await expect(page.getByText('检查地址，或按 Ctrl/⌘ + K 打开命令面板。')).toBeVisible();
  });
});