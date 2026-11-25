# 12 术语表

状态：设计基线
目的：统一 CLI、桥接、网关、网页面板与测试的语义
上位定义：tui/docs/12-glossary.md

本文是 `frontend/` 网页面板的术语表。所有术语**继承** [`tui/docs/12-glossary.md`](../tui/docs/12-glossary.md)（下称"上位定义"）的语义，本目录只做**扩充**，不重新定义、不改义。上位定义已收录的条目在本文中保持原措辞；网页面板特有或首次在浏览器语境出现的条目以**加粗**标注。若本文与上位定义出现潜在冲突，一律以上位定义为准。

条目分节与上位定义 §1–§10 对齐，第 11 节为命令近义词辨析。示例一律匿名、虚构；`—` 表示未知，不等同于 `0`。

| 归属 | 含义 |
|---|---|
| 继承 | 与上位定义完全一致，此处只是重申 |
| **新增** | 网页面板语境新增 |
| 复用 | 上位定义的既有术语，在本文补充网关/浏览器语境 |

## 1. 核心对象

### Provider

（继承）一个模型来源及其本地接入实例。当前十三家 ID：`qoder-cn`、`qoder`、`trae-local`、`codearts`、`zcode`、`loomy`、`raccoon`、`qwenwork`、`dumate`、`lingxi`、`lobster`、`workbuddy`、`workbuddy-global`；`gateway` 是叠加层，不是第十四家反代。

Provider 是路由与控制对象，不等于模型、账号或厂商本身；面板中避免混用"渠道""线路""模型源"。

### **Compact Chip（紧凑 Provider 标签）**

**新增。**`ProviderChip` 的 `compact` 变体只渲染显示名称，完整 provider id 放在 `title` 与详情抽屉；
总览矩阵、额度卡、报表 Top 用它压缩行高，不丢失可访问名（名称 + id）与分类色圆点。

### **Cache Ratio（缓存比例）**

**新增。**缓存读/写 Token 与输入 Token 的比值，用于说明缓存命中量级。比例 `>1` 用倍数
（如 `21.7× 输入`），`0 < 比例 ≤ 1` 用百分比，`input=0` 或未知显示 `—`；绝对 Token 数不截断。
它**不是** Token 构成的一部分，也不并入 `input + output + reasoning`。

### Region

（继承）同一服务商在国内与国际两套独立端点上的区域属性。Qoder 与 WorkBuddy 各有两个 provider，但区域不是独立的第三层控制对象，面板不提供"区域"页签。

### Model

（继承）provider 暴露的具体模型。`models` 字段是可取得的模型数量，不代表当前选中模型，也不代表每个模型都通过真实试打；`null`（未知）不等于 `0`（无模型）。

### Proxy / Gateway

（复用）本机常驻反代或网关，把厂商订阅/凭证转换为客户端可用端点。十三家反代是 **Proxy**；`gateway`（id=`gateway`，端口 8785）是叠加在十三家之上的**统一网关**。面板把十三家放在"服务"页、把网关放在"网关"页，二者不混列；网关的叠加语义见 §2。

### **Panel（网页面板）**

**新增。**`frontend/` 交付的浏览器控制台。它是 `router.mjs` 与 `gateway/` 已有能力的**只读呈现 + 受控写操作**前端，与 `tui/` 是同一套语义的两个前端（技术栈不同：React/浏览器 vs Rust/终端）。Panel 自身不实现协议转换，也不改写进程与账号逻辑。

### **Bridge（桥接服务）**

**新增。**`frontend/server/` 的本地 Node 服务：把 CLI 以参数数组 spawn、代理网关 HTTP、以 SSE 推流，只监听 `127.0.0.1:8792`。浏览器**不得**直连网关（网关无 CORS，且浏览器不能启停进程），一切读写经 Bridge。契约见 [05 后端契约](05-backend-contract.md)。

### **SPA**

**新增。**单页应用。面板一次加载后，页签切换与筛选在客户端完成，不触发整页刷新；因此"当前页面"由 Route 决定。

### **Route**

**新增。**页面 ID 与 URL 路径的一一对应。页面 ID 一经确定为契约，所有文档与测试都引用它。

