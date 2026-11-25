# 00 设计基线

状态：设计基线 · 已实现（2026-11-25，见 [13 实现状态](13-implementation-status.md)）
适用范围：`frontend/` 网页面板的全部文档与后续实现
定位：本文件是**唯一事实来源**。其余文档（01–14）都引用本文件固定的编号、路由、契约与
token，不得各自另立一套。

## 1. 一句话定位

`frontend/` 是 router 的**浏览器控制台**：把根目录 `router.mjs`（进程/账号/额度/日志）和
`gateway/`（统一网关的调度/用量/密钥）已有的能力，呈现为一个本地运行、可读可控、出错能
定位的仪表盘。

它与 `tui/` 是**同一套语义的两个前端**：目标、页面划分、状态口径、安全边界一致；技术栈与
交互媒介不同（Rust/TUI vs React/浏览器）。因此 `tui/docs/` 是首选参照物，本仓库术语以
`tui/docs/12-glossary.md` 为上位定义。

## 2. 本轮已确认的决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 交付方式 | **设计先行，已按基线落地实现** | 先固定契约与页面语义，再实现并用测试回填差异 |
| 前端框架 | **React 19（最新稳定）** | 用户指定；Actions/`use()`/表单 Actions 直接服务写操作模型 |
| 构建 | **Vite + TypeScript** | 事实标准、启动快、`import.meta.env` 支持 |
| 路由 | **TanStack Router** | 类型安全、search 参数即状态（可分享 URL，对齐 Vercel 日志页） |
| 数据层 | **TanStack Query v5** | 服务端状态缓存/去重/stale/后台刷新，天然映射 TUI 的 `Resource<T>` |
| UI 组件 | **Tailwind CSS + shadcn/ui（base 风格）+ Radix 原语** | 复制进仓库、可控、无需自造轮子；组件清单见官网 |
| 视觉体系 | **Fluent 2 语义 token 为底，保留 shadcn 变量名作兼容映射** | surface/accent/stroke/status/elevation/motion 统一；旧类名不用迁移，细节见 [06](06-design-system.md) |
| 图表 | **Recharts + 自绘 Sparkline/RingGauge** | Recharts 负责面积/柱/环形；迷你趋势与比例环用纯 SVG，避免重依赖 |
| 表格 | **TanStack Table（经 shadcn Data Table）** | 排序/筛选/虚拟滚动可控 |
| 数据接入 | **新增 Node 桥接服务**（`frontend/server/`） | 网关无 CORS、且不能启停进程；浏览器无法直接驱动 CLI |
| 桥接职责 | 包装 CLI（参数数组 spawn）+ 代理网关 HTTP + SSE 推流 + 只监听回环 | 与 TUI 的 `NodeBackend` 同构，见 `tui/docs/04-architecture.md` |
| 端口 | 桥接/静态站点 `127.0.0.1:8792`；Vite dev `127.0.0.1:5173` | 8792 未与任何反代冲突（十三家占用 7863/7864/8787/8788/8789/8790/8791/8793/8794/8795/8796/8797/10087/20131，网关 8785） |

**非目标**：本轮不修改 `router.mjs`、`gateway/`、`tui/` 的任何行为与契约。若实现阶段需要
后端增量字段，按 `tui/docs/05-backend-contract.md` 的"增量兼容"规则单独提案（见 §12）。

## 3. 事实来源（Ground Truth）

### 3.1 根目录 CLI（`node router.mjs …`）

只读：

| 能力 | 命令 | 输出 |
|---|---|---|
| Provider 状态 | `node router.mjs list --json` | `{schemaVersion:1,generatedAt,enabled[],providers[]}` |
| 全部账号 | `node router.mjs account --json` | `{schemaVersion:1,generatedAt,providers[]}` |
| 单家账号 | `node router.mjs account <id> --json` | `{schemaVersion:1,generatedAt,provider:{...}}` |
| 账号体检 | `node router.mjs account check --json` | `{schemaVersion:1,generatedAt,providers[]}`（含 `health.level/notes`） |
| 日志 | `node router.mjs logs <id> <lines>` | 人类文本 |
| 自检 | `node router.mjs doctor` | 人类文本 + 退出码 |
| 无试打健康 | `node scripts/health.mjs --no-probe` | 人类文本（**暂无 JSON**） |

