# 04 技术架构

状态：设计基线（文档阶段，尚未实现）
对应需求：NFR-101–110（工程结构、性能预算、可测试性、安全边界）

本文固定 `frontend/` 网页面板的**目录、模块边界、数据流、写操作模型与桥接服务架构**。
所有字段名、端口、token 名沿用 [00 设计基线](00-design-baseline.md) 的 §2/§6/§8/§9/§11，
不另立一套；桥接 HTTP 契约的完整字段见 [05 后端契约](05-backend-contract.md)，安全审计见
[07 安全与隐私](07-security.md)。同项目终端版架构见 [`tui/docs/04-architecture.md`](../../tui/docs/04-architecture.md)，
本文在资源模型与 Action 状态机上与它同构。

## 1. 架构目标

1. **UI 不阻塞**：网络、进程探测、日志读取、长时间登录一律不占用交互线程；任一数据源慢或挂住，
   页面仍可切页、可操作。
2. **独立数据源独立失败**：8 家 provider、网关、OpenCode、日志、健康各自是独立的因果链，
   一家失败不升级为全局失败，旧数据保留并标 `stale`。
3. **写操作有状态机**：不以"按钮按下"推断成功；`Queued → Running → Succeeded/Failed → Refreshing → Confirmed/RefreshFailed`。
4. **无凭证可测**：`--demo` 桥接使用匿名 fixtures，不 spawn 进程、不读真实文件，即可渲染全部页面与命令映射。
5. **桥接只监听回环**：`127.0.0.1` 之外的来源一律拒绝；只读/演示模式在桥接层拦截，不靠前端隐藏。
6. **复用不复制**：进程、账号、额度、网关逻辑始终归 `router.mjs` 与 `gateway/`，桥接只做映射与代理（见 §3 W-01）。

## 2. 系统上下文

```text
┌─────────────────────────────────────────────────────────────┐
│  浏览器 SPA（React 19 + Vite 构建产物）                        │
│  TanStack Router（URL 即状态）· TanStack Query v5（服务端状态） │
└───────────────┬─────────────────────────────────────────────┘
                │  HTTP /api/*（JSON envelope）+ SSE（/logs/stream、/events、/actions/stream）
                │  header: x-panel-token（写操作额外要求同源）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  桥接服务  frontend/server/  →  127.0.0.1:8792                │
│  · 参数数组 spawn 子进程  · 代理网关 HTTP  · SSE 推流          │
│  · 统一 envelope + 输出清理 + 只读/demo 拦截                   │
└───────┬──────────────────┬──────────────────┬────────────────┘
        │ spawn(参数数组)   │ fetch(回环)       │ spawn(只读)
        ▼                  ▼                  ▼
┌───────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ router.mjs CLI│  │ 网关 HTTP         │  │ OpenCode CLI      │
│ node router…  │  │ 127.0.0.1:8785   │  │ 只读用量统计       │
│ list/account… │  │ /v1/gateway/*    │  │ session.stats     │
│ up/down/sync… │  │ /health/models   │  └──────────────────┘
└───────────────┘  └──────────────────┘
```

- 浏览器**只**访问桥接的 `/api/*`；不访问 `127.0.0.1:8785`（网关无 CORS，且无法启停进程）。
- 桥接是**唯一**能 spawn 子进程、能读本机文件、能持有网关回环凭证的组件。
- 交互式动作（`login`、`account add`）由桥接"发起并等待"，终端留给用户在原生终端完成（§8）。

## 3. 关键决策

### 3.1 W-01 复用 Node CLI 与网关，不复制控制逻辑

**结论**：桥接调用现有 `node router.mjs …` 与 `node router.mjs gateway …`，通过 `fetch` 代理网关
HTTP，**不在 JS 里重写**进程管理、账号切换、额度采集或网关调度。

**理由**（对齐 TUI 的 D-01）：`router.mjs` 已处理 Windows PID 树、POSIX 进程组、端口兜底、Trae
双进程；账号切换含供应商特定状态与重启；额度采集已归一化厂商接口与敏感字段；网关调度含权重/
冷却/换家。在面板里复刻等于制造第二份高风险事实来源。

