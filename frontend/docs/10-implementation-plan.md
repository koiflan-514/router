# 10 实施计划

状态：设计基线  
当前进度：文档阶段已完成，实现未开始  
原则：先契约与只读，再控制与诊断，最后网关页与发布

本文是 `frontend/` 网页面板的实施计划：阶段划分、任务清单、依赖、验收、目录骨架、需求追踪、
变更控制与完成定义。**本阶段只写文档，不创建任何代码。** 阶段口径与
[13 实现状态](13-implementation-status.md) 一致，页面、路由、契约、token 与安全边界以
[00 设计基线](00-design-baseline.md) 为唯一事实来源，目录与模块继承自 [04 技术架构](04-architecture.md)，
并沿用 `tui/docs/10-implementation-plan.md` 的"阶段化 + 变更控制 + 完成定义"写法。

每个阶段必须通过验收后才能扩大下一阶段范围。P1 不追求视觉完美，但**只读不写**与**契约校验**
不能延期；P2 不追求全部交互打磨，但**只读拦截**、**危险确认**与**写任务串行**不能延期。

## 1. 阶段总览

| 阶段 | 目标 | 核心交付 | 能否使用真实写操作 |
|---|---|---|---|
| 设计基线 | 调研、需求、界面、契约、安全、测试、计划全部成文 | 本套文档（本目录） | 否 |
| P0 | 工程骨架与匿名原型（Vite + React 19 + 桥接 `--demo`） | 单包工程、布局外壳、九页占位、fixtures | 仅模拟 |
| P1 | 真实只读仪表盘（总览/服务/额度/账号/日志/诊断/用量） | 桥接只读端点、Zod 契约、Query 策略、七页真实数据 | 否 |
| P2 | 安全控制能力（写操作、确认、任务状态机、只读拦截） | `POST /api/actions`、SSE 任务流、确认框、账号切换与登录 | 是，显式确认 |
| P3 | 网关页与体验完善（调度、密钥、降级链、免费供应商、本地应答） | 网关嵌套路由、健康结构化、命令面板、主题完善 | 仅 `models/refresh` |
| P4 | 测试、可访问性、部署与发布 | Vitest/RTL/MSW/Playwright、axe、CI、部署与发布清单 | 发布验证，不跑真实写 |

与 [13 实现状态 §1](13-implementation-status.md) 的六行总览完全对应；状态标注在那儿维护，
本文件只定义阶段内含。总览中"能否写"指该阶段**允许**触达的最高副作用等级，不代表默认执行。

## 2. 设计基线（已完成）

### 任务

1. 网上浏览器控制台与前端技术栈调研（React 19、TanStack、shadcn/ui、Vercel AI Gateway、LiteLLM）。
2. 盘点后端事实：`router.mjs list/account/logs/doctor --json`、网关 5 个 HTTP 端点、网关 CLI 子命令、数据文件位置。
3. 固定技术栈、桥接服务、端口（`8792` / dev `5173`）与信息架构（九页 + 网关嵌套路由）。
4. 复用 `tui/docs/` 的页面划分、状态口径、安全边界，形成网页面板基线。
5. 成文：00–14 文档，含需求编号段落、桥接契约、术语表与测试策略。

### 依赖

- 现有 `router.mjs`、`gateway/`、`tui/` 的既有语义与契约；无任何前端代码依赖。

### 验收

- [00 设计基线](00-design-baseline.md) 的页面 ID、路由、契约、token 已被其余文档引用，无冲突。
- 需求编号段落（FR-101…199、NFR-101–110）已固定，供本文件追踪。
- 明确列出待拍板项（00 §15）与后端最小增量（00 §13）。

### 明确不做

- 不写任何实现代码、不改根目录与 `tui/`、`gateway/` 的行为。

## 3. P0：工程骨架与匿名原型

### 目标

