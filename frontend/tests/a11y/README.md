# a11y 审计记录（E2E + axe）

对应实现：`e2e/a11y.spec.ts`（扫描）、`e2e/flows.spec.ts`（关键流程）。
运行：`npx vite build` → `npx playwright test`（Playwright 对 `--demo` 桥接跑 `dist/`）。

## 1. 口径

- 规则集：`wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa`，每页全量扫描。
- 失败口径：仅 `serious` / `critical` 判失败；`moderate` / `minor` 不阻塞（docs/09 §2.6）。
- 本轮随 Fluent 重构**修复了**此前的基线违规，`e2e/a11y.spec.ts` 的 `KNOWN` 已清空：
  新增 serious/critical 一律失败，不再有页面级豁免。
- 覆盖：15 个路由页 + 命令面板弹层；另外对 5 个关键页做浅色主题抽检。

## 2. 扫描结果（2026-11-25，demo 数据）

深色（默认）与浅色抽检均为 **0 serious / 0 critical**。本轮修复项：

| 页面 | 原 violation | 修复 |
|---|---|---|
| `/` 总览 | `label-content-name-mismatch` | 详情按钮改为 sr-only「查看详情」；跳转链接的 aria-label 以可见词开头（`去服务页：…` / `查看日志：…`）。 |
| 全站 | `color-contrast` | 重新校核浅/深色语义 token；11px 辅助字与状态胶囊在其染色底上全部 ≥ 4.5:1。 |
| `/settings` | `definition-list` | `<dl>` 内不再插入 Separator；分组分隔线改由 `DefRow` 的边框承担。 |
| `/` 总览 | `definition-list` / `dlitem` | 健康度 `<dl>` 改为 `div > dt/dd` 合法分组，进度条放在第二个 `<dd>` 内。 |
| `/gateway/keys`、`/reports`、`/usage` | `aria-progressbar-name` | 所有 `Progress` 都提供可访问名与 `aria-valuetext`。 |

## 3. 复核与回归

- 新增/修改页面必须同时跑：`PANEL_E2E_PORT=<free> npx playwright test --workers=1`。
- 浅色主题抽检在用例中通过 `localStorage['router-panel-theme'] = 'light'` 切换；
  token 调整后应同时验证深色与浅色，避免只修一侧。
- 如果确需临时登记缺陷，请写明 id/impact/target 与原因；修好后从 `KNOWN` 删除，
  不允许把豁免当作默认值。

## 4. 流程测试顺带发现的问题

- **URL 搜索参数被二次 JSON 编码**：日志页切换「跟随 / 行数」后 URL 是
  `?follow="0"&lines="200"`（实际请求里是 `%220%22` / `%22200%22`），而文档约定是
  `follow=1/0`、`lines=200`。解析是对称的（`parseSearch` 会再解回字符串），功能不坏，
  但复制链接/人工排查时非常费解。
  根因：TanStack Router 默认 `stringifySearch` 会把「看起来像 JSON 的字面量」字符串再 stringify 一次
  （`node_modules/@tanstack/router-core/dist/esm/searchParams.js`）。
  建议：`navigate` 时传**数字**（`follow: 1`、`lines: 200`，序列化器对 number 原样输出），
  或在 `createRouter` 配置自定义 `stringifySearch`（`new URLSearchParams` 直出）。
- 抽屉（Sheet）没有可见/隐藏标题，靠内容自身承载语义；axe 当前未判失败，但读屏播报体验偏弱，
  后续可补 `<SheetTitle class="sr-only">主导航</SheetTitle>`。