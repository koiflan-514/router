import { expect, test, type Page } from '@playwright/test';
import { gotoPage } from './helpers';

/**
 * 真实模式只读 E2E（**默认跳过**）。
 *
 * 启用方式：先在本机拉起只读桥接（真实 CLI，不 spawn 写操作），再带上环境变量跑：
 *
 *   node frontend/server/index.mjs --read-only --port 8894
 *   PANEL_E2E_REAL=1 PANEL_E2E_PORT=8894 npx playwright test e2e/real.spec.ts --workers=1
 *
 * 断言的是「真实数据覆盖」：13 家反代 + 网关都在、没有演示徽标、额度/用量来自真实接口
 * （空数据必须是空态而不是 0 曲线），报表五个数据源徽标齐备。全程只读，不点击任何写操作。
 */

test.skip(!process.env.PANEL_E2E_REAL, '需要真实只读桥接（PANEL_E2E_REAL=1）');

const REAL_PROVIDER_IDS = [
  'qoder-cn',
  'qoder',
  'trae-local',
  'codearts',
  'zcode',
  'loomy',
  'raccoon',
  'qwenwork',
  'dumate',
  'lingxi',
  'lobster',
  'workbuddy',
  'workbuddy-global',
] as const;

/** 新增 4 家（白名单/分类色此前缺口）。 */
const NEW_PROVIDER_IDS = ['qwenwork', 'dumate', 'lingxi', 'lobster'] as const;

/** demo 夹具的标记：真实模式下一律不得出现。 */
const DEMO_MARKERS = /(example-|demo-|slot-a)/;