在 `frontend/` 内建立**单包**工程骨架，用一个**不 spawn 任何进程、不读任何真实文件**的桥接
`--demo` 加匿名 fixtures，把九页布局、导航、通用组件与测试骨架全部跑通。

### 任务

1. 建立 `frontend/` 单包：`package.json`（`private:true`、`type:module`）、`tsconfig`、Vite 配置，锁定 React 19 / TypeScript / Tailwind / shadcn 版本。
2. 初始化 Tailwind + shadcn（base 风格 + Radix 原语），把 [00 §10](00-design-baseline.md) 的语义色落为 CSS 变量，接入 dark/light/system `ThemeProvider`。
3. 引入 TanStack Router 文件式路由与根布局外壳（左侧固定导航 + 常驻顶栏），按 00 §5 生成九页占位路由与 `gateway` 嵌套子路由占位。
4. 引入 TanStack Query（`QueryClient` 默认值、query key 约定、`document.hidden` 暂停轮询的钩子骨架）。
5. 建立桥接最小服务 `frontend/server/`：监听 `127.0.0.1:8792`、统一 envelope `{schemaVersion:1,generatedAt,ok,data?,error?}`、`GET /api/health`、`--demo` 开关。
6. 落地匿名 fixtures：覆盖 providers / accounts / quota / logs / usage / gateway，全部虚构值，不含真实 token、用户名或本机绝对路径。
7. 建立通用组件骨架：状态徽标、`Resource<T>` 四态渲染（加载 / 空 / 失败 / stale）、空状态、错误边界、确认框骨架。
8. 建立测试骨架：Vitest + RTL + MSW 组件冒烟；Playwright 九页可达冒烟。
9. 编写 `frontend/README.md` 运行说明（dev/build/start/`--demo`）与端口约定。

### 依赖

- 文档 02、03、04、05、06、07、09。
- 本机 Node.js（≥ 20）可用；**不依赖**真实 router root、账号或网关。

### 验收

- `npm install`、`npm run dev`、`npm run build` 通过，类型检查与 lint 干净。
- 九页与网关子页路由可导航，空数据下不崩溃；布局在窄屏可降级。
- `--demo` 模式**不 spawn 任何进程、不访问任何真实文件**。
- 暗色为默认，可切 light/system；`prefers-reduced-motion` 生效。
- 未知与失败显示 `—`，**不显示假 0**。
- 组件冒烟与 E2E 冒烟在本地通过。

### 明确不做

- 不接入真实 CLI 或网关；不实现任何写操作；不实现 SSE 真实流。
- 不实现图表真实数据、命令面板、国际化双语、CI 与部署自动化。

## 4. P1：真实只读仪表盘

### 目标

让桥接以**只读**方式接入真实数据源，把总览 / 服务 / 额度 / 账号 / 日志 / 诊断 / 用量七页
变成可用仪表盘，并用 Zod 契约保证前后端 schema 一致。

### 任务

1. 桥接只读端点：`GET /api/providers`、`/api/accounts[?provider]`、`/api/accounts/check`、`/api/quota[?provider&refresh]`、`/api/logs?provider=&lines=`、`/api/logs/stream?provider=`（只读 SSE 跟随）、`/api/env`、`/api/doctor`、`/api/health-check[?provider][&probe=false]`、`/api/usage?range=24h|7d|30d|all`。
2. 命令映射（参数数组 spawn，禁止 shell 拼接）：`node router.mjs list --json`、`account --json`、`account check --json`、`logs <id> <lines>`、`doctor`；`node scripts/health.mjs --no-probe`（文本）；额度优先网关 `GET /v1/gateway/balance`，缺失再回退 CLI。
3. Zod 契约：为 00 §6 每个领域模型定义 schema，桥接入站/出站双向校验；校验失败归为契约错误，不静默降级。
4. 输出处理：`server/redact.mjs` 统一剥离 ANSI/OSC 控制序列并脱敏常见密钥，日志/任务输出有界（≤ 2000 行）。
5. TanStack Query 策略：按 00 §8 落地 `staleTime`/`refetchInterval`、`document.hidden` 暂停与回补、手动刷新、单数据源失败隔离，`Resource<T>` 由查询结果推导。
6. 页面：总览（八家 + `drift` 徽标 + KPI）、服务（只读状态 + 端口/PID/模型数）、额度（bucket / 凭证天数 `days` / `resetDate` / `fetchedAt`）、账号（分组只读 + `active`/`health`）、日志（provider/行数 + 只读跟随）、诊断（`doctor` 文本 + health 文本 + 退出码）、用量（OpenCode 会话 / Token / 工具 / 模型聚合）。
7. 常驻顶栏：工作范围（local/demo）、桥接与网关可达性、各数据源最后成功时间。
8. 失败与边界：局部失败、空状态、全局后端失败、只读模式、demo 模式全链路 harness。
9. 测试：MSW 契约测试 + 假 CLI fixture 集成测试（Windows/Linux 均可跑）。

