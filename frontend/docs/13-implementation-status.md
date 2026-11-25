# 13 实现状态

状态：**MVP 已实现 · Fluent 2 视觉重构完成**
更新日期：2026-11-25
对应需求：全部（追踪见 [02 产品需求](02-requirements.md)）

本文记录 `frontend/` 网页面板的真实进度、验证结果与已知差距。**只描述已经存在的东西**。

## 1. 阶段总览

| 阶段 | 目标 | 状态 |
|---|---|---|
| 设计基线 | 调研、需求、界面、契约、安全、测试、计划全部成文 | ✅ 已完成 |
| P0 | 工程骨架与匿名原型（Vite + React 19 + 组件库 + 桥接 `--demo`） | ✅ 已完成 |
| P1 | 真实只读仪表盘（总览/服务/额度/账号/日志/诊断/用量） | ✅ 已完成 |
| P2 | 安全控制能力（写操作、确认、任务状态机、只读拦截） | ✅ 已完成 |
| P3 | 网关页与体验完善（调度、用量、降级链、密钥、免费供应商、本地应答） | ✅ 已完成 |
| P4 | 测试、可访问性、部署与发布 | ✅ 基础完成（见 §3/§4） |
| P5 | Fluent 2 视觉重构、报表页、图表组件与 axe 清零 | ✅ 已完成（2026-11-25） |
| P6 | provider 覆盖扩到 13 家 + 网关、矩阵/用量/额度/报表打磨、真实只读 E2E | ✅ 已完成（2026-11-25） |

## 2. 已交付代码

### 2.1 前端（`src/`）

| 模块 | 内容 |
|---|---|
| `src/app/` | Fluent 外壳（240px 三组侧栏/顶栏/移动 Sheet）、TanStack Router 路由树（15 页）、命令面板（⌘/Ctrl+K）、任务中心、QueryClient、主题/对比度接入、LiveBadge |
| `src/lib/` | 领域契约（Zod）、API 客户端（envelope + `x-panel-token`）、TanStack Query hooks、SSE、写操作任务中心、格式化、脱敏、Provider 分类色、主题（含 high contrast） |
| `src/styles/index.css` | Fluent 2 token 层 + shadcn 兼容映射 + `.mica/.acrylic/.layer-*` + focus/motion/reduced-motion |
| `src/components/ui/` | shadcn 风格原语：Button/Badge/Card/Input/Label/Separator/Skeleton/Table/Tabs/Tooltip/Dialog/Sheet/DropdownMenu/Select/Switch/Progress/ScrollArea/Empty/Toaster |
| `src/components/shared/` | PageHeader、状态徽标与漂移、MetricCard（spark/trend/density）、`Surface/Layer/SectionHeader/Toolbar`、`Sparkline/RingGauge`、`LiveBadge`、QuotaBar、ConfirmDialog、ActionButton、DataState、LogView、ProviderSelect |
| `src/features/overview/` | 总览：4 KPI、服务拓扑、7 列 provider 矩阵、宽屏右栏（健康/额度/用量趋势/待处理）、详情抽屉；删除重复 `SummaryStrip`，底部改用一条紧凑 `UsageOverviewStrip`（`KpiCards.tsx`）；`DataSourceBar` 区分失败/旧数据，`UsageTrendPanel` 区分加载/失败/空；只读 |
| `src/features/providers/` | 服务：启停/保留客户端/重启/仅启用/关闭/同步/全开全关；网关叠加层特殊处理 |
| `src/features/quota/` | 额度：provider 卡片（`items-start`，短卡不被等高拉长）、`ProviderChip compact`、额度环形 gauge、重置日/倒计时、WorkBuddy 凭证天数、签到只读、筛选/排序 |
| `src/features/accounts/` | 账号：池状态、dry-run→切换、恢复整池、登录/添加账号等待外部终端 |
| `src/features/logs/` | 日志：快照 + SSE 跟随、过滤、行数、暂停/继续、URL 状态 |
| `src/features/diagnostics/` | 诊断：环境、doctor 文本、健康检查、显式真实试打 |
| `src/features/usage/` | 用量：6 KPI、双模式活动图、Token 构成环、工具可靠性、缓存效率（`cacheRatioText()`：>1 用倍数、≤1 用百分比、input=0 显示 `—`）、模型表排序、CSV 导出 |
| `src/features/reports/` | 报表：五源摘要、结论、KPI、趋势/Top、网关快照、Provider 矩阵、额度告警、CSV/JSON/打印 |
| `src/features/gateway/` | 网关六子页：调度 lane、用量双轴/Token 图、降级链阶梯、密钥/免费供应商/本地应答卡片 |
| `src/features/settings/` | 设置：主题三态、对比度（标准/高对比，"当前对比度"行，支持 `prefers-contrast`）、本机偏好、连接与环境、刷新策略、运行模式说明；顶栏菜单仍可切换 |