| 页面 ID | 路由 | 回答的问题 |
|---|---|---|
| `overview` | `/` | 十三家现在能不能用？哪里漂移？ |
| `providers` | `/providers` | 谁在跑？怎么启停/重启/开关/同步？ |
| `quota` | `/quota` | 余额、凭证天数、签到、重置日？ |
| `accounts` | `/accounts` | 当前生效谁？怎么切/恢复整池？ |
| `logs` | `/logs` | 某家为什么报错？ |
| `diagnostics` | `/diagnostics` | doctor/健康/试打结果？ |
| `usage` | `/usage` | OpenCode 会话/Token/工具/模型聚合？ |
| `reports` | `/reports` | 跨数据源只读汇总、导出与打印？ |
| `gateway` | `/gateway/*` | 调度、用量、降级链、密钥、免费供应商、本地应答 |
| `settings` | `/settings` | 主题、刷新间隔、只读、桥接连接、演示模式 |

### **Search Params / URL 即状态**

**新增。**把"当前选中 provider、时间范围、日志过滤、表格排序、分页"等界面状态写进 URL 查询参数。可分享、可回退、可加书签；刷新后界面还原到同一视图。与"资源缓存"区分：URL 是**视图状态**，`Resource<T>` 是**服务端状态**（见 §7）。

### **Command Palette**

**新增。**键盘优先的命令面板（默认 `⌘K`/`Ctrl+K`），提供切页、跳转与发起受控操作的统一入口。面板命令**只能触发 `Action` 枚举**（见 §9），不接受任意 shell 输入。

## 2. 服务状态

### 启用开关 `on`

（继承）`router.json` 中用户选择的启用状态，表示期望选择，不保证进程运行。

### 进程状态 `up`

（继承）当前反代是否运行/端口是否可达。`up=true` 不保证凭证有效或模型请求成功。

### 客户端配置 `oc`

（继承）provider 是否出现在 opencode 配置中，与 `on`/`up` 独立。

### 用户自管配置 `ocUserOwned`

（继承）provider 来自用户自己的 `.jsonc` 等配置时，router 不应强行改动；此类配置不应按普通漂移反复报警或自动删除。

### 配置漂移 Drift

（继承，落地口径固定）需要关注的 `on`/`up`/`oc` 不一致。面板**由后端字段推导**，不由 UI 猜：

| 条件 | Drift |
|---|---|
| `on=true, up=false` | `stopped` |
| `on=true, oc=false && !ocUserOwned` | `notSynced` |
| `on=false, up=true` | `stillRunning` |
| `ocUserOwned=true` | 永不报同步漂移 |

漂移是状态描述，不总是错误；`down --keep-oc` 等操作可能有意产生特定组合。

### 控制方式 `control`

（继承）后端对 provider 的管理方式（例如 router spawn）。面板原样映射显示，不自行改变进程所有权。

### 网关"叠加"语义

（复用）网关是**叠加层**而非第十三家 provider：它没有独立的开/关，`on` 直接等于进程状态（`on==up`），因此 `on`/`off` 这对写操作对网关不适用；网关的 opencode provider 由 `gateway install` 独立管理。面板在"服务"页对网关隐藏启停按钮。

## 3. 账号状态

### Account Key

（继承）账号在现有 router 账号池中的稳定 key，用于受控切换命令。不是 API Key，也不是 secret。

### UID

（继承）上游或本地账号标识，只用于身份对应和显示；不等于凭证，也不用于拼接任意文件路径。

### 当前生效 `active`

（继承）当前正在使用的账号。单账号 provider 与多账号轮询 provider 的显示方式可以不同。

### 参与轮询 `enabled`

（继承）账号池内是否参与调度。`enabled=true` 不一定表示当前每一次请求都用它，也不等于 `active=true`。

### 可切换 `switchable`

（继承）该 provider 是否支持普通账号切换。Qoder 单账号换号需要重新登录，不能套用 WorkBuddy/Trae/CodeArts 的槽位交互。

### Slot

（继承）WorkBuddy 等账号池中的凭证槽位。Slot key 不是凭证内容。

### **Dry Run（账号切换预览）**

（复用）只预览切换结果，不写配置、不复制凭证、不重启。面板把 `account <id> <key> --dry-run --json` 呈现为"预览"，与 §9 的通用 Dry Run 同一语义；正式切换前必须先预览。

## 4. 认证状态

### `valid` / `expiring` / `expired` / `missing` / `unknown`

（继承）五个取值来自后端 `auth.state`，面板只显示接收到的枚举，不从 `label` 文本或颜色猜测。