`list --json` 的 `providers[]` 字段（已实现）：`id,title,port,on,up,models,pid,pids,control,oc,ocUserOwned,auth`；
`auth={ok,state,expiresAt,label}`，`state∈{valid,expiring,expired,missing,unknown}`。网关条目
`on` 直接等于进程状态（它是叠加层，见 §4）。

`account --json` 的 `providers[]`：`id,title,kind,switchable,accounts[]`；
`accounts[]={key,name,uid,enabled,active,detail,health}`，`health={level:ok|warn|error|unknown,notes[]}`。

写：

| Action | 参数 | 副作用 |
|---|---|---|
| Start | `up <id>` | 起进程 |
| Stop | `down <id>` | 停进程并同步移除客户端 |
| StopKeepOpenCode | `down <id> --keep-oc` | 停进程，保留 opencode |
| Restart | `restart <id>` | 重启 |
| OnlyEnable | `on <id…>` | 排他：关闭其他家 |
| Disable | `off <id…>` | 关开关、停进程、同步 |
| EnableAll | `all` | 全开 |
| DisableAll | `none` | 全关 |
| Sync | `sync` | 客户端与开关对齐 |
| SwitchAccountPreview | `account <id> <key> --dry-run --json` | 只预览 |
| SwitchAccount | `account <id> <key> --json` | 写账号并重启 |
| EnableAllAccounts | `account <id> --all --json` | 恢复整池 |
| Login | `login <id>` | **交互式**，挂起 |
| AddAccount | `account add <id>` | **交互式**，挂起 |

约定：后台执行 `up/on/all/restart` 时**必须**带 `--no-login`，禁止自动打开浏览器。

### 3.2 统一网关 HTTP（`127.0.0.1:8785`）

| 端点 | 说明 |
|---|---|
| `GET /health` | 探活，免密钥 |
| `GET /v1/models` | 各家并集 + 裸名 + `combo:*` |
| `GET /v1/gateway/status` | 调度快照：权重/冷却/并发/成功率/粘性 |
| `GET /v1/gateway/usage?days=7` | 用量聚合 |
| `GET /v1/gateway/balance` | 各家额度（转发采集器） |
| `POST /v1/gateway/models/refresh` | 清空模型缓存 |

响应头：`x-router-provider / x-router-attempts / x-router-upstream-dialect / x-router-upstream-shape /
x-router-local-answer`。回环默认免密钥；带无效密钥也不拦（`strict` 时才拦）。

**网关无 CORS**：浏览器不得直连，必须经桥接。

### 3.3 网关 CLI（`node router.mjs gateway …`，进程内转发 `gateway/cli.mjs`）

`status [--json]`、`usage [--days N] [--json]`、`balance`、`doctor`、`combo add|list|rm`、
`local [on|off] [quota|prefix|title|suggestion|filepath|all]`、`key add|list|rm|disable|reset-usage`、
`providers list|show|key|test|install`、`refresh-quota`。

### 3.4 数据文件

- `router.json`：启用开关。
- `gateway/data/{config.json,keys.json,providers.json,quota.json,usage/<date>.jsonl}`（`.gitignore`）。
- `~/.pi/agent/models.json`、`~/.config/opencode/opencode.json(c)`。
- 密钥库 `keys.json` 只有 SHA-256；`providers.json` 为 AES 加密上游 key。

## 4. Provider、Region 与网关的关系

- `Provider`：十三家本机反代 —— `qoder-cn, qoder, trae-local, codearts, zcode, loomy,
  raccoon, qwenwork, dumate, lingxi, lobster, workbuddy, workbuddy-global`。它们是"spawn 什么进程"的对象，
  有 PID/端口/日志。

  | Provider | 端口 | Provider | 端口 |
  |---|---:|---|---:|
  | `qoder-cn` | 8789 | `qoder` | 8790 |
  | `trae-local` | 7863（内部 7864） | `codearts` | 10087 |
  | `zcode` | 20131 | `loomy` | 8791 |
  | `raccoon` | 8793 | `qwenwork` | 8794 |
  | `dumate` | 8795 | `lingxi` | 8796 |
  | `lobster` | 8797 | `workbuddy` | 8787 |
  | `workbuddy-global` | 8788 | `gateway`（叠加层） | 8785 |