### 2.2 桥接（`server/`，零依赖 Node ESM）

`index.mjs`（HTTP 路由/静态站点/token 注入/写队列）、`cli.mjs`（参数数组 spawn）、
`normalize.mjs`（CLI→领域模型 + drift/overlay + usage models 归一化）、`gateway.mjs`（代理 8785）、
`demo.mjs`（匿名数据）、`redact.mjs`、`sse.mjs`、`dev.mjs`（并行拉起桥接与 Vite）。
`PROVIDER_IDS` 为 13 家反代，`ACTION_PROVIDER_WHITELIST` 为这 13 家 + `gateway`。

### 2.3 测试与工程

`tests/`（单元、契约、fixtures、桥接集成、provider 白名单/覆盖、真实模式冒烟）、
`e2e/`（Playwright demo 全页面 + `real.spec.ts` 真实只读）、`fixtures/`（匿名 JSON）、
`vite.config.ts`、`playwright.config.ts`、`tsconfig.json`。

## 3. 验证结果（本机实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 错误 |
| 单元 + 契约 + 组件 | `npm test` | ✅ 27 passed + 1 skipped 文件；**269 passed + 3 skipped** 用例；0 failed |
| 生产构建 | `npm run build` | ✅ 通过（`tsc --noEmit && vite build`） |
| E2E（demo） | `PANEL_E2E_PORT=8892 npx playwright test --workers=1` | ✅ **103 passed / 9 skipped / 0 failed**（real.spec 按设计跳过） |
| E2E（真实只读） | `PANEL_E2E_REAL=1 PANEL_E2E_PORT=8894 npx playwright test e2e/real.spec.ts --workers=1` | ✅ **9 passed / 0 failed**；只读，不点写操作 |
| axe（深色） | Playwright + axe | ✅ 15 路由页 + 命令面板 **0 violation** |
| axe（浅色） | Playwright + axe | ✅ 5 页抽检 **0 violation** |
| 响应式 | 375/768/1440 × 8 关键页 | ✅ `scrollWidth - clientWidth <= 1`（实际全 0） |

桥接自测（demo）：`/api/env`、`/api/providers`、`/api/accounts`、`/api/quota`、
`/api/usage`、`/api/gateway/*`、`/api/health-check` 均返回合法 envelope；`/api/doctor`、
`/api/logs` 为 `text/plain`；非回环 Host 被拒；真实/只读模式写操作被拦。

Playwright demo 使用 `--demo` 桥接（`node server/index.mjs --demo --port <PANEL_E2E_PORT>`），
不 spawn 进程、不读真实文件；截图存 `frontend/test-results/screenshots/`（24 张，已 gitignore）。
真实模式用 `node server/index.mjs --read-only --port 8894` + `PANEL_E2E_REAL=1`，是本地人工/验收链路，
不替代 demo 的确定性 CI，也不在公共 CI 跑真实凭证。

### 3.1 真实模式发现并修复的契约 bug