### 依赖

- P0 完成。
- `router.mjs list/account --json` 已实现；网关 `status/usage/balance` 已实现。
- `scripts/health.mjs` **仅有文本**：诊断页允许展示清理后的文本，**禁止正则解析生成结构化字段**。

### 验收

- 启动与自动刷新**不执行任何写命令、不登录、不签到、不真实试打**。
- 八家真实只读数据可显示，单家失败不影响其他来源。
- `null` / 加载失败 / 未查询 / 真实 `0` 四态区分正确；未知显示 `—`。
- 慢查询不阻塞交互，旧响应不覆盖新状态；窗口不可见时暂停轮询。
- 日志与诊断文本已清理控制序列并脱敏，行数有界。
- `--demo` 与真实模式走**同一套** Zod schema，schema 不符即报契约错误。

### 明确不做

- 任何写操作（含账号切换预览）；真实试打与签到；把文本健康正则化为结构化字段；跨家额度汇总或排行榜。

## 5. P2：安全控制能力

### 目标

在**写操作**上接入 React 19 Actions 与桥接任务状态机，让启停/开关/同步/账号切换可控、可确认、
可回滚，并在桥接层强制只读拦截与写任务串行。

### 任务

1. `POST /api/actions`：接收 `{action, providerIds, accountKey?}`，返回 `actionId`；`GET /api/actions/:id`；`GET /api/actions/stream`（SSE）推送 `Task`。
2. 后端任务状态机：写任务**全局串行**队列、同目标重复提交去重、输出有界、`status` 与 `refreshStatus` 分离（`pending→confirmed/failed`）。
3. 只读拦截：`--read-only` 与 `--demo` 在**桥接层**拒绝所有写请求（403），不靠前端隐藏按钮。
4. Action → 命令映射：`up/on/all/restart` **必须带 `--no-login`**；`down <id> --keep-oc`；`account <id> <key> --dry-run --json`（预览）；`account <id> <key> --json`（切换）；`account <id> --all --json`（恢复整池）。
5. 前端 React 19 Actions：`useActionState` / `<form action>` / `useOptimistic`；**pending 不预改状态**，完成后重新查询，仅在确认后更新 UI。
6. 确认模型：`normal`（up/down/keep-oc/restart/off/sync）与 `high`（on/all/none、恢复整池）两级；高风险**列出受影响名单**，默认焦点"取消"。
7. 账号页写能力：dry-run 预览（不写状态）→ 正式切换 → 恢复整池；操作后失效并重新查询账号/服务/额度。
8. 交互式登录：`login` / `account add` 由桥接**只发起并等待**，UI 进入"等待外部终端完成"状态，提示用户在原生终端完成，可取消；桥接不读取也不保存用户输入。
9. 活动任务与退出保护、失败任务的输出查看。

### 依赖