async function readApi<T>(page: Page, path: string): Promise<{ ok: boolean; data: T }> {
  return page.evaluate(async (p) => {
    const token = document.querySelector('meta[name="panel-token"]')?.getAttribute('content') ?? '';
    const res = await fetch(p, { headers: token ? { 'x-panel-token': token } : {} });
    return res.json();
  }, path) as Promise<{ ok: boolean; data: T }>;
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/** 整页文本不得出现 demo 标记；逐元素检查，避免 `textContent` 拼接掩盖出现的 id。 */
async function expectNoDemoMarkers(page: Page) {
  const hits = await page
    .locator('#main, header, nav, footer')
    .evaluateAll(
      (els, re) =>
        els
          .filter((el) => new RegExp(re, 'i').test(el.textContent ?? ''))
          .map((el) => (el.textContent ?? '').slice(0, 200)),
      DEMO_MARKERS.source,
    );
  expect(hits, `页面出现 demo 标记：${hits.join(' | ')}`).toEqual([]);
}

test.describe('真实模式（只读）', () => {
  test('桥接处于 real + readOnly，顶栏没有「演示」徽标', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await gotoPage(page, '/', '总览');

    const env = await readApi<{ mode: string; readOnly: boolean }>(page, '/api/env');
    expect(env.ok).toBe(true);
    expect(env.data.mode).toBe('real');
    expect(env.data.readOnly).toBe(true);

    // 顶栏 / 侧栏状态徽标区：不得出现「演示」（demo 夹具模式才有）。
    const banner = page.getByRole('banner');
    await expect(banner.getByText('演示', { exact: true })).toHaveCount(0);
    await expect(page.getByText('演示数据', { exact: true })).toHaveCount(0);
    // 顶栏状态徽标按真实可达性渲染（可达 / 不可达 / 未知三态都合法，但必须存在）。
    await expect(banner.getByText(/^(网关可达|网关不可达|网关未知)$/)).toBeVisible();

    expect(errors, `console 错误：${errors.join(' | ')}`).toEqual([]);
  });

  test('/api/providers：13 家反代 + gateway，含新增 4 家与正确标题', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const res = await readApi<Array<{ id: string; title: string; overlay: boolean }>>(page, '/api/providers');
    expect(res.ok).toBe(true);
    const ids = res.data.map((p) => p.id);
    expect(res.data.length).toBeGreaterThanOrEqual(13);
    for (const id of REAL_PROVIDER_IDS) expect(ids, `缺少真实 provider：${id}`).toContain(id);
    expect(ids).toContain('gateway');

    const titles = Object.fromEntries(res.data.map((p) => [p.id, p.title]));
    expect(titles.qwenwork).toBe('千问办公');
    expect(titles.dumate).toBe('百度搭子');
    expect(titles.lingxi).toBe('WPS 灵犀');
    expect(titles.lobster).toBe('有道龙虾（LobsterAI）');
    // 网关是唯一叠加层。
    expect(res.data.filter((p) => p.overlay).map((p) => p.id)).toEqual(['gateway']);
  });

  test('总览矩阵覆盖全部真实 provider（含新增 4 家，无演示标记）', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    await expect(table).toBeVisible();
    // 行计数在筛选项工具条里（表格容器之外）。
    await expect(page.getByText(/共 \d+ 条/)).toBeVisible();

    // 新增 4 家在矩阵里可见（compact chip 的可访问名是「名称 (id)」）。
    for (const id of NEW_PROVIDER_IDS) {
      await expect(table.getByRole('button', { name: new RegExp(`\\(${id}\\)`) })).toBeVisible();
    }
    await expect(table.getByText('叠加', { exact: true }).first()).toBeVisible();

    // 整页文本不得出现 demo 标记。
    await expectNoDemoMarkers(page);
  });

  test('总览矩阵：无漂移的健康行不出现「运行中 —」', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const table = page.getByRole('region', { name: 'provider 状态矩阵，可横向滚动' });
    const real = await readApi<Array<{ id: string; up: boolean; drift: string[] }>>(page, '/api/providers');
    expect(real.ok).toBe(true);
    const healthyIds = real.data.filter((p) => p.up && p.drift.length === 0).map((p) => p.id);
    test.skip(healthyIds.length === 0, '真实数据里没有「运行中且无漂移」的行，本断言不适用');

    // 合并列的表头与排序提示。
    await expect(table.getByRole('columnheader', { name: /进程·漂移/ })).toBeVisible();
    const upButton = table.getByRole('button', { name: '进程·漂移', exact: true });
    await expect(upButton).toHaveAttribute('title', '按进程状态排序；漂移徽标并入本列，明细见行详情');

    // 健康行（无 data-drift-row）只显示进程状态；「运行中 —」整页都不允许出现。
    const healthyRows = table.locator('tbody tr:not([data-drift-row])');
    await expect(healthyRows.first()).toBeVisible();
    await expect(healthyRows.first().locator('td').nth(2)).not.toContainText('—');
    await expect(table).not.toContainText('运行中 —');
    await expect(page.locator('body')).not.toContainText('运行中 —');
  });

  test('总览「数据时间」：用量成功时显示真实时间（失败分支只在 demo 拦截里测）', async ({ page }) => {
    await gotoPage(page, '/', '总览');
    const usage = await readApi<{ sessions: number }>(page, '/api/usage?range=7d');
    // 真实后端能答 /api/usage 时，数据时间条必须显示成功时间而不是「失败」。
    expect(usage.ok).toBe(true);
    const source = page.locator('[data-source="用量"]');
    await expect(source).toHaveCount(1);
    await expect(source).toHaveAttribute('data-source-state', 'ok');
    await expect(source).not.toContainText('失败');
    await expect(page.locator('[data-usage-state="error"]')).toHaveCount(0);
  });

  test('/api/quota：真实来源，不出现 example- / demo- / slot-a', async ({ page }) => {
    await gotoPage(page, '/quota', '额度');
    const res = await readApi<{
      fetchedAt: string | null;
      providers: Array<{ provider: string; kind: string; title: string; available: boolean; fetchedAt?: string | null }>;
    }>(page, '/api/quota');
    expect(res.ok).toBe(true);
    expect(res.data.fetchedAt, '真实模式必须带采集时间').toBeTruthy();
    expect(res.data.providers.length).toBeGreaterThan(0);
    for (const row of res.data.providers) {
      expect(row.provider).not.toBe('gateway');
      expect(`${row.provider} ${row.kind} ${row.title}`).not.toMatch(DEMO_MARKERS);
    }

    // 页面层：不得出现 demo 标记，且必须展示真实采集时间。
    await expectNoDemoMarkers(page);
    await expect(page.getByText(/来源采集时间/)).toBeVisible();
    // 额度卡片头部用 compact chip：只显示名称，id 只进入 title（不再出现「ZCode (Z.ai) zcode」）。
    const chips = await page
      .locator('#main [title$=")"][title*=" ("]')
      .evaluateAll((els) => els.map((el) => ({ title: el.getAttribute('title') ?? '', text: (el.textContent ?? '').trim() })));
    expect(chips.length).toBeGreaterThan(0);
    for (const row of res.data.providers) {
      if (row.title === row.provider) continue;
      // title 形如「ZCode (Z.ai) (zcode)」，可见文本必须只有名称。
      const expected = `${row.title} (${row.provider})`;
      const chip = chips.find((c) => c.title === expected);
      expect(chip, `额度卡片缺少「${expected}」的 compact chip`).toBeTruthy();
      expect(chip!.text).toBe(row.title.trim());
    }
    // 页面渲染的额度卡片与接口来源一一对应（不补假卡片、不合并来源）。
    const cards = page.getByRole('main').locator('div.rounded-lg.border.border-stroke-1.bg-card');
    expect(await cards.count()).toBeGreaterThanOrEqual(res.data.providers.length);
  });

  test('/api/usage?range=7d：真实数值；空数据走空态而非 0 曲线', async ({ page }) => {
    await gotoPage(page, '/usage', '用量');
    const res = await readApi<{ sessions: number; steps: number; activity: unknown[] }>(
      page,
      '/api/usage?range=7d',
    );
    expect(res.ok).toBe(true);
    expect(Number.isFinite(res.data.sessions)).toBe(true);
    expect(Number.isFinite(res.data.steps)).toBe(true);

    const hasData = res.data.sessions > 0 || res.data.steps > 0 || res.data.activity.length > 0;
    if (hasData) {
      // 有数据：KPI 至少展示一个非占位数字，趋势线存在。
      await expect(page.getByText('会话 / 提示').first()).toBeVisible();
      // 「按日 steps 趋势」迷你图的可访问描述挂在卡片 group 的 sr-only 文本上。
      await expect(page.getByText(/按日 steps 趋势/).first()).toBeAttached();
    } else {
      // 空数据：明确空态，不画趋势。
      await expect(page.getByText(/该时间范围内没有用量数据/)).toBeVisible();
      await expect(page.getByText(/按日 steps 趋势/)).toHaveCount(0);
    }
    await expectNoDemoMarkers(page);
  });

  test('/api/gateway/status 与 /api/gateway/usage 返回真实网关数据', async ({ page }) => {
    await gotoPage(page, '/gateway', '调度快照');
    const status = await readApi<{ ok: boolean; providers: Array<{ id: string }> }>(page, '/api/gateway/status');
    expect(status.ok).toBe(true);
    expect(Array.isArray(status.data.providers)).toBe(true);

    await gotoPage(page, '/gateway/usage', '网关用量');
    const usage = await readApi<{ days: number; requests: number; byDay: unknown[] }>(
      page,
      '/api/gateway/usage?days=7',
    );
    expect(usage.ok).toBe(true);
    expect(usage.data.days).toBe(7);
    expect(Number.isFinite(usage.data.requests)).toBe(true);
    expect(Array.isArray(usage.data.byDay)).toBe(true);
    await expectNoDemoMarkers(page);
  });

  test('报表页：五个数据源徽标齐备，结论与时间来自真实接口', async ({ page }) => {
    await gotoPage(page, '/reports', '报表');
    for (const label of ['OpenCode 用量', '额度', 'Provider 状态', '网关用量', '网关调度']) {
      await expect(page.getByText(new RegExp(`^${label}：`)).first()).toBeVisible();
    }
    await expect(page.getByText(/生成时间/)).toBeVisible();
    await expectNoDemoMarkers(page);
    // 只读页不渲染任何写操作按钮文案。
    await expect(page.getByRole('button', { name: /^(启动|停止|重启|签到)$/ })).toHaveCount(0);

    // Provider 用量 Top：compact chip 只显示名称，id 只在 title 里（不再「百度搭子 dumate」）。
    await expect(page.getByText('Provider 用量 Top', { exact: true })).toBeVisible();
    const topCard = page.getByText('Provider 用量 Top', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    const topChips = topCard.locator('[title$=")"][title*=" ("]');
    await expect(topChips.first()).toBeVisible();
    const topTitles = await topChips.evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
    expect(topTitles.length).toBeGreaterThan(0);
    // 已知的 14 家反代必须显示中文标题（只剩 id 说明标题映射丢了）；未知来源（如插件自带的
    // provider「TPS」「opencode」）只能回落成「id (id)」，属合法兜底，不在此断言。
    const KNOWN = [
      'qoder-cn',
      'qoder',
      'trae-local',
      'codearts',
      'zcode',
      'loomy',
      'raccoon',
      'qwenwork',
      'dumate',
      'lingxi',
      'lobster',
      'workbuddy',
      'workbuddy-global',
      'gateway',
    ];
    const knownTitles = topTitles.filter((title) => {
      const id = title.slice(title.lastIndexOf('(') + 1, -1);
      return KNOWN.includes(id);
    });
    for (const title of knownTitles) {
      const id = title.slice(title.lastIndexOf('(') + 1, -1);
      expect(title, `已知 provider ${id} 应显示中文标题而不是重复 id`).not.toBe(`${id} (${id})`);
    }

    // KPI「会话 / 步骤」：数值拆成「会话 N」「步骤 N」两行，斜杠不再被折成孤立的一行。
    const sessionCard = page.getByRole('group', { name: '会话 / 步骤' });
    await expect(sessionCard).toBeVisible();
    await expect(sessionCard.getByText(/^会话 \d/)).toBeVisible();
    await expect(sessionCard.getByText(/^步骤 \d/)).toBeVisible();
    await expect(sessionCard.getByText(/^\s*\/\s*$/)).toHaveCount(0);
  });
});