| 状态 | 含义 | 注意 |
|---|---|---|
| `valid` | 后端确认凭证当前有效 | 不代表请求一定成功 |
| `expiring` | 仍可能可用但接近到期 | 阈值由后端决定 |
| `expired` | 凭证已过期 | 进程仍可能 `up=true` |
| `missing` | 缺少必要凭证或账号 | — |
| `unknown` | 后端无法判断 | 不得归一成 valid/expired |

### 登录 Login

（继承）现有 CLI 的交互流程，可能包含浏览器 OAuth、PAT 输入、本地临时网关和重启。登录不是只读刷新的一部分；在面板中属于交互式动作，见 §9 的 **Interactive Handoff**。

## 5. 额度与签到

### Credits

（继承）特定厂商返回的积分计数。不同厂商的 credits 不保证等值，也不能直接解释成法币。

### Spend

（继承）真实货币或明确计费口径下的费用。当前十三家 credits 余额不等于 Spend；没有可靠数据时面板不显示 Spend。

### Remaining / Total / Used

（继承）剩余、总量和已用。只有同一账号、同一额度桶、同一单位下才可比较或计算比例。面板不显示跨家总额或排行榜。

### Expiring

（继承）将在特定日期失效的额度部分，与 remaining、resetDate 分开显示。

### Reset Date

（继承）额度重置日期，不必然等于凭证到期日。

### WorkBuddy 凭证代额度

（继承）WorkBuddy 没有公开 credits 余额接口。读取生效 session 的 `auth.expiresAt` 与 `auth.refreshExpiresAt`：凭证有效期 = access token 到期时间；续期有效期 = refresh token 到期时间。两者是凭证寿命，不是可用积分；国际版上游可能让两者相同。

### `days`

（继承）WorkBuddy 等来源的凭证有效天数，不是 credits，**不能**加入积分合计，也不并入跨家汇总。

### Check-in

（继承）真实领取动作。状态包括已领取、可领取、活动未开放、接口不支持、账号禁用和未知。查询签到状态与执行签到是两个动作。

### Claimable

（继承）后端明确判断当前可领取。未知或接口失败不算 claimable。

## 6. 网关

### **Scheduler 快照**

（复用）`GET /v1/gateway/status` 返回的调度视图，面板原样展示，不重算权重。字段含义与 `gateway/README.md` 一致：

| 字段 | 含义 |
|---|---|
| `weight` | 最终权重 = `(quotaFactor + idleBonus + successFactor) × manualWeight` |
| `quotaFactor` | 额度比例 × 10；无快照时取同批已知均值，不惩罚 |
| `idleBonus` | `min(闲置小时 × 0.5, 5)`；从未用过按 999 小时计 |
| `successFactor` | 最近 50 次成功率 × 3 |
| `manualWeight` | `config.weights[id]`，默认 10；`0` = 硬过滤 |
| `quotaRatio` | 额度比例快照值，可为 `null`（未知） |
| `successRate` | 最近成功率，独立于 `successFactor` 展示 |

面板"网关"页默认每 5s 拉取该快照（策略见 §7，性能符号见 §8）。

### Cooldown

（复用）某家因失败被临时摘出轮转的时间窗。**冷却只增不减**：短冷却不能抹掉仍在生效的长冷却。面板对冷却中的上游显示截止时间，而非"离线"。

### **CooldownKind**

（复用）失败分类，决定冷却时长与是否换家。词汇与 `gateway/README.md` §调度 一致：

| 类别 | 触发 | 冷却 | 换家 |
|---|---|---|---|
| `auth` | 401/403、"no credentials" | 2 分钟 | ✓ |
| `permission` | 403、"request not allowed" | 5 秒 | ✓ |
| `billing` | 402、"额度不足" | 2 分钟 | ✓ |
| `rate_limit` | 429、"rate limit" | 2 秒起，翻倍 | ✓ |
| `overloaded` | 502/503/504/529 | 30 秒 | ✓ |
| `context_window` | "context_length_exceeded" | 不冷却 | ✗ |
| `invalid_request` | 其余 4xx | 不冷却 | ✗ |
| `upstream` / `timeout` | 5xx、网络错误、408 | 30 秒 | ✓ |

### **Sticky**

