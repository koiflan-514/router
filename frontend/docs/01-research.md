# 01 调研与设计取舍

状态：设计基线
对应需求：—（本文只提供取舍依据，条款编号见 [02 产品需求](02-requirements.md)）
日期：2026-11-12

本文记录 `frontend/` 网页面板在设计阶段做过的两件事：**对外部产品与前端技术栈的调研**，以及
由此得出的**设计取舍**。编号、路由、契约与 token 一律以 [00 设计基线](00-design-baseline.md)
为准；本文不新增事实来源，只解释"为什么这样选"。术语继承
[`tui/docs/01-research.md`](../tui/docs/01-research.md) 与 `tui/docs/12-glossary.md`。

## 1. 调研目的与范围

**目的**：把本机八家反代（`qoder-cn, qoder, trae-local, codearts, zcode, workbuddy,
workbuddy-global, loomy`）与统一网关，做成一个**看得清、控得准、出错能定位**的浏览器控制台。

**范围边界**（决定"哪些调研结论不适用"）：

| 维度 | 本项目 | 不是 |
|---|---|---|
| 用户 | 单用户、本机、回环访问 | 多租户 SaaS |
| 角色 | 无账号体系、无 RBAC | 团队 / 组织 / 计费后台 |
| 计费 | 复用各家订阅额度，无统一货币 | 按 token 收费的 AI Gateway |
| 数据源 | CLI JSON、网关 HTTP、OpenCode 官方统计 | 自建请求遥测库 |
| 写操作 | 启停/切号/同步，全部本机进程 | 改上游配置、代管用户密钥 |

因此：调研目标是**借鉴交互与指标的组织方式**，而不是复刻一套商业 AI Gateway。凡缺少本地
数据源的能力（逐请求延迟、逐请求路由尝试、统一花费），一律标记为**不进入 MVP**，见 §5。

本轮以可公开访问的官方文档为主，仅描述核实过的界面与字段；不描述需要登录、区域受限或无法
核实的界面细节，也不声称覆盖全部厂商。

## 2. 网上产品调研

### 2.1 Vercel AI Gateway

资料：