- P1 完成（只读资源与 Query 策略已就绪）。
- 00 §9 的写操作模型；07 安全与 05 契约的确认/拦截细节。

### 验收

- 连点与键盘重复**不产生重复写操作**（去重 + 全局串行）。
- `on` / `all` / `none` 明确列出其他受影响 provider 名单；文案准确说明客户端影响。
- dry-run 不写状态；正式切换后才刷新账号/服务/额度；`refreshStatus` 区分"成功未确认"与"失败"。
- `--read-only` 下所有写端点返回 403 且**无副作用**。
- 后台启动类命令一律 `--no-login`，不自动打开浏览器。
- 登录成功/取消/失败后 UI 均回到可操作状态。
- 所有人工写测试能恢复到测试前状态。

### 明确不做

- 网关写端点（`models/refresh` 归 P3）；命令面板；多用户/远程并发；并行写（保持全局串行）。

## 6. P3：网关页与体验完善

### 目标

补齐 `gateway` 页的嵌套路由与只读数据，完善健康结构化、命令面板与主题，使八家 + 网关的完整
信息架构可用。

### 任务

1. 网关嵌套路由：`/gateway`（调度快照：权重/冷却/并发/成功率/粘性）、`/gateway/usage`、`/gateway/combos`（降级链）、`/gateway/keys`、`/gateway/free`（免费供应商）、`/gateway/local-answers`。
2. 桥接网关端点：`GET /api/gateway/status|usage|balance|combos|local-answers|free`（代理 `127.0.0.1:8785`）；`POST /api/gateway/models/refresh`（本阶段唯一网关写）。
3. 健康结构化：若后端落地 `scripts/health.mjs --json`（00 §13），桥接透传结构化结果；**未落地时保持文本，禁止正则推断**。
4. 命令面板：⌘K 全局导航（页面/子页）+ 常用动作入口（只读跳转；写动作复用 P2 确认流）。
5. 主题完善：对比度、`prefers-reduced-motion`、provider 分类色稳定映射（00 §10）、窄屏抽屉侧栏。
6. 设置页：主题、刷新间隔、只读状态展示（真实只读由桥接启动参数决定）、桥接连接与演示模式。

### 依赖

- P2 完成（写确认流可复用）。
- 网关 HTTP 端点已实现；健康结构化 JSON 为**可选**前置。

### 验收

- 网关六子页 URL 可分享、可回退（URL 即状态）。
- 密钥页**只显示指纹与元数据**，绝不显示明文或提供复制明文能力。
- 免费供应商（18 家）为只读清单，**不参与 `on/off`**。
- 健康结构化缺失时字段显示 `—`，不出现推断值。
- ⌘K 可到达所有页面；`prefers-reduced-motion` 降低动效。

### 明确不做

- 修改网关调度参数（只读快照为主）；密钥明文显示/导出；跨家额度汇总。

## 7. P4：测试、可访问性、部署与发布

### 目标

把 P0–P3 的能力固化为自动化测试、可访问性验收与可复现的部署/发布流程。

### 任务

1. Vitest + RTL：通用组件与页面关键分支单元/组件测试。
2. MSW 契约测试与假 CLI fixture 集成测试：Zod schema 与 fixtures 双向校验。
3. Playwright E2E：九页 + 网关六子页可达、demo 全流程、写操作确认流（使用 demo/read-only 假后端）。
4. 可访问性：axe 扫描（WCAG 2.1 AA）+ 键盘遍历 + 焦点管理用例（对齐 11）。
5. CI（GitHub Actions）：typecheck、lint、unit、e2e（demo）、axe 全部通过；**不使用真实凭证、不执行真实写操作**。
6. 部署文档（对齐 08）：构建产物、桥接静态服务、端口、升级与回滚、故障排查。
7. 发布清单：依赖许可与预算审计（W-09）、敏感文件检查、README/帮助与实现一致。
8. 回填 [13 实现状态](13-implementation-status.md) 与 [文档索引](README.md) 的状态标注。