（复用）粘性会话：同一会话在 `stickyLimit` 内优先复用上一次的供应商，避免每次请求换家。面板展示粘性计数，不改变粘性策略。

### **inFlight**

（复用）当前并发中的请求数，受 `settings.maxInFlight` 限制。它是运行态计数，不累积为历史量。

### Combo（降级链）

（复用）用户命名的**有序链**，可跨供应商跨模型。规则（正文增量之前的失败换链、思考增量不算正文、容量取交集、全不可用仍保留并标注）与 `gateway/README.md` 一致。面板"网关 / 降级链"页只读展示，链的增删仍走 CLI（`gateway combo add|rm`）。

### Alias（别名）

（复用）`config.aliases` 定义的模型别名，如 `fast → trae-local/glm-5.3-flash`。面板区分"别名"与"combo 名"：别名指向单点，combo 指向有序链。

### Fallback

（复用）显式前缀失败后的备份供应商顺序（`config.fallbacks`）。默认**不扩散**：写死 `trae-local` 就是 `trae-local`。

### **explicitFailover**

（复用）打开后，显式前缀也参与跨供应商转移。默认关闭；面板只显示其开关状态与含义。

### **Local Answer（本地应答）**

（复用）网关在进程内直接回答"答案已写在请求体里"的固定问题（`quota`/`prefix`/`title`/`suggestion`/`filepath`），以省额度。响应头 `x-router-local-answer` 标明是哪一项。面板"网关 / 本地应答"页展示各项开关，不展示真实回答正文。

### **Free Provider（免费供应商）**

（复用）18 家由网关直接当上游的免费供应商（3 家本机免账号 + 15 家有免费额度）。它们**不在** `PROVIDERS`，不参与 `on/off`；面板在"网关"页的只读清单中展示，不提供启停按钮。

### **Quota Snapshot**

（复用）`gateway/data/quota.json`，由 `gateway refresh-quota` 写入，是 `quotaFactor` 的来源。它是**快照**而非实时余额；面板标注其采集时间，缺失时相关字段为 `null`。

### **Gateway Key**

（复用）访问网关用的密钥（`gateway/data/keys.json`，前缀 `zsk_`，只存 SHA-256）。与"上游 key"（`providers.json`，本网关访问上游）是**两个方向**的凭据，不要混淆。面板"网关 / 密钥"页只显示前缀与元数据，明文只在创建时显示一次。

### **strict / openMode**

（复用）`strict=true`（或 `ROUTER_GATEWAY_STRICT=1`）时回环也要求有效密钥；默认 `false` 为回环免密钥、带无效密钥也不拦。面板显示当前模式与影响，不代替网关做鉴权。

### **upstream dialect / shape**

（复用）上游协议方言与响应形状。`x-router-upstream-dialect` ∈ `openai|anthropic|both`；`x-router-upstream-shape` ∈ `sse|json`。形状**看体不看头**：网关先嗅探首块再决定读法。面板在网关页提示这两个头用于排查，不据此解析正文。

## 7. 数据状态

### Received At

（继承）桥接成功收到后端数据的时间。

### Fetched At

（继承）上游或本地网关实际采集/缓存数据的时间，可能早于 receivedAt。

### Last Success

（继承）某数据源最近一次成功刷新时间，用于 stale 判断。面板顶栏常驻显示各数据源的最后成功时间。

### **Resource（网页面板统一资源状态）**

**新增。**面板所有服务端只读数据的统一外壳 `Resource<T>`，字段固定：

```ts
type Resource<T> = {
  data: T | null;          // 最近一次成功
  lastSuccessAt: Iso | null;
  receivedAt: Iso | null;  // 桥接收到的时间
  error: { code: string; message: string; retryable: boolean } | null;
  stale: boolean;          // 有旧数据但最近刷新失败/超阈值
};
```

四种"没有数据"必须区分：`data=null` 且无 `error`（未查询/加载中）、`data=null` 且有 `error`（失败）、`data=T` 且 `stale`（旧值）、真实的 `0`/空数组（有效值）。URL 状态与 `Resource<T>` 互相独立：前者进 URL，后者进缓存。

### Stale

（继承）有上一份成功数据，但最近刷新失败或超过新鲜度阈值。旧值可以保留，但必须标记，不能冒充实时。面板**仅在**"有旧数据且最近刷新失败或超阈值"时置位。

### Unknown / Null

