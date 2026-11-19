import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * 逐页无障碍扫描（WCAG 2.1 A/AA 规则集）。
 *
 * 失败口径：只把 axe 的 `serious` / `critical` 视为失败；`moderate` / `minor`
 * 仅记录，不阻塞（对齐 docs/09-testing.md §2.6「零 critical/serious」）。
 *
 * 已知缺陷基线：审计时发现、但按任务边界（不改 `src/**`）不能在本轮修复的
 * serious 违规登记在 `KNOWN` 里，扫描结果会先扣掉它们再判失败。命中基线时用
 * `console.warn` 打印 id / impact / target，避免"静默通过"；完整清单与修复建议见
 * `tests/a11y/README.md`。基线不是豁免：新出现的 serious/critical 一律失败。
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

interface PageTarget {
  path: string;
  name: string;
}

const PAGES: PageTarget[] = [
  { path: '/', name: '总览' },
  { path: '/providers', name: '服务' },
  { path: '/quota', name: '额度' },
  { path: '/accounts', name: '账号' },
  { path: '/logs', name: '日志' },
  { path: '/diagnostics', name: '诊断' },
  { path: '/usage', name: '用量' },
  { path: '/gateway', name: '网关·调度快照' },
  { path: '/gateway/keys', name: '网关·密钥' },
  { path: '/settings', name: '设置' },
];

/** 已登记、待修复的 serious 违规（按页面）。 */
const KNOWN: Record<string, Array<{ id: string; why: string }>> = {
  '/': [
    {
      id: 'label-content-name-mismatch',
      why:
        'ProviderChip 按钮的 aria-label「查看 X（id）详情」与可见文本「X / id」不是同一串；' +
        'AttentionList 的 aria-label「在服务页处理 X」「查看 X 日志」不含可见文本「去服务页」「查看日志」。',
    },
  ],
  '/quota': [
    {
      id: 'aria-progressbar-name',
      why: '额度进度条（ui/progress.tsx）只有 aria-valuetext，没有可访问名，读屏只念「12%」。',
    },
  ],
  '/usage': [
    {
      id: 'link-in-text-block',
      why: '正文内联链接「网关用量」只靠颜色区分且对比度 2.05:1，未带常显下划线。',
    },
  ],
  '/gateway': [
    {
      id: 'aria-progressbar-name',
      why: '调度表「额度比」进度条无可访问名，读屏无法判断是哪个 provider 的额度比。',
    },
  ],
  '/settings': [
    {
      id: 'definition-list',
      why: '`<dl>` 直接子节点里混入了 Separator（`role="none"` 的 div），不符合 dl 内容模型。',
    },
  ],
};

function describeViolations(violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string[] }> }>): string {
  return violations
    .map(
      (v) =>
        `${v.id} [${v.impact}] ${v.help}\n` +
        v.nodes.map((n) => `  target=${n.target.join(' ')}`).join('\n'),
    )
    .join('\n');
}

for (const page of PAGES) {
  test(`axe：${page.name}（${page.path}）无严重违规`, async ({ page: pw }) => {
    await pw.goto(page.path);
    // 路由懒加载：先等页面级 h1 出现，再让异步数据/图表落位后扫描。
    await expect(pw.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(pw.locator('#main')).toBeVisible();
    await pw.waitForTimeout(400);

    const results = await new AxeBuilder({ page: pw }).withTags([...TAGS]).analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );

    const knownIds = new Set((KNOWN[page.path] ?? []).map((k) => k.id));
    const known = blocking.filter((v) => knownIds.has(v.id));
    const unexpected = blocking.filter((v) => !knownIds.has(v.id));

    // 已知缺陷也打印出来，保证报告与测试输出一致，不能"悄悄通过"。
    for (const v of known) {
      console.warn(
        `[a11y 已知缺陷] ${page.path} ${v.id} [${v.impact}] ${v.help}\n` +
          v.nodes.map((n) => `  target=${n.target.join(' ')}`).join('\n'),
      );
    }

    // 结构化输出：失败信息里带 id / impact / target，便于直接建单。
    expect(
      unexpected.map((v) => v.id),
      `发现未登记的 serious/critical 违规：\n${describeViolations(unexpected)}`,
    ).toEqual([]);
  });
}