# a11y 审计记录（E2E + axe）

对应实现：`e2e/a11y.spec.ts`（扫描）、`e2e/flows.spec.ts`（关键流程）。
运行：`npx vite build` → `npx playwright test`（Playwright 对 `--demo` 桥接跑 `dist/`）。

## 1. 口径

- 规则集：`wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa`，每页全量扫描。
- 失败口径：仅 `serious` / `critical` 判失败；`moderate` / `minor` 不阻塞（docs/09 §2.6）。
- 本轮是**测试专项**，不改 `src/**`：已发现的 serious 违规登记为 `KNOWN` 基线，
  扫描时仍会 `console.warn` 打印 id / impact / target；基线之外的新违规一律失败。
  修好某条后请从 `e2e/a11y.spec.ts` 的 `KNOWN` 中删除对应项，避免把豁免变成默认值。

## 2. 扫描结果（2026-11-12，demo 数据）

| 页面 | violation id | impact | 节点数 |
|---|---|---|---|
| `/` 总览 | `label-content-name-mismatch` | serious | 21 |
| `/quota` 额度 | `aria-progressbar-name` | serious | 3 |
| `/usage` 用量 | `link-in-text-block` | serious | 1 |
| `/gateway` 调度快照 | `aria-progressbar-name` | serious | 2 |
| `/settings` 设置 | `definition-list` | serious | 1 |

`/providers`、`/accounts`、`/logs`、`/diagnostics`、`/gateway/keys` 零 serious/critical。
其余页面零 violation（含 moderate/minor）。

## 3. 违规明细与修复建议（均不改 src，仅建议）

### 3.1 `/` · `label-content-name-mismatch`（serious，21 个节点）

可见文本没有包含在可访问名里，读屏会念出与屏幕不同的文字（WCAG 2.5.3 Label in Name）。

- 9 个详情按钮：`aria-label="查看 Trae（trae-local）详情"`，可见文本是 `Trae` + `trae-local`
  两段（`ProviderChip` 是 flex 布局，textContent 实际是 `Trae\ntrae-local`）。
- 12 个 `AttentionList` 链接：`aria-label="在服务页处理 X"` / `"查看 X 日志"`，
  可见文本却是 `去服务页` / `查看日志`。

建议（`src/features/overview/ProviderTable.tsx`、`AttentionList.tsx`）：

- 详情按钮不用 `aria-label` 覆盖，改为在按钮内补一句 sr-only：
  `<span class="sr-only">详情</span>`，保留可见文本作为名称；或让 label 与可见文本逐字一致
  （`查看 Trae trae-local 详情`）。
- 链接把可见文本作为名称前缀：`aria-label="去服务页处理 X"`、`aria-label="查看日志 X"`。

### 3.2 `/quota` 与 `/gateway` · `aria-progressbar-name`（serious，3 + 2 个节点）

`ui/progress.tsx` 渲染 `role="progressbar"` 时只有 `aria-valuenow/valuetext`，没有可访问名；
读屏只念「12%」，无法知道是哪个桶 / 哪个 provider 的额度比。

建议：`Progress` 增加可选 `label` prop 透传 `aria-label`，调用方传入
`额度占用：加购额度`、`额度比：trae-local`；或在容器上用 `aria-labelledby` 关联所在行标题。

### 3.3 `/usage` · `link-in-text-block`（serious，1 个节点）

正文里的内联链接「网关用量」只靠颜色区分，且与周围文字对比度 2.05:1（< 3:1），
`hover:underline` 不算常显样式（WCAG 1.4.1）。

建议：`src/features/usage/UsagePage.tsx` 该 `<Link>` 加常显 `underline`（`underline hover:no-underline`）。

### 3.4 `/settings` · `definition-list`（serious，1 个节点）

「桥接与运行环境」卡片把 `<Separator>`（Radix 渲染为 `div role="none"`）直接放进了 `<dl>`，
`dl` 的直接子元素只允许 `dt/dd/div/script/template` 分组，`role="none"` 的 `div` 不符合内容模型。

建议：把 `<Separator>` 移出 `<dl>`，或拆成两个 `<dl>`；也可用 `aria-hidden` 的
`<div role="presentation">` 包裹仍需保留视觉分隔的场景（最省事的是移动位置）。

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