（继承）字段未知、未查询或后端无法提供。显示 `—`，不等于数值 0。

### Empty

（继承）查询成功且结果为空，例如空账号数组。不是查询失败。

### Partial Failure

（继承）某一 provider、账号或数据源失败，其他结果仍有效。不能清空整页。

## 8. 健康与性能

### Reachable

（继承）本地端点可连接或按既有健康逻辑可判定服务在线。不等于真实模型请求成功。

### Health Check

（继承）默认无真实对话的检查，包括端点、模型列表、凭证等，使用 `--no-probe`。面板健康项在 `--json` 落地前允许展示**清理后的文本**，不得用正则生成结构化字段。

### Probe

（继承）真实 chat completion 试打，可能消耗积分并等待较长时间。只能显式执行，面板**从不自动**触发。

### Rate Limited / Queued

（继承）上游 429 或排队状态。可能表示账号并发/额度限制，不应自动显示为进程离线。

### Steps

（继承）OpenCode 会话步骤。可以表示活动规模，**永远不等于** HTTP 请求数、模型调用次数或提示词数量。

### Token 构成

（继承）`input`、`output` 与 `reasoning` 分开显示。概览中的 Token 构成值是三者之和；`cache.read`/`cache.write` 单独显示，不重复累计。

### OpenCode 上报成本

（继承）`cost` 字段原义，是 OpenCode 统计口径下的成本。不是厂商积分余额，不据此推算真实扣费或跨厂商兑换。

### 每日活动

（继承）OpenCode `activity[]` 中的每日 steps，用于 Sparkline。没有活动时显示空状态，不生成随机曲线。

### 工具成功率

（继承）`tools.totals.succeeded / calls`。只描述工具调用，不代替 HTTP 请求或模型生成成功率。

### TTFT（不在 MVP）

（继承）Time To First Token。需要请求级流式遥测才能准确统计；面板不进入 MVP，也不从进程日志猜测。

## 9. 操作与任务

### **Action / Task（前端受控操作与任务）**

**新增（`Action` 复用，`Task` 为面板内部模型）。**`Action` 是受控操作枚举，每个 Action 固定映射到 CLI 参数与副作用，不是用户输入的任意命令。写操作经 Bridge `POST /api/actions` 返回 `actionId`，其生命周期用 `Task` 表示：

```ts
type Task = {
  actionId: string; action: ActionName; providerIds: string[];
  accountKey?: string | null;
  startedAt: Iso; finishedAt: Iso | null; exitCode: number | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stdout: string; stderr: string; truncated: boolean;
  refreshStatus: 'pending' | 'confirmed' | 'failed' | 'notRequired';
};
```

采用 React 19 Actions：**pending 不预改状态**，完成后**重新查询**，只在确认后才更新 UI。写任务**全局串行**，同目标重复提交去重。

### Dry Run

（继承）只预览结果，不写配置、不复制凭证、不重启，正式操作前使用。

### Write Task

（继承）会产生状态或配置副作用的任务。MVP 全局串行，不自动重试。

### Confirmed

（继承）动作完成后已重新查询到真实状态。不是单纯"进程退出码为 0"。

### Refresh Failed / 状态未确认

（继承）命令可能完成，但随后状态查询失败。必须区别于命令失败和已确认成功。对应 `Task.refreshStatus='failed'`。

### Read-only Mode

（继承）只允许只读能力，**在桥接层**阻断写操作，不只是隐藏按钮。

### Demo Mode

（继承）完全使用匿名 fixtures，不 spawn 任何进程、不访问真实文件；模拟动作不改变真实环境。桥接的 `--demo` 工作范围（local/demo）在顶栏常驻显示。

### **Interactive Handoff（等待外部终端）**

**新增。**浏览器无法接管 `login`/`account add` 等交互式 CLI 的 stdin。Bridge 只**发起并等待**，把交互留给用户在原生终端完成；面板显示"等待外部登录完成"并可取消。这与上位定义的 TUI Interactive Handoff 目标一致，媒介不同。

### **SSE**

**新增。**Server-Sent Events，单向服务端推流。面板用它承载日志跟随（`GET /api/logs/stream`）、任务进度（`GET /api/actions/stream`）与状态事件（`GET /api/events`）。选择 SSE 而非 WebSocket，因为需求单向、易代理；仅页面可见且开启时保持连接，不可见时暂停。