- `Region`：Qoder 与 WorkBuddy 各两套端点的区域属性，不是第三层对象。
- `Gateway`：**叠加层**，id=`gateway`，端口 8785。它没有独立开/关（`on==up`），
  `on/off` 语义不适用；opencode provider 由 `gateway install` 独立管理。
- 免费供应商：18 家（3 本机免账号 + 15 有免费额度），由网关直接当上游，**不在** `PROVIDERS`。
  在 UI 里属于"网关"页的只读清单，不参与 `on/off`。

## 5. 信息架构（页面 / 路由 ID）

左侧固定导航，页签 ID 与路由一一对应。**页面 ID 一经确定，所有文档与测试都用它**。

| 页签 | 页面 ID | 路由 | 回答的问题 |
|---|---|---|---|
| 总览 | `overview` | `/` | 十三家现在能不能用？哪里漂移？ |
| 服务 | `providers` | `/providers` | 谁在跑？怎么启停/重启/开关/同步？ |
| 额度 | `quota` | `/quota` | 余额、凭证天数、签到、重置日？ |
| 账号 | `accounts` | `/accounts` | 当前生效谁？怎么切/恢复整池？ |
| 日志 | `logs` | `/logs` | 某家为什么报错？ |
| 诊断 | `diagnostics` | `/diagnostics` | doctor/健康/试打结果？ |
| 用量 | `usage` | `/usage` | OpenCode 会话/Token/工具/模型聚合？ |
| 报表 | `reports` | `/reports` | 跨数据源的只读汇总、导出与打印？ |
| 网关 | `gateway` | `/gateway/*` | 调度、用量、降级链、密钥、免费供应商、本地应答 |
| 设置 | `settings` | `/settings` | 主题/对比度、刷新间隔、只读、桥接连接、演示模式 |

`gateway` 用嵌套路由：
`/gateway`（调度快照）·`/gateway/usage`·`/gateway/combos`·`/gateway/keys`·
`/gateway/free`·`/gateway/local-answers`。全站共 **15 个路由页**（含 6 个网关子页）；导航按
`概览 / 数据 / 系统` 三组排列。

URL 即状态：选中 provider、时间范围、日志过滤、表格排序都进 search params（可分享、可回退）。
顶栏常驻：工作范围（local/demo）、桥接与网关可达性、各数据源最后成功时间、活动任务数。

总览矩阵固定 7 列：**Provider / 开关 / 进程·漂移 / 认证 / 客户端 / 端口·模型 / 额度**；
「进程·漂移」合并展示且排序仍按 `up`，「端口·模型」合并展示但两者都可见；不设单独「跳转」列，
跳服务/日志/诊断统一走「行点击 → 详情抽屉」，抽屉内链接保留 `provider` 焦点。

## 6. 统一领域模型（前端只消费这些）

UI 不直接读 CLI 的 legacy 字段，桥接先把它们映射为下列模型（字段名固定）：

```ts
type Iso = string;                       // RFC3339 UTC
type IsoMs = number;                     // Unix 毫秒

type Resource<T> = {
  data: T | null;                        // 最近一次成功
  lastSuccessAt: Iso | null;             // 最近成功时间
  receivedAt: Iso | null;                // 桥接收到的时间
  error: { code: string; message: string; retryable: boolean } | null;
  stale: boolean;                        // 有旧数据但最近刷新失败/超阈值
};

type ProviderStatus = {
  id: string; title: string;
  on: boolean;                           // 启用开关（gateway 例外：=up）
  up: boolean;                           // 进程/端口在跑
  models: number | null;                 // null ≠ 0
  port: number; pid: number | null; pids: number[];
  control: string;                       // 原样映射
  oc: boolean; ocUserOwned: boolean;     // 客户端配置 / 用户自管
  auth: { ok: boolean; state: AuthState; expiresAt: Iso | null; label: string };
  drift: DriftKind[];                    // 由 on/up/oc(+ocUserOwned) 推导，见 §7
};
type AuthState = 'valid'|'expiring'|'expired'|'missing'|'unknown';

type Account = {
  key: string; name: string; uid: string | null;
  enabled: boolean; active: boolean; detail: string;
  health: { level: 'ok'|'warn'|'error'|'unknown'; notes: string[] };
};
type AccountGroup = { id: string; title: string; kind: string; switchable: boolean; accounts: Account[] };

type QuotaBucket = { id: string; label: string; total?: number|null; used?: number|null;
                     remaining: number|null; unit: 'credits'|'tokens'|'days'|string;
                     resetDate?: Iso|null; expiring?: number|null };
type QuotaRow = {
  provider: string; kind: string; title: string; available: boolean;
  reason?: string; detail?: string; account?: string|null; accounts?: QuotaBucket[] | Account[];
  buckets?: QuotaBucket[]; serviceRunning?: boolean;
  checkin?: { supported: boolean; claimable?: boolean; claimed?: boolean; rewardCredits?: number; note?: string };
  error?: string | null; fetchedAt?: Iso | null;
};

type GatewayProviderSnap = {
  id: string; running: boolean; dialect: 'openai'|'anthropic'|'both'|null; port: number|null;
  weight: number; quotaRatio: number|null; inFlight: number; consecutiveFails: number;
  successRate: number; cooldownUntil?: IsoMs|null; cooldownKind?: string|null; sticky?: number;
};
type Task = {                          // 对应 TUI 的 Action 内部模型
  actionId: string; action: ActionName; providerIds: string[];
  accountKey?: string|null; startedAt: Iso; finishedAt: Iso|null; exitCode: number|null;
  status: 'queued'|'running'|'succeeded'|'failed'|'cancelled';
  stdout: string; stderr: string; truncated: boolean;
  refreshStatus: 'pending'|'confirmed'|'failed'|'notRequired';
};
```