### 依赖

- P0–P3 完成。
- 09 测试策略与 11 可访问性文档的验收项落地。

### 验收

- CI 全绿，且**不触碰**真实账号、凭证或写操作。
- 发布包不含秘密、日志、运行时状态或本机绝对路径。
- 安装、启动、demo、真实后端、升级、回滚按文档实测通过。
- 所有声称支持的能力都有对应测试记录。

### 明确不做

- 真实凭证 CI、真实写操作 CI、遥测上传、远程多用户后端。

## 8. 计划中的代码结构（本阶段不创建代码）

以下目录用于后续实施，**本阶段不创建任何文件**；与 [04 技术架构](04-architecture.md) 的计划目录一致，
模块可按实际复杂度合并，但不能让 UI 直接拼接命令，也不能让桥接决定页面布局。

```text
frontend/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── components.json            # shadcn 约定
├── index.html
├── README.md
├── docs/                      # 本设计基线（已完成）
├── src/
│   ├── main.tsx
│   ├── router.tsx
│   ├── routes/                # TanStack Router 文件式路由（__root 为侧栏 + 顶栏外壳）
│   │   ├── __root.tsx
│   │   ├── index.tsx          # overview
│   │   ├── providers.tsx
│   │   ├── quota.tsx
│   │   ├── accounts.tsx
│   │   ├── logs.tsx
│   │   ├── diagnostics.tsx
│   │   ├── usage.tsx
│   │   ├── settings.tsx
│   │   ├── gateway.tsx        # 嵌套布局
│   │   ├── gateway.index.tsx  # 调度快照
│   │   ├── gateway.usage.tsx
│   │   ├── gateway.combos.tsx
│   │   ├── gateway.keys.tsx
│   │   ├── gateway.free.tsx
│   │   └── gateway.local-answers.tsx
│   ├── features/              # 逐页业务（overview/providers/quota/accounts/logs/diagnostics/usage/gateway/settings）
│   ├── components/
│   │   ├── ui/                # shadcn 复制组件
│   │   ├── layout/            # 侧栏、顶栏、外壳
│   │   └── common/            # 状态徽标、四态渲染、空状态、确认框
│   ├── lib/
│   │   ├── api/               # 桥接客户端 + envelope
│   │   ├── contract/          # Zod schema + 领域模型
│   │   ├── query/             # QueryClient、key、刷新策略
│   │   ├── actions/           # React 19 Actions 与任务状态
│   │   ├── sse/               # EventSource 封装
│   │   ├── format/            # 数字/时间/脱敏展示
│   │   └── theme/             # ThemeProvider
│   └── types/
├── server/                    # Node 桥接，仅监听 127.0.0.1:8792
│   ├── index.mjs              # 入口、静态服务、/api 路由
│   ├── cli.mjs                # 参数数组 spawn 与命令映射
│   ├── contract.mjs           # legacy → 领域模型 + envelope
│   ├── gateway.mjs            # 网关 HTTP 代理
│   ├── actions.mjs            # 写任务状态机 + 串行队列
│   ├── sse.mjs                # 日志/任务/事件流
│   ├── redact.mjs             # ANSI/OSC 清理 + 脱敏
│   ├── security.mjs           # token、CSRF、回环校验、只读拦截
│   └── demo/                  # --demo 匿名 fixtures
├── fixtures/                  # 匿名示例数据
└── e2e/                       # Playwright
```

## 9. 依赖关系

```text
文档 02/03/04/05/06/07/09/11（设计基线，已完成）
                 │
                 ▼
P0 工程骨架 + 桥接 --demo + 匿名 fixtures（无真实进程/文件）
                 ▼
P1 桥接只读端点 + Zod 契约 + Query 策略
   ├── providers / accounts / quota / logs / usage / env / health-check
   └── 只读日志 SSE 跟随 → 总览/服务/额度/账号/日志/诊断/用量七页
                 ▼
P2 POST /api/actions + 任务 SSE + 确认 + 只读拦截
   └── 账号 dry-run / 切换 / 恢复整池 + 交互式登录"等待外部终端"
                 ▼
P3 网关嵌套路由 + 健康结构化（可选）+ 命令面板 + 主题完善
                 ▼
P4 测试 / 可访问性 / CI / 部署 / 发布
```