## 10. 展示与安全

### Redaction（脱敏）

（继承）在显示前清理常见秘密和敏感字段，不能替代后端最小化输出。面板要求 JSON 中禁止出现 token、PAT、API Key、Authorization、完整 session/cookie、签名/HMAC 输入、解密材料、提示词或响应正文。

### Control Sequence Sanitization

（继承）去除 ANSI/OSC 等终端控制序列及危险控制字符。日志与任务输出先剥离控制序列并脱敏，再有界返回（默认 ≤2000 行），防止恶意日志改变终端/页面状态。

### Provider 分类色

（复用）稳定的 provider 到颜色的映射，对齐上位 `usage-analytics` 约定：`codearts` 紫 · `qoder-cn` 青 · `qoder` 蓝 · `trae-local` 绿 · `workbuddy` 黄 · `workbuddy-global` 浅紫 · `zcode` 橙 · `loomy` 洋红 · `gateway` 中性。状态**不只靠颜色**，同时有文字/图标/数值。

### **Envelope（响应包络）**

**新增。**Bridge 对所有 `/api` 响应的统一外壳，与 CLI 的 `schemaVersion:1` 对齐：

```json
{ "schemaVersion": 1, "generatedAt": "2026-11-12T00:00:00Z", "ok": true, "data": {} }
```

失败时 `ok=false` 并带 `error`。它描述**传输层**结果；业务层的"未知/空/部分失败"仍由 `Resource<T>` 与数据自身表达。

### **`x-panel-token`**

**新增。**Bridge 启动时生成的一次性 token，注入页面并在写请求头携带；配合 `SameSite=Strict` 防 CSRF，写操作要求同源 + token。它是本机会话凭证，不进入日志、不进 URL。

### **CSP**

**新增。**Content-Security-Policy。面板与 Bridge 部署时限制脚本/连接来源为自身与回环，禁止内联脚本与外部 CDN；与"只监听回环""非回环来源一律拒绝"共同构成安全边界。细节见 [07 安全与隐私](07-security.md)。

## 11. 命令近义词辨析

| 容易混淆 | 正确区别 |
|---|---|
| 启动 vs 启用 | `up` 启动进程；`on` 修改启用选择且排他 |
| 停止 vs 关闭 | `down` 停进程；`off` 修改开关、停进程并同步 |
| 停止 vs 停止保留配置 | 普通 down 会同步移除客户端；`--keep-oc` 保留 |
| 全部关闭 vs 停止全部进程 | `none` 还会清空启用选择并同步客户端 |
| 当前账号 vs 参与轮询 | active 与 enabled 是不同字段 |
| 服务在线 vs 请求成功 | up/reachable 不代表 probe 成功 |
| 额度查询 vs 签到 | 一个只读，一个是真实领取 |
| 无试打健康 vs 真实试打 | `--no-probe` 不发送真实对话 |
| 收到时间 vs 采集时间 | receivedAt 与 fetchedAt 不同 |
| 积分为 0 vs 查询失败 | 0 是有效数值，失败是资源状态 |
| 空日志 vs 清除磁盘日志 | 视图状态不改变原文件 |
| **前端"刷新" vs 后端重查** | 前端刷新只是再取一次缓存/接口，可能拿到同样的服务端缓存；后端重查（网关 `models/refresh`、`refresh-quota`）才令上游/快照真正变化 |
| **"演示数据" vs 真实数据** | Demo Mode 的 fixtures 全为匿名虚构，不代表本机任何真实状态；真实数据来自 CLI/网关且同样脱敏 |
| **"关闭面板" vs 关闭 provider** | 关闭面板/页签只影响浏览器视图；关闭 provider 是执行 `off`/`down` 等写操作，改变本机进程与配置 |
| **关闭本地应答 vs 关闭网关** | `gateway local off` 只关省额度的本地应答，网关仍在服务；网关没有独立 on/off |
| **冷却 vs 离线** | 冷却中的上游仍在运行，只是被临时摘出轮转；离线是进程/端口不可达 |
| **别名 vs combo** | alias 指向单个模型；combo 是有序降级链 |
| **清理视图 vs 清理密钥** | 清空页面/视图不动数据；`gateway key rm` 会真实删除密钥 |
| **只读模式 vs 隐藏按钮** | 只读在桥接层拦截写；仅隐藏按钮不构成只读 |