**后果**：桥接需要可发现的 Node 与 router root；`--demo` 可在无 Node 时运行；新增 provider 或控制
动作应先扩展 CLI 契约再接入（见 §12）。

### 3.2 W-02 浏览器不直连网关，一律经桥接

**结论**：所有网关数据经桥接 `GET /api/gateway/*` 代理，模型刷新经 `POST /api/gateway/models/refresh`。

**理由**：

| 障碍 | 说明 |
|---|---|
| 无 CORS | 网关按回环单用户设计，未返回 `Access-Control-Allow-Origin`；浏览器跨源请求直接被 CORS 拦截 |
| 不能控制进程 | 网关没有"启停八家"的 HTTP 端点；启停必须走 CLI spawn，浏览器做不到 |
| 凭证注入 | 桥接集中持有回环 token 与 `x-panel-token`；浏览器不接触上游 key |
| 响应头语义 | `x-router-*` 响应头在代理层可保留并归一化，直连则被 CORS 白名单吞掉 |

**后果**：网关的可用性随之绑定桥接——桥接停则面板无数据，但反代与网关仍在运行，不影响客户端。

## 4. 技术栈

| 组件 | 选择 | 职责 |
|---|---|---|
| React | 19（最新稳定） | 组件、`useActionState`/`<form action>`/`useOptimistic`/`use()` |
| 构建 | Vite + TypeScript | dev server、HMR、`import.meta.env`、生产打包 |
| 路由 | TanStack Router | 类型安全路由；search params 即状态（可分享、可回退） |
| 数据层 | TanStack Query v5 | 缓存、去重、staleTime/refetchInterval、后台刷新 |
| UI | Tailwind CSS + shadcn/ui（base）+ Radix 原语 | token 化主题、无样式原语、复制进仓库可控 |
| 图表 | Recharts（经 shadcn chart 封装） | 用量/额度/调度的面积、柱、折线 |
| 表格 | TanStack Table（经 shadcn Data Table） | 排序/筛选/虚拟滚动 |
| 校验 | Zod | 桥接 envelope 与 CLI JSON 的边界运行时校验 |
| 测试 | Vitest · React Testing Library · MSW · Playwright | 单测/组件/契约/E2E |
| 桥接 | Node.js（`frontend/server/`） | spawn + 网关代理 + SSE + 静态托管；只监听 `127.0.0.1:8792` |

**依赖预算说明**（对齐 W-09）：根目录坚持"零依赖、clone 下来就能跑"（网关自测用 `node:assert`，无
devDependencies）。面板是**浏览器应用，必须有构建期依赖**（React/Vite/TS 无法只用标准库），故刻意分两层：

- 根目录、`gateway/`、`tui/` 维持零/极少依赖，不因面板引入 `package.json`。
- `frontend/` 作为**独立单包**维护自己的 `package.json` 与 lockfile（倾向单包而非 npm workspace，
  见 [00 §15](00-design-baseline.md) 待定问题 5），不污染根目录。
- 依赖集中审计、有数量上限，安全策略见 [07 安全与隐私](07-security.md)。

## 5. 计划目录结构

**本阶段只定义结构，不创建任何代码文件。** 下列为 P0 骨架落地时的目标布局：