后端增量依赖：`scripts/health.mjs --json`（00 §13）是 P3 健康的**可选**前置；未落地时降级为文本，
不得正则推断。额度直读优先网关 `balance`，缺失再回退 CLI（00 §13）。

## 10. 需求追踪（P0–P4 → FR 段）

| 阶段 | 主要 FR 段 | 说明 |
|---|---|---|
| P0 | FR-190–199、FR-180（骨架）、NFR-101–110 | 通用交互骨架（加载/空/错/demo/只读）、主题骨架、构建与依赖预算 |
| P1 | FR-101–109、FR-120–129、FR-130–139（只读）、FR-140–149（日志/诊断文本）、FR-160–169 | 总览与状态、额度、账号只读、日志与诊断、用量分析 |
| P2 | FR-110–119、FR-130–139（写）、FR-190（确认/去重/拦截） | 服务控制、账号切换与登录、交互通用项 |
| P3 | FR-170–179、FR-140–149（健康结构化）、FR-180–189 | 网关、健康、设置/主题/可访问性/国际化 |
| P4 | NFR-101–110、FR-180–189、全部 FR 的验收 | 测试、可访问性、部署与发布验收 |

编号定义见 [02 产品需求](02-requirements.md) 与 [00 §14](00-design-baseline.md)。每个阶段结束时须核对
本表无未解释缺口；新增 FR 先回填 02 与本表，再进入实现。

## 11. 对现有仓库的最小增量原则

- **不改** `router.mjs`、`gateway/`、`tui/` 的任何行为与契约；只通过既有命令与端点复用能力。
- 桥接只做两件事：参数数组 spawn 现有 CLI、代理现有网关 HTTP；**不复制**进程/账号/额度逻辑。
- 新增后端字段一律 **additive**（增量兼容）；改义或删除必须升 `schemaVersion`，并同步 fixtures 与测试。
- 新增文件只落在 `frontend/` 内；如需调整根 `.gitignore`/README，仅做最小条目，保持根目录"零依赖"哲学。
- 不新增守护进程、不开放非回环端口；桥接默认仅回环（00 §12）；浏览器不直连网关（W-02），一律经桥接。

## 12. 变更控制

以下变化**必须先改文档、再改实现**，并同步更新受影响的 02/03/04/05/06/07/09/11：

- 页面、路由或 provider 范围；
- 写命令映射及其副作用；
- JSON 必需字段、字段改义或 `schemaVersion`；
- 默认刷新导致的新网络/额度消耗；
- 新增凭证读取、日志持久化或任何网络上传；
- 端口、构建或部署流程；
- 跳过只读拦截、危险确认或写任务串行。

不得以"实现更方便"为由悄悄改变 `on/down` 等既有语义。需求变更需记录：原因、影响文档、测试迁移
与发布兼容性。

## 13. 实施完成定义

整个网页面板 MVP 完成需要：

- P0–P4 验收全部有记录（回填 [13 实现状态](13-implementation-status.md)）；
- 需求追踪无未解释缺口（本文件 §10 与 02 一致）；
- 00 §12 安全不变量全部通过（回环、脱敏、只读拦截、参数数组 spawn）；
- 真实 CLI 的人类输出保持可用，面板故障不破坏原配置；
- 文档不混用"计划命令"与"现有命令"；
- `frontend/README.md`、[13 实现状态](13-implementation-status.md) 与实际实现一致；
- 用户可以在不使用面板的情况下继续使用原 CLI 与 TUI。