- [Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability)
- [Request Logs](https://vercel.com/docs/ai-gateway/observability-and-spend/logs)

观察：

- **Usage 与 Logs 是两个不同职责的分面**：Usage 回答"趋势如何"，四张图为 Requests by
  model、P50 TTFT（首 token 中位延迟）、输入/输出 Token 数、Spend；Logs 回答"这一条为什么"。
- Requests 汇总按 project / API key 下钻，每行汇总含请求数、平均 tokens/s、P50 duration、
  P50 TTFT、cost；可查看范围最远 36 天。
- 日志表每行一条请求，列为 Time、Status、Model、Provider、Usage、Cost、Duration、
  Authentication；筛选是"搜索 + 多选下拉（状态/模型/provider/认证/路由/模态/请求模式/延迟/
  Token/费用）+ 时间范围"的组合。
- **每个筛选都写进 URL**，可复制地址分享同一视图；点开某行打开详情面板（ID 也进 URL），
  面板里按 provider attempt 展示路由卡片（含 TTFT、状态、provider 区域）。
- **Live 模式有三条明确限制**：只支持相对时间范围（切到 Live 会被改成"最近 1 小时"）、
  Live 期间不能向上滚动历史（需先暂停）、请求入库约有 90 秒延迟。非 Live 时滚动到底部每次
  再多加载 50 行。路由详情只保留 30 天。
- 支持导出当前筛选下的 CSV / JSON。

可借鉴：

- 总览放"四个 KPI + 时间范围"，明细放日志页，两者不混。
- 日志页的"筛选、暂停、跟随、详情面板"是**可分享的 URL 状态**，正好落到
  [00 设计基线 §5](00-design-baseline.md) 的"URL 即状态"。
- Live（跟随）必须有**显式开关**和"何时停止"的规则，不能默认无限增长。

不直接照搬：

- 本项目日志是**反代进程的 stdio 文本**，不是结构化请求事件，因此没有 Status/Provider/Cost
  等列，也没有 attempt 级路由卡片；TTFT 与 P50 均无持续采样（见 §5）。
- 没有 team/project 两层作用域，作用域等价于"选中的 provider / 网关"。
- Live 沿用 SSE 追加，但**不承诺 90 秒延迟、36 天保留**这类服务端假设。

### 2.2 LiteLLM Admin UI

资料：

- [Admin UI Quick Start](https://docs.litellm.ai/docs/proxy/ui)
- [Observability: Usage](https://docs.litellm.ai/docs/proxy/customer_usage)
- [Logs](https://docs.litellm.ai/docs/proxy/ui_logs)
- [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys)

观察：

- 管理面按**领域分面**组织：模型、Key、用户、团队、预算、限流、日志、用量各是一块，彼此
  不揉在一页。
- Usage 分面看费用趋势、模型分布、请求与 Token；Logs 分面看单条请求与错误；请求/响应正文
  **默认不保存**，需要显式开启。
- 登录是显式的多步流程：首次用环境变量（`UI_USERNAME`/`UI_PASSWORD`，或 master key）引导
  登录，随后建 `proxy_admin` 用户并 `disable_env_credential_login: true` 关掉该通道。
- 失败登录有**来源地址级限流**：同一地址 60 秒内超过 10 次错误密码则封 5 分钟（单用户名配额
  为一半）；配了 Redis 才能跨 worker 生效。

可借鉴：

- **分面 = 分页**：服务控制、额度账号、日志诊断、用量各自成页，与
  [00 设计基线 §5](00-design-baseline.md) 的页面划分一致。
- 默认不采集敏感内容；"能观测"不等于"无限收集"，与本项目"JSON 里不出现提示词正文"一致。
- 引导式登录的**分步与显式关闭**值得学：本项目的桥接 token 也是"启动时生成、注入页面"，
  只服务单用户，因此不需要 UI 账号体系。

不直接照搬：

- **不需要虚拟 Key、团队、组织、RBAC、计费数据库**——本项目单用户单机，额度归各家订阅。
- 不做"邀请用户/权限矩阵/审计日志"这类多租户能力。

### 2.3 OpenRouter Activity

引用 [`tui/docs/01-research.md`](../tui/docs/01-research.md) §2.1 既有结论（不新增未核实事实）：

- Activity 以 Spend、Tokens、Requests 为核心，支持小时/天/月/年范围，并按 Model、API Key、
  Creator 分组；路由决策综合价格、吞吐、TTFT、429、可靠性与工具调用质量。
- 可借鉴：总览只放关键指标、指标必须有时间范围与来源、provider 详情要能解释异常。
- 不照搬：本项目不是 OpenRouter 式实时智能路由，没有统一请求分析库；八家 credits 不是统一
  货币，不能合并成 Spend。此结论直接支撑 **W-06**。

### 2.4 Portkey 与 Helicone

引用 [`tui/docs/01-research.md`](../tui/docs/01-research.md) §2.4、§2.5 既有结论：

- Portkey Analytics 覆盖成本、Token、延迟、请求、Top Models、用户、错误等维度，并按服务、
  模型、metadata 聚合；错误分析区分 API 错误与被路由策略挽救的请求。
- Helicone 重点是请求级成本、延迟、错误与调试，强调"真实错误原因比装饰性图表更重要"。
- 可借鉴：**故障处理路径要短**——总览异常 → provider → 日志/诊断，三步内看到原因。
- 不照搬：两者都以请求级遥测为前提，本项目当前没有统一请求事件（见 §5）。

### 2.5 OpenCode V2 官方统计接口

引用 [`tui/docs/01-research.md`](../tui/docs/01-research.md) §2.7 结论（不新增未核实事实）：

- `GET /api/experimental/session/stats` 是**只读**官方接口，已提供会话、步骤、Token、缓存、
  每日活动、工具统计与模型聚合。
- 用量页据此采用"指标卡 + 活动趋势 + 模型/Provider 聚合"。
- `steps` 必须按 OpenCode 原义展示，**不能改名为 HTTP 请求数**（支撑 **W-06**）。

### 2.6 横向对比

| 产品 | 分面组织 | 关键指标 | 日志交互 | 与本项目的关系 |
|---|---|---|---|---|
| Vercel AI Gateway | Usage / Requests / Logs | Requests by model、P50 TTFT、Tokens、Spend | 筛选+暂停+跟随+详情，全部进 URL | **日志交互与 URL 状态主要参照**；指标因无数据源不入 MVP |
| LiteLLM Admin UI | 模型/Key/用户/团队/预算/日志/用量 | 费用趋势、模型分布、请求、Token、成功率 | 请求日志，内容默认不存 | **分面拆分与"默认不采集"参照**；多租户能力不要 |
| OpenRouter | Activity | Spend、Tokens、Requests，多时间范围 | Activity 导出 | **"总览只放关键指标"参照**；无统一货币，不合并 |
| Portkey | Analytics | 成本、Token、延迟、错误、Top Models | 错误分析 | 异常摘要与诊断入口参照 |
| Helicone | 请求级可观测 | 请求级成本/延迟/错误 | 请求详情调试 | "短故障路径"参照 |
| OpenCode V2 stats | 单一只读接口 | 会话、步骤、Token、缓存、活动、工具、模型 | 无 | **唯一真实可用的用量数据源** |

## 3. 前端技术栈调研与选型依据

### 3.1 React 19（稳定版）

资料：[React v19 官方发布说明](https://react.dev/blog/2024/12/05/react-19)。

与本项目直接相关的稳定特性：

| 特性 | 说明 | 本项目用法 |
|---|---|---|
| Actions | 异步函数进 transition，自动管理 pending / error / 乐观更新 | 所有写操作统一走 Action（见 §6 W-04） |
| `useActionState` | 返回 `[state, submitAction, isPending]` | 启停/切号等操作的 pending 与错误展示 |
| `useOptimistic` | 请求期间先渲染乐观值，结束或出错自动回退 | 仅在**明确知道结果形态**时使用；本项目纪律是"完成后再查询" |
| `use()` | 渲染期读取 Promise/Context，可条件调用 | 读取由 Suspense 支撑的资源 |
| `ref` 作为 prop | 函数组件不再需要 `forwardRef` | 组件封装更简单 |
| `<form>` Actions | `action`/`formAction` 传函数，成功后自动重置表单 | 设置页、账号切换等表单 |
| 文档 metadata | 组件内渲染 `<title>`/`<meta>`/`<link>`，自动提升到 `<head>` | 每个页面的标题 |
| 资源预加载 | `preload` / `preinit` / `preconnect` / `prefetchDNS` | 首屏字体与关键资源 |
| 更好的错误上报 | `onCaughtError` / `onUncaughtError` / `onRecoverableError` | 面板需要"出错能定位" |

**关键取舍**：React 19 的 Actions 会**自动应用乐观更新**，但本项目采用更保守的纪律——
**pending 不预改状态，完成后重新查询，只在确认后才更新 UI**（见 §6 W-04）。原因是这些操作会
真的启停进程、改 `opencode.json`，乐观展示"已启动"而实际失败会直接误导排障。

### 3.2 TanStack Query v5（服务端状态）

资料：[TanStack Query 概览](https://tanstack.com/query/latest/docs/framework/react/overview)。

- 提供缓存、同 key 请求去重、`staleTime`、后台刷新、可见性感知，与
  [00 设计基线 §8](00-design-baseline.md) 的刷新策略一一对应。
- 天然映射 TUI 的 `Resource<T>`：`data` ↔ 最近成功、`error` ↔ 最近失败、`stale` ↔ 有旧数据
  且最近刷新失败或超阈值。
- 选它而不是自造 `useEffect + setState` 轮询：本项目有 8 家 × 多资源要按不同间隔刷新，自造
  轮询会重复处理去重、竞态与 `document.hidden` 暂停。

### 3.3 TanStack Router（search 参数即状态）

资料：[Search Params](https://tanstack.com/router/latest/docs/framework/react/guide/search-params)。

- 搜索参数被解析为 **JSON 结构**（首层仍与 `URLSearchParams` 兼容），支持数组/对象/布尔/数字。
- `validateSearch` 做校验与类型收敛；官方给出 Zod 适配器，可直接用 `.catch()` 给默认值而不是
  抛错——**URL 是用户可手改的输入，非法值应回退到默认而不是白屏**。
- 继承：子路由可读取父路由的 search 参数，正好服务 `/gateway/*` 嵌套路由。
- 这直接支撑 **W-03**：选中 provider、时间范围、日志过滤、表格排序都可分享、可回退、可刷新
  保持。

### 3.4 Tailwind CSS + shadcn/ui

资料：[shadcn/ui Vite 安装](https://ui.shadcn.com/docs/installation/vite)、
[Dark Mode](https://ui.shadcn.com/docs/dark-mode)、[Charts](https://ui.shadcn.com/charts/area)。

- 组件是**复制进仓库的源码**（Registry + CLI），不是运行时依赖：可读、可改、无需自造轮子，
  与 **W-09**"依赖有预算上限"相容。
- 基础风格为 `base`，组件覆盖 Button、Card、Table、Data Table、Dialog、Sheet、Sidebar、
  Tabs、Badge、Skeleton、Toast、Command、Chart 等，与 [00 设计基线 §5](00-design-baseline.md)
  的页面元素对得上。
- Charts 基于 Recharts 且与主题 token 打通，面积/柱/折线满足用量与网关页。
- Dark Mode 用 CSS 变量 + `dark` class；Vite 下按官方 ThemeProvider 模式实现
  dark/light/system，落在 [00 设计基线 §10](00-design-baseline.md) 的语义色。
- **不照搬**：Blocks 里的营销/后台模板与本站信息架构无关，只取组件与布局原语。

### 3.5 选型汇总

| 关注点 | 选择 | 备选 | 不选的理由 |
|---|---|---|---|
| 框架 | React 19 稳定版 | React 18 | 用户指定；Actions/`use()`/表单 Actions 直接服务写操作 |
| 构建 | Vite + TypeScript | Next.js | 无 SSR/多租户需求；单页 + 本地桥接更简单 |
| 路由 | TanStack Router | React Router | 一等 citizen 的 search 参数即状态 + 类型安全 |
| 数据 | TanStack Query v5 | SWR / 自造轮询 | 去重/后台刷新/可见性暂停开箱即用 |
| UI | Tailwind + shadcn/ui + Radix | MUI / Ant Design | 源码进仓库、可改、无障碍原语由 Radix 提供 |
| 图表 | Recharts（shadcn chart） | ECharts | 与 shadcn 主题 token 一致，体量更小 |
| 表格 | TanStack Table（shadcn Data Table） | AG Grid | 排序/筛选/虚拟滚动够用且可控 |
| 校验 | Zod | 手写 type guard | 契约运行时校验与 search 参数校验复用同一套 |

## 4. 本地能力盘点

事实来源为 [00 设计基线 §3](00-design-baseline.md)，本节只做"哪些能直接喂给页面"的归纳，
不重复定义字段。

| 数据源 | 形态 | 覆盖页面 |
|---|---|---|
| `node router.mjs list --json` | `schemaVersion:1`，含开关/进程/PID/端口/模型数/opencode/认证 | 总览、服务 |
| `node router.mjs account [id] --json` | 账号池与当前生效账号 | 账号 |
| `node router.mjs account check --json` | 含 `health.level/notes` | 账号、诊断 |
| `node router.mjs logs <id> <lines>` | **人类文本** | 日志（经脱敏与有界裁剪） |
| `node router.mjs doctor` | 人类文本 + 退出码 | 诊断 |
| `scripts/health.mjs --no-probe` | 人类文本，**暂无 JSON** | 诊断（仅展示文本，不得正则解析成结构化字段） |
| `POST /api/actions`（计划）→ 包装 `up/down/on/off/all/none/restart/sync/account …` | 桥接 spawn CLI | 服务、账号 |
| 网关 `GET /v1/gateway/{status,usage,balance}` | JSON | 网关 |
| 网关 CLI `gateway status/usage/balance/doctor/combo/local/key/providers` | JSON / 文本 | 网关 |
| OpenCode `GET /api/experimental/session/stats` | JSON 只读 | 用量 |

三条硬约束（来自 §3，本文不重复论证）：**网关无 CORS**，浏览器不得直连；**交互式动作**
（`login`、`account add`）浏览器接管不了 stdin，桥接只发起并等待；**后台执行
`up/on/all/restart` 必须带 `--no-login`**，禁止自动打开浏览器。

## 5. 综合差距表

| 目标 | 当前数据 | 设计处理 | 是否 MVP |
|---|---|---|---|
| 八家服务状态（开关/进程/客户端/认证） | `list --json` 已有 | 直接接入，漂移由后端字段推导 | ✅ |
| 账号池与当前账号 | `account --json` 已有 | 直接接入，写操作后重新查询 | ✅ |
| 额度与凭证天数 | 网关 `balance` + 各家 CLI，能力不一 | 分来源展示，`days` 不并入 credits | ✅ |
| 签到状态 | 各家能力不同 | 按能力展示，未支持显示 `—` | ✅ |
| 日志排障 | 进程 stdio 文本 | SSE 跟随 + 筛选 + 暂停 + 脱敏；**只展示文本** | ✅ |
| 网关调度/用量/降级链/密钥 | HTTP + CLI 已有 | 网关页嵌套路由 | ✅ |
| 用量（会话/步骤/Token/工具/模型） | OpenCode 官方 stats | 指标卡 + 趋势 + 聚合；`steps` 不改名 | ✅ |
| 健康检查 | 仅人类文本 | 展示清理后文本；**不用正则推导结构化状态** | ✅（文本） |
| **TTFT / P75 / P99 延迟** | 无持续采样，网关不记录逐请求耗时 | **不进入 MVP**；不画推算曲线 | ❌ |
| **逐请求成功率 / 错误率** | 无统一请求事件；只有调度快照的近期成功率 | **不进入 MVP**；只展示快照值并标注口径 | ❌ |
| **逐请求路由尝试（换了几家）** | 仅响应头 `x-router-attempts`，无持久化 | **不进入 MVP**；只在下游客户端可感知处说明 | ❌ |
| **跨厂商积分/花费汇总** | 八家 credits 非统一货币 | **不进入 MVP**；不显示总额、不排行榜 | ❌ |

对"不进入 MVP"的四项，统一策略与 [00 设计基线 §7](00-design-baseline.md) 一致：
**宁可显示 `—`，也不画一条没有数据源的线**。若将来要补，必须先定义独立请求事件契约（时间、
provider、模型、状态、Token、延迟、费用来源），在数据可靠性验证前不上线图表。

## 6. 设计决策

编号与 [文档索引 README](README.md) 的"核心决策索引"一致；每条给出调研依据与落点。

| 编号 | 决策 | 调研依据 | 落点 |
|---|---|---|---|
| W-01 | 复用 Node CLI 与网关，不复制进程/账号逻辑；桥接只监听回环 | LiteLLM 的"管理分面"建立在本体能力之上；本项目后端事实集中在 `router.mjs` 与 `gateway/` | [04 架构](04-architecture.md) |
| W-02 | 浏览器不直连网关（无 CORS、不能控制进程），一律经桥接 | 网关只监听回环、无 CORS；浏览器无法 spawn 进程 | [05 契约](05-backend-contract.md) |
| W-03 | URL 即状态：选中 provider、时间范围、过滤、排序进 search params | Vercel 日志页"每个筛选都存进 URL、可分享" | [03 界面](03-ui-design.md) |
| W-04 | 服务端状态用 TanStack Query，写操作用 React 19 Actions，不预改状态 | React 19 Actions + Query 的 stale/去重；进程操作不可乐观展示 | [04 架构](04-architecture.md) |
| W-05 | 开关、进程、客户端配置、认证是四个独立状态，漂移由后端字段推导 | Vercel 的 Status 与 Authentication 是不同列；本项目 `on/up/oc/auth` 各自独立 | [12 术语](12-glossary.md) |
| W-06 | 不汇总不同厂商积分；`steps` 不等于请求数；`cost` 不折算积分 | OpenRouter 的 Spend 依赖统一货币；本项目不具备；OpenCode 的 `steps` 有原义 | [02 需求](02-requirements.md) |
| W-07 | 危险操作显式确认、默认取消；写任务全局串行 | LiteLLM 的破坏性操作有独立确认；八家规模小，串行最简单可靠 | [03 界面](03-ui-design.md) |
| W-08 | 只读/演示模式在桥接层拦截，不靠前端隐藏 | LiteLLM 的 `DISABLE_ADMIN_UI` 是服务端开关，不是隐藏菜单 | [07 安全](07-security.md) |
| W-09 | 第三方依赖有预算上限并集中审计（面板必须有构建期依赖，与"零依赖"核心区分） | shadcn"源码进仓库"降低运行时依赖；根目录与 `gateway/` 保持零 devDependencies | [07 安全](07-security.md) |

补充说明两条容易误解的：

- **W-04 的"不预改状态"不等于不用 `useOptimistic`**。乐观更新只用于纯前端即时反馈（如
  按钮 loading 态），凡是会改进程或配置的操作，一律等桥接确认并重新查询后才更新 UI。
- **W-08 的"桥接层拦截"包含 demo**。`--demo` 用匿名 fixtures，**不 spawn 任何进程、不访问
  真实文件**；它与只读模式一样，在桥接层生效，页面无法绕过。

## 7. 调研结论

1. **最合适的形态是"LiteLLM 的管理分面 + OpenRouter 的 provider 视角 + Vercel 的日志交互 +
   本机现有运维语义"，而不是再造一套 AI Gateway。**
2. **分面落在页面**：总览只回答"能不能用、哪里漂移"，明细分别进服务/额度/账号/日志/诊断/
   用量/网关，互不混淆；异常处理路径保持"总览 → provider → 日志/诊断"三步。
3. **交互对齐 Vercel 日志页**：筛选、暂停、跟随、详情面板、URL 可分享，全部落到 search
   params；Live 有显式开关和明确的停止规则。
4. **指标克制**：只展示能由 CLI、本地网关或 OpenCode 官方统计**真实取得**的数据；TTFT/P75、
   逐请求成功率、逐请求路由尝试、跨厂商积分汇总一律不进入 MVP，用 `—` 而不是推算值。
5. **技术选型服务于"写操作安全"**：React 19 Actions 管 pending/error，TanStack Query 管服务端
   状态与 stale，TanStack Router 管可分享状态，shadcn 管可控组件与主题——四者职责不重叠。
6. 首版成功标准是让八家本地反代**看得清、控得准、出错能定位**，而不是图表数量。

相关文档：[02 产品需求](02-requirements.md) · [03 界面设计](03-ui-design.md) ·
[04 技术架构](04-architecture.md) · [10 实施计划](10-implementation-plan.md)。