```text
frontend/
├── package.json                 # 独立单包：依赖、脚本（dev/build/start/test/e2e）
├── vite.config.ts               # 构建配置 + dev proxy（/api → 127.0.0.1:8792）
├── tsconfig.{json,app.json,node.json}  # app：浏览器源（src/）；node：桥接与构建脚本
├── index.html                   # SPA 入口，注入运行时 <meta name="panel-token">
├── README.md                    # 面板自身快速开始（指向 docs/README.md）
├── docs/                        # 本设计基线（00–14）
├── server/                      # 桥接服务（见 §9）
├── src/
│   ├── main.tsx                 # 挂载 React、装配 Router + QueryProvider
│   ├── app/                     # 应用外壳：布局、顶栏、侧栏、键盘、错误边界
│   ├── routes/                  # TanStack Router 路由定义与页面装配
│   ├── components/ui/           # shadcn 复制进仓库的原语（Button/Dialog/Table/Chart…）+ 共享展示组件
│   ├── features/                # 按页面切分的业务模块（见下表）
│   │   ├── overview/            # 总览
│   │   ├── providers/           # 服务
│   │   ├── quota/               # 额度
│   │   ├── accounts/            # 账号
│   │   ├── logs/                # 日志
│   │   ├── diagnostics/         # 诊断
│   │   ├── usage/               # 用量
│   │   ├── gateway/             # 网关（含嵌套子页）
│   │   └── settings/            # 设置
│   ├── lib/
│   │   ├── api/                 # fetch 封装、SSE 客户端、envelope 解析
│   │   ├── query/               # queryKey、queryOptions、mutation/action hooks
│   │   ├── contract/            # Zod schema 与领域类型（镜像 §6 领域模型）
│   │   ├── format/              # 时间/数值/单位/端口/PID 格式化；null≠0 口径
│   │   └── redact/              # 前端侧兜底脱敏（ANSI 残留、常见密钥形态）
│   └── styles/                  # Tailwind 入口与 CSS 变量（shadcn token）
├── tests/                       # Vitest 单测与 RTL 组件测试（含 MSW handler）
├── fixtures/                    # 匿名 fixtures：与 server/--demo 共用同一套
└── e2e/                         # Playwright 端到端用例
```

| 目录 | 职责（一句话） | 不承担 |
|---|---|---|
| `server/` | 桥接进程：spawn、代理、SSE、静态托管、token、只读/demo 拦截 | 页面布局与视觉 |
| `src/app/` | 应用外壳与全局状态（主题、工作范围、连接状态、错误边界） | 具体数据查询 |
| `src/routes/` | 路由树与 search params 编解码 | 业务数据处理 |
| `src/components/ui/` | shadcn 原语副本，无业务含义 | 领域逻辑 |
| `src/features/*/` | 单个页面的查询、组件、交互 | 跨页共享原语 |
| `src/lib/api/` | 与桥接 HTTP/SSE 通信的唯一出口 | 组件状态 |
| `src/lib/contract/` | Zod 契约与领域类型 | 请求发起 |
| `tests/` · `e2e/` · `fixtures/` | 单测/组件/端到端与匿名数据 | 生产部署 |

## 6. 模块边界

- **UI 不拼命令**：provider/action 标识以**枚举值**在契约里固定，组件只传 `{action, providerIds, accountKey}`；
  命令字符串、flag、`--keep-oc`、`--no-login` 由桥接拼装。UI 里不得出现 `"up " + id` 这类拼接。
- **桥接不决定布局**：桥接返回领域模型与错误码，不返回"该显示在哪个卡片""用什么颜色"；`drift`
  由后端字段推导（§7），但**呈现方式**由 UI 决定。
- **契约是唯一缝**：跨层数据必须过 `lib/contract/` 的 Zod schema；未通过校验视为契约错误（§11），
  不做"尽力解析"。原始日志/任务输出已在桥接清理（§9），组件只接收有界文本。

## 7. 数据流与状态

### 7.1 Resource<T> ↔ TanStack Query

桥接统一返回 `Resource<T>`（定义见 [00 §6](00-design-baseline.md)），前端把它映射进 Query 缓存：

| `Resource<T>` 字段 | TanStack Query 对应 | 说明 |
|---|---|---|
| `data` | `query.data`（成功值） | `null` ≠ 空 ≠ 0，保持区分 |
| `lastSuccessAt` | 自定义 `dataUpdatedAt` 展示源 | 顶栏"最后成功时间" |
| `receivedAt` | `meta.receivedAt` | 桥接收时间，用于判断新鲜度 |
| `error` | `query.error`（经 Zod 归一） | `{code,message,retryable}` |
| `stale` | 派生：`isError && data != null` 或超阈值 | 有旧数据但刷新失败 |

映射后，`isPending && !data` → 首次加载；`isError && !data` → 显示失败，**绝不显示假 0**；
`isError && data` → 保留旧数据 + `stale` 标记。

### 7.2 queryKey 命名规范