## 7. 状态口径（不得自造）

- `null`、加载失败、未查询、真实 `0` 是**四种**不同状态；未知显示 `—`。
- `drift` 由后端字段推导，不由 UI 猜：
  - `on=true,up=false` → `stopped`
  - `on=true,oc=false && !ocUserOwned` → `notSynced`
  - `on=false,up=true` → `stillRunning`
  - `ocUserOwned` → 永不报同步漂移
- `up`/`reachable` 不代表凭证有效，凭证有效不代表 `oc=true`，`oc=true` 不代表请求会成功。
- 额度 `days`（WorkBuddy 凭证天数）**不并入 credits 汇总**；不显示跨家总额/排行榜。
- `steps` 永远不等于 HTTP 请求数；`cost` 是 OpenCode 上报值，不折算积分。
- `stale` 仅在"有旧数据且最近刷新失败或超阈值"时置位。

## 8. 资源刷新策略（默认值，设置页可覆盖）

| 资源 | 策略 | 手动刷新 |
|---|---|---|
| Provider 状态 | 5s（页面可见时）；同 key 去重 | 顶栏/页内刷新 |
| 账号 | 进入页面 + 写操作后；不轮询 | 账号页刷新 |
| 额度 | 120s；允许后端缓存；显示 `fetchedAt` | 额度页刷新 |
| 日志 | **SSE 跟随**（页面可见且开启时；否则停止） | 切换 provider/行数 |
| 网关调度/用量 | status 5s、usage 60s | 各页刷新 |
| 健康 | 进入诊断页或显式执行；不后台试打 | 诊断页执行按钮 |
| 真实试打 | **从不自动**；加强确认 | 诊断页显式触发 |

窗口不可见（`document.hidden`）时暂停轮询与 SSE；可见时立即补一次。

## 9. 写操作模型（React 19 Actions）

- 所有写操作经桥接 `POST /api/actions`，返回 `actionId`，进度用 SSE 推 `Task`。
- 采用 React 19 `useActionState` / `<form action>` / `useOptimistic`：**pending 不预改状态**，
  完成后**重新查询**，只在确认后才更新 UI。
- 危险等级：`normal`（up/down/keep-oc/restart/off/sync）、`high`（on/all/none、恢复整池）。
  高风险必须列出受影响名单，默认焦点"取消"。
- 互斥：写任务**全局串行**（十三家白名单规模仍小，简单优先）；同目标重复提交去重。
- `read-only` 模式在**桥接层**阻断写，不只是隐藏按钮。
- 交互式动作（`login`/`account add`）浏览器无法接管 stdin：桥接只**发起并等待**，
  把终端留给用户在原生终端完成，UI 显示"等待外部登录完成"并可取消（见 05/07 文档）。

## 10. 视觉与 token