真实 `opencode` 的 `stats.models[]` 是嵌套 `{ model: { id, providerID, variant }, steps, tokens, cost }`；
demo 夹具长期使用扁平 `{ id, providerID, steps, ... }`，桥接此前原样透传，导致 `/api/usage` 在真实
模式下被 Zod 判为 `CONTRACT_INVALID`。`normalize.mjs` 的 `normalizeUsageModels()` 现在同时接受两种形状，
按 `providerID/id` 合并 variant（steps/cost/tokens 逐字段相加），空 id 丢弃；`tests/usage-normalize.test.ts`
覆盖嵌套、扁平、variant 合并与空 id。

### 3.2 真实只读 API 样例（本机，2026-11-25）

以下数字随使用变化，**不是固定契约**，只说明真实链路已打通：

- `/api/providers`：14 条（13 反代 + `gateway`），标题含千问办公/百度搭子/WPS 灵犀/有道龙虾。
- `/api/quota`：13 行来源、8 个来源 `available`、`fetchedAt` 存在。
- `/api/usage?range=7d`：sessions=19、steps≈1.7 万、tokens≈1.05 亿、工具成功率 99.3%、28 个模型（variant 已合并）。
- `/api/gateway/usage?days=7`：733 请求 / 0 错误 / 5 家上游；调度快照 13/16 在线（16 含 ollama/lmstudio/llamacpp 三个本地端点）。

## 4. 已验证的安全边界

- 桥接只监听回环；`Host` 校验防 DNS rebinding。
- 生产模式要求 `x-panel-token`（注入 `index.html`，不落盘、不写日志、不进 URL）。
- 命令一律参数数组 spawn；后台启动带 `--no-login`；provider id 白名单为十三家 + `gateway`。
- `--read-only` / `--demo` 在桥接层拦截写操作。
- 日志/任务输出剥离 ANSI/OSC 控制序列并脱敏常见密钥，且有界。
- JSON 不返回 token/PAT/Authorization/session/提示词正文；账号标识已掩码。

## 5. 已知差距与后续

| 项 | 现状 | 后续 |
|---|---|---|
| 网关密钥清单 | 后端暂无 `--json` 列表端点，页面优雅降级为终端命令提示 | 后端补 `GET /api/gateway/keys` 后自动启用表格 |
| 签到 | 无统一 CLI 命令，额度页只读展示可领取状态 | 后端统一签到命令后接入 |
| 结构化健康 | `health.mjs` 仅文本，诊断页展示清理后文本 | 落地 `--json` 后切结构化 |
| 报表网关窗口 | 网关按自然日分片且桥接上限 90 天，`range=all` 只能覆盖近 90 天 | 后端支持更长分片或聚合端点后放开 |
| 首屏体积 | 路由级 lazy 已启用；Recharts 仍占较大 chunk | 继续手动 vendor chunk / 评估图表按需加载 |
| React Compiler | 未启用 | 后续评估 |
| 打印导出 | 报表页内联 `@media print`，未做服务端 PDF | 后续按需生成 PDF |
| 真实只读 E2E | `real.spec.ts` 需本机真实凭证与 8894 只读桥接，默认跳过 | 保持本地人工/验收链路，不把真实账号放进公共 CI |
| 真实主机远程访问 | 明确不做 | 需要认证/授权/TLS 设计后再议 |

已从差距中移除：类型检查错误、axe 的 serious/critical 违规（`KNOWN` 已清空）、高对比主题
（已实现 normal/high 两档）。

## 6. 下一步（建议）

1. 继续拆 Recharts/vendor chunk，把首屏压到 <200KB gzip。
2. 后端增量：`/api/gateway/keys`、`health.mjs --json`、统一签到命令。
3. 补齐人工读屏矩阵（NVDA/VoiceOver）与 `forced-colors` 验证（11 文档）。
4. 报表打印/PDF 与更长网关窗口的后端支持。
5. CI：`npm ci`、`typecheck`、`vitest`、`vite build`、`playwright`（demo，无凭证）。