```ts
// 统一为 [domain, ...scope]，scope 用对象以便结构化比较
['env']                                  // 桥接/工作范围/连接信息
['providers']                            // provider 状态列表（§8：5s）
['provider', id]                         // 单家详情（如需要）
['accounts', { provider }]               // 账号（provider 省略=全部）
['accountsCheck'] · ['doctor'] · ['healthCheck', { provider, probe }]
['quota', { provider, refresh }]         // 额度（§8：120s）
['logs', { provider, lines }]            // 日志快照（配合 SSE 跟随）
['usage', { range }]                     // range: 24h|7d|30d|all
['gateway', 'status'|'balance'|'combos'|'free'|'local-answers']  // §8：status 5s
['gateway', 'usage', { days }]           // §8：60s
['action', actionId]                     // 单任务查询
```

全部 key 由 `src/lib/query/keys.ts` 集中导出，禁止在组件里手写字符串数组。

### 7.3 刷新策略对齐 §8

| 资源 | `staleTime` | `refetchInterval` | 进入页面 | 手动刷新 |
|---|---|---|---|---|
| Provider 状态 `['providers']` | 0 | 5000ms（可见时） | 是 | 顶栏/页内 |
| 账号 `['accounts']` | 30s | `false`（不轮询） | 是 | 账号页刷新 |
| 额度 `['quota']` | 120s | 120000ms | 是 | 额度页刷新 |
| 日志 `['logs']` | 0 | 无（改用 SSE） | 是 | 切换 provider/行数 |
| 网关 `status` | 0 | 5000ms | 是 | 各页刷新 |
| 网关 `usage` | 30s | 60000ms | 是 | 各页刷新 |
| 健康/试打 | 不限 | `false` | 仅诊断页/显式 | 执行按钮 |

- **去重**：相同 `queryKey` 的并发请求由 TanStack Query 合并；桥接对同数据源只读请求同样去重。
- **可见性暂停**：订阅 `document.hidden`，窗口不可见时**暂停轮询与 SSE**；恢复可见立即补一次
  （`refetchOnWindowFocus` 配合自定义 visibility hook，不用默认 focus 行为以免误触发）。
- **局部失败保留旧数据**：`placeholderData: keepPreviousData` 保证切换 provider/范围时不清屏。

### 7.4 边界校验

所有桥接响应在 `lib/api/` 出口经 Zod schema 解析；解析失败抛出 `contract` 类错误，UI 显示
"后端版本不兼容"而不是渲染半截数据。fixtures 与真实响应共用同一 schema，测试因此能挡住契约漂移。

## 8. 写操作

### 8.1 React 19 Actions + 桥接任务流

```text
<form action={formAction}>           // 或按钮触发 startTransition
        │  useActionState 拿 [state, formAction, isPending]
        ▼
POST /api/actions  {action, providerIds, accountKey?}
        │  返回 {actionId}
        ▼
GET /api/actions/stream (SSE)  → 推 Task（§6 领域模型）
        │
        ▼
任务终态（succeeded/failed）→ invalidateQueries 触发**重新查询**
        │
        ▼
只在 RefreshStatus 变为 confirmed 后才更新 provider 状态
```

规则（对齐 [00 §9](00-design-baseline.md)）：

- **pending 不预改状态**：`isPending` 期间只显示进度，不用乐观值改写 provider 的 on/up；
  纯展示性反馈可用 `useOptimistic`（如按钮转圈、行高亮），**不涉及真实状态字段**。
- **完成后重新查询**：动作成功后按作用范围 `invalidateQueries`，再以真实只读结果刷新 UI。
- **危险等级**：`normal`（up/down/keep-oc/restart/off/sync）、`high`（on/all/none、恢复整池）。
  高风险列出受影响名单，默认焦点"取消"。
- **交互式动作**：`login`、`account add` 需要 stdin，浏览器无法接管。桥接只**发起并等待**，终端留给
  用户在原生终端完成；UI 显示"等待外部登录完成"并可取消（细节见 [05](05-backend-contract.md)/[07](07-security.md)）。

### 8.2 Action 状态机

