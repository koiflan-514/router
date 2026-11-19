# 13 实现状态

状态：**MVP 已实现**
更新日期：2026-11-12
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
| P4 | 测试、可访问性、部署与发布 | ✅ 基础完成（见 §4） |

## 2. 已交付代码

### 2.1 前端（`src/`）

| 模块 | 内容 |
|---|---|
| `src/app/` | 应用外壳（侧栏/顶栏/移动抽屉）、TanStack Router 路由树、命令面板（⌘/Ctrl+K）、任务中心、QueryClient、主题接入 |
| `src/lib/` | 领域契约（Zod）、API 客户端（envelope + `x-panel-token`）、TanStack Query hooks、SSE、写操作任务中心、格式化、脱敏、Provider 分类色、主题 |
| `src/components/ui/` | shadcn 风格原语：Button/Badge/Card/Input/Label/Separator/Skeleton/Table/Tabs/Tooltip/Dialog/Sheet/DropdownMenu/Select/Switch/Progress/ScrollArea/Empty/Toaster |
| `src/components/shared/` | PageHeader、状态徽标与漂移、MetricCard、QuotaBar、ConfirmDialog、ActionButton、DataState、LogView、ProviderSelect |
| `src/features/overview/` | 总览：四态汇总、漂移、详情抽屉、近 7 天用量 KPI、异常入口 |
| `src/features/providers/` | 服务：启停/保留客户端/重启/仅启用/关闭/同步/全开全关；网关叠加层特殊处理 |
| `src/features/quota/` | 额度：三层分组、WorkBuddy 凭证天数、签到只读、来源时间 |
| `src/features/accounts/` | 账号：池状态、dry-run→切换、恢复整池、登录/添加账号等待外部终端 |
| `src/features/logs/` | 日志：快照 + SSE 跟随、过滤、行数、暂停/继续、URL 状态 |
| `src/features/diagnostics/` | 诊断：环境、doctor 文本、健康检查、显式真实试打 |
| `src/features/usage/` | 用量：四 KPI、Recharts 每日活动、模型表 + 详情、范围切换 |
| `src/features/gateway/` | 网关六子页：调度/用量/降级链/密钥/免费供应商/本地应答 |
| `src/features/settings/` | 设置：主题、本机偏好、连接与环境、刷新策略、运行模式说明 |

### 2.2 桥接（`server/`，零依赖 Node ESM）

`index.mjs`（HTTP 路由/静态站点/token 注入/写队列）、`cli.mjs`（参数数组 spawn）、
`normalize.mjs`（CLI→领域模型 + drift/overlay）、`gateway.mjs`（代理 8785）、`demo.mjs`
（匿名数据）、`redact.mjs`、`sse.mjs`、`dev.mjs`（并行拉起桥接与 Vite）。

### 2.3 测试与工程

`tests/`（单元、契约、fixtures、桥接集成、真实模式冒烟）、`e2e/`（Playwright 全页面）、
`fixtures/`（匿名 JSON）、`vite.config.ts`、`playwright.config.ts`、`tsconfig.json`。

## 3. 验证结果（本机实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | ✅ 0 错误（含 `src`/`server`/`tests`/`e2e`） |
| 单元 + 契约 | `npx vitest run` | ✅ 6 文件 / **92 passed**，3 skipped（真实模式默认跳过） |
| 桥接契约（demo） | `npx vitest run tests/bridge-integration.test.ts` | ✅ 15/15：13 个端点全部通过真实 zod schema |
| 真实模式只读冒烟 | `PANEL_REAL_SMOKE=1 npx vitest run tests/bridge-real.test.ts` | ✅ 3/3：真实 `router.mjs list/account --json` 与 doctor |
| 生产构建 | `npx vite build` | ✅ 成功；`dist/index.html` + CSS 38KB + JS 1.19MB（gzip 356KB） |
| E2E（demo） | `npx playwright test` | ✅ **13/13**：九页 + 网关子页渲染、命令面板、无控制台错误 |

桥接自测（demo）：`/api/env`、`/api/providers`、`/api/accounts`、`/api/quota`、
`/api/usage`、`/api/gateway/*`、`/api/health-check` 均返回合法 envelope；`/api/doctor`、
`/api/logs` 为 `text/plain`；非回环 Host 被拒；真实/只读模式写操作被拦。

## 4. 已验证的安全边界

- 桥接只监听回环；`Host` 校验防 DNS rebinding。
- 生产模式要求 `x-panel-token`（注入 `index.html`，不落盘、不写日志、不进 URL）。
- 命令一律参数数组 spawn；后台启动带 `--no-login`；provider id 白名单。
- `--read-only` / `--demo` 在桥接层拦截写操作。
- 日志/任务输出剥离 ANSI/OSC 控制序列并脱敏常见密钥，且有界。
- JSON 不返回 token/PAT/Authorization/session/提示词正文；账号标识已掩码。

## 5. 已知差距与后续

| 项 | 现状 | 后续 |
|---|---|---|
| 网关密钥清单 | 后端暂无 `--json` 列表端点，页面优雅降级为终端命令提示 | 后端补 `GET /api/gateway/keys` 后自动启用表格 |
| 签到 | 无统一 CLI 命令，额度页只读展示可领取状态 | 后端统一签到命令后接入 |
| 结构化健康 | `health.mjs` 仅文本，诊断页展示清理后文本 | 落地 `--json` 后切结构化 |
| 首屏体积 | JS 1.19MB（gzip 356KB），Vite 提示 >500KB | 路由级代码分割 / 手动 chunk（Recharts 较大） |
| React Compiler | 未启用 | 后续评估 |
| 高对比主题 | 未实现 | 后续 |
| 真实主机远程访问 | 明确不做 | 需要认证/授权/TLS 设计后再议 |

## 6. 下一步（建议）

1. 路由级 lazy + 手动 vendor chunk，把首屏压到 <200KB gzip。
2. 组件测试补齐：确认框默认焦点、只读禁用、stale 渲染（09 文档已列用例）。
3. 后端增量：`/api/gateway/keys`、`health.mjs --json`、统一签到命令。
4. axe 自动化 + 人工读屏矩阵（11 文档）。
5. CI：`npm ci`、`typecheck`、`vitest`、`vite build`、`playwright`（demo，无凭证）。