- 视觉基线：**Fluent 2 语义 token**（`--accent-*`、`--surface-1/2/3`、`--stroke-1/2`、
  `--text-primary/secondary/tertiary`、`--status-*`、elevation/radius/motion）。旧 shadcn 变量名
  全部映射到 Fluent 值，既有 `bg-card`/`text-muted-foreground` 类继续可用；取值见 [06 §2](06-design-system.md#2-token-规范)。
- 语义色：`accent / success / warning / error / muted / selected / border / background / foreground`
  （对齐 `tui/docs/03-ui-design.md` §13），支持 dark/light/system 与高对比。
- 材质与层次：`.mica` 应用底、`.acrylic` 弹层/抽屉（半透明 + 30px 模糊 + 1px stroke，
  `@supports` 回退不透明）、`.layer-1/.layer-2` 卡片与内嵌块、`elevation-2/4/8/16`。
- 动效：`--motion-fast 150ms` / `--motion-normal 250ms` / `cubic-bezier(0.2,0,0,1)`；
  页面进入 fade + `translateY(4px)`；`prefers-reduced-motion` 全部归零。
- 状态**不只靠颜色**：文字/图标/数值同时存在；错误给"下一步"。
- Provider 分类色（稳定映射，对齐 `tui/docs/14-usage-analytics.md` §5）：
  `codearts` 紫 · `qoder-cn` 青 · `qoder` 蓝 · `trae-local` 绿 · `workbuddy` 黄 ·
  `workbuddy-global` 浅紫 · `zcode` 橙 · `loomy` 洋红 · `raccoon` 红 · `qwenwork` 天蓝 ·
  `dumate` 绿 · `lingxi` 品红 · `lobster` 朱红 · `gateway` 中性。
- 排版：Fluent ramp 12/14/16/20/28px；11px 辅助文案与 13px 表格为密度变体，均满足 AA；
  等宽用于端口/PID/日志；数字右对齐 + `tabular-nums`。
- 圆角/阴影：`--radius-2/4/8/12/16` 与 `--shadow-2/4/8/16`，不另造刻度。
- 无障碍：WCAG 2.1 AA 对比度；全键盘可达；2px accent focus rectangle；`prefers-reduced-motion`
  降低动效；高对比支持 `prefers-contrast: more` 与 `.high-contrast`。

## 11. 桥接服务契约（摘要，细节见 05）

- 只监听 `127.0.0.1`；默认仅回环。
- 统一响应 envelope：`{ schemaVersion:1, generatedAt:Iso, ok, data?, error? }`，
  与 CLI 的 `schemaVersion:1` 对齐。
- 认证：启动时生成一次性 token，注入页面并在请求头 `x-panel-token` 携带；CSRF 用
  `SameSite=Strict`；写操作要求同源 + token。
- 端点（前缀 `/api`）：
  `GET /health`·`/env`·`/providers`·`/accounts[?provider]`·`/accounts/check`·`/quota[?provider&refresh]`·
  `GET /logs?provider=&lines=`（文本）·`GET /logs/stream?provider=`（SSE）·
  `GET /doctor`·`GET /health-check[?provider][&probe]`·`GET /usage?range=24h|7d|30d|all`·
  `GET /gateway/status|usage|balance|combos|local-answers|free`·
  `POST /actions`·`GET /actions/:id`·`GET /actions/stream`（SSE）·
  `GET /events`（SSE：provider 状态 + 任务）·`POST /gateway/models/refresh`。
- `--demo`：桥接用匿名 fixtures，**不 spawn 任何进程、不访问真实文件**；所有示例数据必须是
  虚构值（沿用 TUI fixtures 约定）。
- 输出清理：日志/任务输出先剥离 ANSI/OSC 控制序列并脱敏常见密钥，再有界返回（默认 ≤2000 行）。

## 12. 安全不变量（摘要，细节见 07）

1. JSON 中**禁止**出现 access/refresh token、PAT、API Key、Authorization、完整 session/cookie、
   签名/HMAC 输入、解密材料、提示词或响应正文。
2. 命令一律参数数组 spawn，禁止 `sh -c`/`cmd /c`/PowerShell 拼接。
3. 桥接只监听回环；非回环来源一律拒绝（无"仅 WLAN 调试"开关）。
4. 只读模式与演示模式在桥接层拦截，不靠前端隐藏。
5. 不改写 `router.mjs`、`gateway/`、`tui/` 的现有语义；新增后端字段走增量兼容。

## 13. 向后端提案的最小增量（不在本轮改动）

| 目标 | 现状 | 建议 |
|---|---|---|
| 结构化健康 | `health.mjs` 仅文本 | 增加 `--json`（对齐 `tui/docs/05` §8 目标结构） |
| 额度直读 | 只有 `qoder2pi credits json` + 网关 `balance` | 桥接优先用网关 `balance`，缺失再回退 CLI |
| 账号体检 | `account check --json` 已有 | 直接使用 |

在这些增量落地前，健康页允许展示**文本**诊断，但**不得**用正则解析文本生成结构化字段。

## 14. 文档约定

- 语言中文；每篇首行 `# NN 标题`，第二段含 `状态：…` 与 `对应需求：…`。
- 用表格承载契约与映射；用代码块承载 JSON/命令/目录树；引用其它文档用相对路径。
- 所有示例数据匿名、虚构；不得出现真实 token、真实用户名、本机绝对路径。
- 新字段优先 additive；改义/删除字段要升 `schemaVersion` 并同步 fixtures 与测试。
- 术语以 `tui/docs/12-glossary.md` 为准，前端新增术语记入 `12-glossary.md`。

### 需求编号段落（写入 02-requirements.md，其它文档按此引用）

| 段 | 编号 | 主题 |
|---|---|---|
| 5.1 | FR-101–109 | 总览与状态 |
| 5.2 | FR-110–119 | 服务控制 |
| 5.3 | FR-120–129 | 额度 |
| 5.4 | FR-130–139 | 账号与登录 |
| 5.5 | FR-140–149 | 日志与诊断 |
| 5.6 | FR-160–169 | 用量分析 |
| 5.7 | FR-170–179 | 网关 |
| 5.8 | FR-180–189 | 设置 / 主题 / 可访问性 / 国际化 |
| 5.9 | FR-190–199 | 通用交互（键盘、空/错/加载、demo、只读） |
| 6 | NFR-101–110 | 非功能需求 |

### 文档职责与所有权

| 文档 | 职责 | 不承担 |
|---|---|---|
| 01-research | 网上控制台调研 + 技术选型依据 | 具体页面键位 |
| 02-requirements | FR/NFR、范围、验收 | 组件实现 |
| 03-ui-design | 页面布局、交互、响应式、路由 | 数据契约细节 |
| 04-architecture | 目录、模块、状态、构建、桥接架构 | 视觉 token |
| 05-backend-contract | 桥接 HTTP + CLI 映射 + 网关代理 + envelope | 页面布局 |
| 06-design-system | token、色板、排版、组件清单、动效 | 页面信息架构 |
| 07-security | 威胁模型、认证、CSP、脱敏、依赖策略 | 性能预算 |
| 08-operations | 运行/构建/部署/端口/升级/排障 | 用户交互设计 |
| 09-testing | 单测/组件/E2E/契约/CI | 功能范围 |
| 10-implementation-plan | 里程碑、目录骨架、验收、变更控制 | 现成代码 |
| 11-accessibility-i18n | a11y、键盘、读屏、zh/en | 视觉 token 定义 |
| 12-glossary | 术语（继承并扩充） | 需求 |
| 13-implementation-status | 进度与差距 | 设计 |
| 14-usage-analytics | 用量页数据口径与图表设计 | 网关调度 |

## 15. 已拍板（原待定问题）

实现阶段按以下结论执行：

| 问题 | 结论 | 说明 |
|---|---|---|
| 桥接推送 | **SSE**（fetch + ReadableStream，不用 EventSource） | 单向、够用、可作为 `text/event-stream` 代理；token 走请求头而非 URL |
| 试打/签到 | **保留但折叠在诊断页**；签到当前只读 | 真实试打需显式确认；统一签到命令尚未接入，不发明 ActionName |
| React Compiler | **不启用**（后续评估） | 先保证行为可预测与可测 |
| 主题 | **默认深色 + 跟随系统** | 支持 light/dark/system、normal/high 对比度；`prefers-reduced-motion` 降级 |
| 包结构 | **`frontend/` 单包** | 不建 workspace，避免污染根目录"零依赖"哲学 |
| 日志实时 | SSE `event: log`，页面隐藏时断开 | 手动上滚即暂停跟随，保留阅读位置 |