```text
Draft
  → Confirming
  → Queued
  → Running
  → Succeeded / Failed
  → Refreshing        （仅 Succeeded 后）
  → Confirmed / RefreshFailed
```

| 状态 | 副作用 | 规则 |
|---|---|---|
| `Draft` | 无 | 前端本地，不入队 |
| `Confirming` | 无 | 高风险必列名单；`normal` 可跳过 |
| `Queued` | 无 | 全局串行队列；同目标去重 |
| `Running` | 有 | 有运行时长与输出，**不设易中断的短超时** |
| `Succeeded` | 有 | 退出码 0 只表示 CLI 成功，**不**直接改写 provider 状态 |
| `Failed` | 有 | 非零退出码保留输出，随后**一次**只读校正 |
| `Refreshing` | 无 | 重新查询真实状态中 |
| `Confirmed` | 无 | 只读结果确认动作生效 |
| `RefreshFailed` | 无 | **区分**"动作成功但状态未确认"与"动作失败"，两者文案不同 |

### 8.3 串行与去重

- **全局串行**：八家规模小，写任务进单一队列，前一任务终态后才起下一个（简单、可解释优先）。
- **去重**：相同 `(action, providerIds, accountKey)` 在 `Queued`/`Running` 期间重复提交直接复用原
  `actionId`，不重复 spawn。
- **只读并发**：只读刷新受控并发（每数据源最多一个在途），不受写队列阻塞。

### 8.4 只读 / 演示模式拦截

`read-only` 与 `--demo` 在**桥接层**生效：命中写端点时返回 `403`（`code: readonly`），
**不是**前端隐藏按钮。演示模式不 spawn、不访问真实文件，全部返回匿名 fixtures。

## 9. 桥接服务架构

```text
frontend/server/
├── index.mjs        # HTTP 服务器入口、路由分发、token 校验、静态托管
├── spawn.mjs · cli.mjs  # 参数数组 spawn + router.mjs 子命令封装（list/account/logs/doctor/actions…）
├── gateway.mjs      # 网关 HTTP 代理（/v1/gateway/*、/health、get /v1/models）
├── map.mjs          # CLI legacy 字段 → 领域模型映射、drift 推导
├── sse.mjs          # SSE 通道：日志跟随、事件流、任务流
├── cleanup.mjs      # ANSI/OSC 剥离 + 密钥脱敏 + 行数/行长上限
├── config.mjs       # root/node 发现、端口、read-only/demo 开关
└── demo/            # 匿名 fixtures（与 fixtures/ 同源）
```

| 关注点 | 做法 |
|---|---|
| 进程 spawn | `spawn(node, ['router.mjs', ...args])` **参数数组**，无 `sh -c`/`cmd /c`/PowerShell；`cwd` 为发现的 root |
| `--no-login` | 后台执行 `up/on/all/restart` 时**强制**附加，禁止自动打开浏览器 |
| 超时与取消 | 只读查询有上限超时；写任务不设易中断短超时，取消走协作式（请求断开 → abort → 通知 CLI） |
| SSE 通道 | `GET /api/logs/stream`（日志跟随）、`/api/events`（provider 状态 + 任务）、`/api/actions/stream`（任务） |
| 静态站点托管 | 生产由桥接同时托管 `dist/` 与 `/api/*`，`index.html` fallback 支持 SPA 深链 |
| 统一 envelope | `{ schemaVersion:1, generatedAt:Iso, ok, data?, error? }`，与 CLI 的 `schemaVersion:1` 对齐 |
| token 注入 | 启动生成一次性 token，注入 `index.html` 的 `<meta name="panel-token">` 并在请求头 `x-panel-token` 携带；CSRF 用 `SameSite=Strict`，写操作要求同源 + token |
| demo fixtures | `--demo` 下全部读端点返回 fixtures；写端点返回 `403 readonly`；**不 spawn、不读真实文件** |

**持久进程 vs 一次性子进程**：桥接自身是常驻 Node 进程；每次 CLI 调用是**一次性**子进程，退出码
+ stdout/stderr 归一为 `Task`。网关是**已存在**的独立进程，桥接只 `fetch` 而不管理其生命周期。

## 10. 配置与发现

发现 router root 的优先级（与 TUI 一致）：

1. `--router-root <path>`：桥接启动参数；
2. `ROUTER_ROOT` 环境变量；
3. 当前目录（或父目录）含 `router.mjs`。

| 配置项 | 来源 | 默认 | 说明 |
|---|---|---|---|
| router root | `--router-root` / `ROUTER_ROOT` / 目录探测 | 探测所得 | 桥接 spawn 的 `cwd` |
| Node 可执行 | `--node <path>` / `PATH` | `node` | 指向具体可执行文件，避免多版本歧义 |
| 桥接端口 | `--port` | `8792` | 只监听 `127.0.0.1:8792` |
| 工作范围 | `--demo` / `--read-only` | 无 | 桥接层生效 |
| 网关地址 | 常量 | `127.0.0.1:8785` | 与 [00 §2](00-design-baseline.md) 端口表一致 |

**Vite dev proxy**：开发时浏览器访问 `127.0.0.1:5173`，`vite.config.ts` 把 `/api` 代理到
`127.0.0.1:8792`，从而 dev 与生产共用同一组 `/api/*` 路径，无直连网关。

```ts
// vite.config.ts（示意，实施阶段落地）
server: { host: '127.0.0.1', port: 5173,
  proxy: { '/api': 'http://127.0.0.1:8792' } }
```

面板不引入额外用户配置文件；刷新间隔等由设置页保存到浏览器本地存储，不改桥接参数。

## 11. 错误边界与预算

### 11.1 错误分类

| 类型 | 示例 | UI 行为 |
|---|---|---|
| 配置错误 | root 不存在、`--node` 路径错误 | 启动诊断页给出参数建议 |
| 启动错误 | 无法 spawn、权限不足 | 当前数据源失败，其他来源继续 |
| 超时 | 状态查询超时 | 保留旧数据，标 `stale` |
| 输出错误 | 非 UTF-8、非法 JSON、ANS 残留 | 保留有界脱敏诊断，不崩溃 |
| 契约错误 | Zod 校验失败、`schemaVersion` 不支持 | 提示"后端版本不兼容" |
| 业务失败 | provider 未登录、端点不可达 | 显示在该 provider 内，不升级为全局 |
| 动作失败 | 非零退出码 | 任务失败并可查看输出 |
| 只读拦截 | 写端点被桥接拒绝 | 提示当前为只读/演示模式 |

**React 错误边界**：在路由段与关键面板外各包一层；渲染异常降级为局部错误卡片并提供"重试/返回"，
不让整页白屏。

### 11.2 性能与资源预算

- 8 家 provider 下的状态汇总保持 **O(n)**，不做全量重算排序。
- 单 provider 日志视图最多保留 **2000 行**；任务输出同样设上限，超限标记 `truncated`。
- 同 `queryKey` 并发查询**去重**；桥接对同数据源只读请求也去重。
- `document.hidden` 时**暂停**轮询与 SSE，恢复可见立即补一次。
- 单行输出设显示长度上限，完整原文仍由用户经既有文件或日志 CLI 查看；以上是设计预算，不是已测量的
  性能承诺，实施后以测试与实测修订。

## 12. 可扩展方向

- **新 provider 数据驱动**：新增第九家只需扩展桥接映射层与契约枚举，前端按 provider 列表渲染，
  不写死数量与颜色（颜色映射见 [06 设计系统](06-design-system.md)）。
- **逐请求遥测另立契约**：用量页当前来自 OpenCode 官方只读统计（`experimental.session.stats`），
  不从进程日志反推 Token 或费用；将来若做逐请求遥测，应新增**独立契约与端点**，而不是把日志正则
  解析伪装成指标（同 [TUI §16](../../tui/docs/04-architecture.md)）。
- **增量字段 additive**：健康 JSON、额度直读等后端增强按 [00 §13](00-design-baseline.md) 规则提案；
  改义/删除字段要升 `schemaVersion` 并同步 fixtures 与测试。
- **工作范围抽象**：`local`/`demo` 之外的只读镜像或远程后端应作为新桥接数据源实现，先完成认证与
  威胁模型，不能直接复用回环明文假设。
