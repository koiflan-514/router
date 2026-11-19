# 05 后端契约

状态：设计基线
对应需求：FR-101–199
目的：固定浏览器前端与桥接服务、桥接与 CLI/网关的边界

> 本文展开 [00 设计基线](00-design-baseline.md) §3/§6/§11：只定义**桥接 HTTP 契约、CLI 映射、网关代理与统一 envelope**，不定义页面布局（见 [03](03-ui-design.md)）与视觉 token（见 [06](06-design-system.md)）。字段名沿用 00 §6，状态口径引用 00 §7。未落地的命令一律标注**计划增加**，不虚构现有子命令。终端版同构契约见 [`tui/docs/05-backend-contract.md`](../../tui/docs/05-backend-contract.md)。
## 1. 基本原则

1. **桥接是唯一后端**：浏览器只访问 `127.0.0.1:8792` 的 `/api/*`，不直连网关 `127.0.0.1:8785`（网关无 CORS，且无法启停路由器进程）。
2. **参数数组 spawn**：`spawn(node, ['router.mjs', ...args])`，禁止 `sh -c`/`cmd /c`/PowerShell 字符串拼接。
3. **结构化状态只从 JSON 推导**：人类文本只用于日志与诊断展示，**禁止**用正则反推 `ProviderStatus/AccountGroup/QuotaRow/GatewayProviderSnap`。
4. **写后必重新查询**：写动作退出码 `0` 只表示"CLI 报告完成"，真实状态由后续只读查询确认。
5. **JSON 禁含秘密**：access/refresh token、PAT、API Key、Authorization、完整 session/cookie、签名/HMAC 输入、解密材料、提示词与响应正文一律不出现在响应体里（见 §9）。
6. **示例全部匿名**：本文所有 JSON、账号名、uid、路径均为虚构值。
## 2. 统一 envelope 与通用约定
### 2.1 envelope
所有 `/api/*` 的 JSON 响应共用同一外壳（与 CLI `schemaVersion:1` 对齐）：
```json
{ "schemaVersion": 1, "generatedAt": "2026-11-12T03:00:00.000Z", "ok": true, "data": {} }
```

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 当前 `1`；改义/删除字段才递增 |
| `generatedAt` | 桥接生成该响应的 RFC3339 UTC 时间，**不是**上游采集时间 |
| `ok` | `true` 时给 `data`，`false` 时给 `error`，两者互斥 |
| `data` / `error` | 成功载荷 / 失败结构，见 §7 |

HTTP 语义：`200` 成功、`4xx` 请求或权限错误、`5xx` 后端不可用；**业务失败也可能带 `200`**（例如 `account check` 有需处理账号），因此前端**只信 `ok`，不信状态码**。
### 2.2 通用类型、超时与去重
`Resource<T>`、`ProviderStatus`、`Account`、`AccountGroup`、`QuotaRow`、`QuotaBucket`、`GatewayProviderSnap`、`Task`、`AuthState`、`DriftKind` 的定义**原样沿用 00 §6**，本文不复制全文，只说明端点如何产出它们。

| 类别 | 超时 | 去重 | 取消 |
|---|---|---|---|
| 只读状态/额度/账号 | 15s | 同 key 单飞 | 终止只读子进程，保留旧数据并置 `stale` |
| 日志快照 | 10s | `(provider, lines)` | 同上 |
| 写任务 | 不设易中断短超时 | `(action, providerIds, accountKey)` 复用 `actionId` | 协作式：请求断开 → abort → 通知 CLI |
| 交互式（`login`/`account add`） | 无自动短超时 | 单条 | 用户取消 |

超时与"子进程返回非零"是**不同**错误，不得合并（见 §7.3）。
## 3. 读端点

前缀 `/api`；method 与 query 见各小节标题；除 `/logs` 的 `text/plain` 兼容变体外均为 JSON envelope；`provider` 一律是稳定 id。
### 3.1 `GET /health` — 桥接探活 + 网关可达性
**不 spawn**、不读凭证。
```json
{"bridge":{"ok":true,"version":"1.0.0","uptimeSec":812,"port":8792},
 "gateway":{"reachable":true,"host":"127.0.0.1","port":8785,"version":"1.0.0"},
 "root":{"ok":true,"hasRouterMjs":true},"mode":{"demo":false,"readOnly":false}}
```
`gateway.reachable=false` 时 `version=null`，不影响本机八家页面；`root.ok=false` 表示未发现 `router.mjs`，只读源退化为 `BACKEND_UNAVAILABLE`；`mode` 供顶栏显示工作范围徽标。
### 3.2 `GET /env` — 只读环境快照
**不得**含绝对路径、用户名或环境变量值（只含键名白名单）。
```json
{"node":{"version":"v22.19.0","platform":"win32","arch":"x64"},"bridge":{"version":"1.0.0","pid":4321,"port":8792},
 "router":{"rootOk":true,"nodeBin":"node"},"gateway":{"host":"127.0.0.1","port":8785},
 "features":{"sse":true,"demo":false,"readOnly":false,"openCodeCli":true}}
```
`router.nodeBin` 只给可执行名/基名；`features.openCodeCli=false` 时用量页返回 `BACKEND_UNAVAILABLE`。
### 3.3 `GET /providers` — 八家状态
数据源 `node router.mjs list --json`（00 §3.1），逐条映射为 `ProviderStatus` 并补 `drift`（§5.1）；网关条目 `on==up`（叠加层）。
```json
{"providers":[{"id":"qoder-cn","title":"Qoder 国内版","on":true,"up":true,"models":11,"port":8789,
 "pid":1234,"pids":[1234],"control":"spawn","oc":true,"ocUserOwned":false,
 "auth":{"ok":true,"state":"expiring","expiresAt":"2026-11-14T00:00:00.000Z","label":"凭证即将到期"},"drift":[]}]}
```
`models:null` 表示未知（**不是 0**）；`pid:null` 表示无进程。
### 3.4 `GET /accounts?provider=` — 账号池
数据源 `account --json`（不带 `provider`）或 `account <id> --json`（带 `provider`），映射见 §5.2。
```json
{"provider":null,"groups":[{"id":"workbuddy","title":"WorkBuddy 国内版","kind":"workbuddy","switchable":true,
 "accounts":[{"key":"slot-a","name":"example-user","uid":"00000000-0000-0000-0000-000000000001",
 "enabled":true,"active":true,"detail":"凭证剩 29 天","health":{"level":"ok","notes":[]}}]}]}
```
空 `accounts[]` 合法，表示"未登录/无账号池"，前端给登录入口。
### 3.5 `GET /accounts/check?provider=` — 账号体检
数据源 `account check --json`，**只报有问题的账号**；其退出码 `1` 表示"有需处理账号"，**不是**后端失败（§7.3）。
```json
{"issues":1,"groups":[{"id":"codearts","title":"CodeArts Agent","kind":"codearts","switchable":true,
 "accounts":[{"key":"acct-2","name":"example-user-b","uid":null,"enabled":true,"active":true,
 "detail":"上游返回失效","health":{"level":"error","notes":["需要重新登录授权"]}}]}]}
```
### 3.6 `GET /quota?provider=&refresh=` — 额度
数据源优先级见 §10（**优先网关 `balance`**，缺失回退 CLI）；`refresh=1` 请求强制刷新（仍受缓存与超时约束）。
```json
{"fetchedAt":"2026-11-12T03:00:00.000Z","source":"gateway-balance","stale":false,
 "rows":[{"provider":"qoder-cn","kind":"qoder","title":"Qoder 国内版","available":true,"account":"example-user",
 "buckets":[{"id":"addon","label":"加购额度","total":800,"used":704,"remaining":96,"unit":"credits"}],
 "checkin":{"supported":false,"claimable":false,"claimed":false,"rewardCredits":0,"note":"活动未开放"},"error":null,"fetchedAt":"2026-11-12T03:00:00.000Z"}]}
```
`source ∈ gateway-balance | cli | mixed`；`stale=true` 表示有旧数据但本次刷新失败或超阈值；`days` 桶单独成桶，**不并入** credits 汇总。
### 3.7 `GET /logs?provider=&lines=` — 日志快照
数据源 `router.mjs logs <id> <lines>`（人类文本），先清理 ANSI/OSC 与常见密钥再有界返回；正文放进 `data.text`，并提供 `Accept: text/plain` 纯文本变体（无 envelope）。
```json
{"provider":"trae-local","lines":{"requested":200,"returned":200,"truncated":false},
 "text":"2026-11-12 03:00:00 INFO  ready on 127.0.0.1:8787\n…","truncated":false,"receivedAt":"2026-11-12T03:00:00.000Z"}
```
默认 `lines=200`，上限 `2000`；达到上限置 `truncated=true` 并以 `…` 结尾（§6.4）。
### 3.8 `GET /logs/stream?provider=` — 日志跟随（SSE）
桥接按行清理后分块推送，帧格式见 §6；`seq` 单调递增供断线续传。
```text
event: log
data: {"provider":"trae-local","seq":41,"chunk":"INFO request ok\n","truncated":false}
```
### 3.9 `GET /doctor` — 自检
数据源 `node router.mjs doctor`（文本 + 退出码），清理后有界返回。
```json
{"exitCode":1,"issues":2,"truncated":false,"receivedAt":"2026-11-12T03:00:00.000Z",
 "text":"自检\n────\n  ✗ 端口 8787 未监听\n  ✗ opencode 配置缺 2 家\n"}
```
`exitCode` 非零只表示"有需处理项"；`issues` 由退出码粗推断，**不解析文本**。
### 3.10 `GET /health-check?provider=&probe=` — 一键体检
数据源 `node scripts/health.mjs`；**当前只有文本输出**，故现阶段返回：
```json
{"structured":false,"exitCode":0,"issues":null,"truncated":false,
 "text":"qoder-cn  127.0.0.1:8789  11 models  凭证剩 29 天\n"}
```
`probe=1` 触发**真实试打**，绝不自动执行（00 §8）。**计划增加** `health.mjs --json` 后改为对齐 `tui/docs/05` §8.2 的：
```json
{"structured":true,"ok":false,"issues":1,"providers":[
 {"id":"qoder-cn","title":"Qoder 国内版","url":"http://127.0.0.1:8789/v1","reachable":true,
  "httpStatus":200,"models":11,"auth":{"state":"expiring","expiresAt":"2026-11-14T00:00:00.000Z"},"probe":null,"error":null},
 {"id":"codearts","title":"CodeArts Agent","url":"http://127.0.0.1:10087/v1","reachable":false,"httpStatus":0,"models":null,"auth":{"state":"unknown","expiresAt":null},"probe":null,"error":"connect failed"}]}
```
`probe` 非空时为 `{attempted, ok, model, durationMs, kind, detail}`，`kind ∈ success|rate_limited|auth_failed|timeout|upstream_error|invalid_response|unknown`；排队或 429 **不得**归一成进程离线。`--json` 落地前**禁止**用正则解析文本生成上述字段。
### 3.11 `GET /usage?range=` — OpenCode 用量
数据源 OpenCode 官方 `opencode api experimental.session.stats`（只读）；`range` 换算为 `from/to` Unix 毫秒后透传，默认 `7d`，`to` 为查询时刻。口径与图表见 [14 用量分析](14-usage-analytics.md)。
```json
{"range":"7d","from":1762308000000,"to":1762912800000,"stats":{"…":"SessionStats.Info 原样透传"}}
```
`steps` 保留为会话步骤，**不**换算为 HTTP 请求数；`cost` 为 OpenCode 上报值，**不**折算积分。
### 3.12 `GET /gateway/status` — 调度快照
桥接 `fetch` 网关 `GET /v1/gateway/status` 后归一为领域模型（§5.4）；桥接**不管理**网关生命周期，只代理，网关不可达时返回 `BACKEND_UNAVAILABLE`。
```json
{"version":"1.0.0","pid":5678,"uptimeSec":3600,"openMode":true,"strict":false,"quotaSnapshotAt":1762912800000,
 "settings":{"maxAttempts":3,"topN":3,"maxInFlight":4},
 "providers":[{"id":"trae-local","running":true,"dialect":"openai","port":8787,"weight":12.5,"quotaRatio":0.62,
 "inFlight":1,"consecutiveFails":0,"successRate":0.984,"cooldownUntil":null,"cooldownKind":null,"sticky":2}]}
```
`openMode=true` 表示网关处于回环免密钥模式；`weight` 为含额度比/空闲/成功率因子的调度权重。
### 3.13 `GET /gateway/usage?days=` — 网关用量
数据源网关 `GET /v1/gateway/usage?days=N`；网关没跑时回退本地 JSONL。`days` 范围 `1–90`，默认 `7`。
```json
{"days":[{"day":"2026-11-11","requests":128,"errors":3,"inputTokens":411200,"outputTokens":98200,"avgDurationMs":1840,
 "providers":{"trae-local":{"requests":80,"errors":1,"inputTokens":250000,"outputTokens":60000}}}],
 "totals":{"requests":128,"errors":3,"inputTokens":411200,"outputTokens":98200,"avgDurationMs":1840}}
```
`errors` 是网关转发失败计数，与 Provider 离线是两回事。
### 3.14 `GET /gateway/balance` — 网关额度
数据源网关 `GET /v1/gateway/balance`（转发采集器，只覆盖本机 8 家），是 `/quota` 的首选源（§10）。
```json
{"fetchedAt":"2026-11-12T03:00:00.000Z","providers":[
 {"provider":"workbuddy","kind":"workbuddy","title":"WorkBuddy 国内版","available":true,"serviceRunning":true,
  "buckets":[{"id":"credential","label":"凭证有效期","remaining":29,"unit":"days"}],"checkin":{"supported":false,"claimed":false,"rewardCredits":0}}]}
```
`days` 桶不并入 credits 汇总。
### 3.15 `GET /gateway/combos` — 降级链
桥接从网关 `GET /v1/models` 筛出 `owned_by=combo:*` 的虚拟模型行（结构化来源），**不**用正则解析 `gateway combo list` 文本；增删见 §4.5。
```json
{"combos":[{"id":"combo:fast","name":"fast","combo":["trae-local/glm-5.3-flash","zcode/glm-5.3"],
 "strategy":"fallback","context_length":200000,"supportsVision":false,"supportsTools":true}]}
```
`strategy ∈ fallback | round-robin`；`context_length:null` 表示容量未知。
### 3.16 `GET /gateway/free` — 免费供应商
数据源 `node router.mjs providers list --json`（18 家 = 3 家本机免账号 + 15 家有免费额度），只读清单，**不参与** `on/off`。
```json
{"providers":[{"id":"openrouter","name":"OpenRouter","local":false,"format":"openai",
 "baseUrl":"https://openrouter.ai/api/v1","env":"OPENROUTER_API_KEY","keySource":"file","ok":true,
 "reason":null,"free":"部分模型免费","freeModels":["example/free-model"]}]}
```
`keySource ∈ none | file | env`；`ok=false` 时看 `reason`（如"本机服务没在跑"）；**不含** key 值。
### 3.17 `GET /gateway/local-answers` — 本地应答
本地应答开关（省额度）。**计划增加** `gateway local status --json`；落地前 `supported=false` 且只返回清理后文本，前端**只读展示**。
```json
{"supported":false,"switches":{"quota":true,"prefix":true,"title":false,"suggestion":false,"filepath":false},
 "text":"本地应答\n  quota  开启\n  prefix 开启\n"}
```
### 3.18 `GET /gateway/keys`（本文补充）— 网关密钥
**计划增加** `gateway key list --json`；落地前 `supported=false` + 文本。字段对齐 `publicKey`，**只含 SHA-256 前缀 `prefix`，绝不含明文 secret**。
```json
{"supported":false,"keys":[{"id":"k_01","name":"dev","prefix":"rk_example12","disabled":false,
 "createdAt":"2026-11-01T00:00:00.000Z","expiresAt":"2026-12-01T00:00:00.000Z","providers":["trae-local"],
 "models":[],"ips":[],"tokenQuota":2000000,"usedTokens":12345,"note":""}]}
```
### 3.19 `GET /events`（SSE）— 合并事件流
推流 provider 状态变更 + 任务状态，供顶栏与各页订阅；事件类型见 §6.3。
## 4. 写端点与 Action 映射
### 4.1 `POST /actions`
唯一写入口。请求体 `{action, providerIds[], accountKey?, dryRun?}`：
```json
{ "action": "SwitchAccountPreview", "providerIds": ["workbuddy"], "accountKey": "slot-a", "dryRun": true }
```

| 字段 | 规则 |
|---|---|
| `action` | `ActionName` 受控枚举，见 §4.4 |
| `providerIds` | 受影响 provider；`all/none/sync` 可为 `[]` 或全量 |
| `accountKey` | 仅账号类动作需要 |
| `dryRun` | 仅对有预览形态的动作生效（现为账号切换预览） |

成功返回 `{...,"data":{"actionId":"act_7f3a"}}`。规则：**全局串行**；同 `(action, providerIds, accountKey)` 在 `Queued/Running` 期间复用原 `actionId`；`read-only`/`demo` 直接 `403`（§8）。
### 4.2 `GET /actions/:id`
取单次任务的 `Task`（00 §6），用于 SSE 断线时的轮询兜底。
```json
{"actionId":"act_7f3a","action":"Restart","providerIds":["trae-local"],"accountKey":null,
 "startedAt":"2026-11-12T03:00:00.000Z","finishedAt":"2026-11-12T03:00:04.000Z","exitCode":0,"status":"succeeded","stdout":"重启 trae-local…\n","stderr":"","truncated":false,"refreshStatus":"confirmed"}
```
### 4.3 `GET /actions/stream`（SSE）
任务事件流，推 `Task` 生命周期与刷新状态（§6.3）。`refreshStatus` 由桥接在动作结束后跑一次只读查询后置为 `confirmed/failed`；前端**只在 `confirmed` 后**更新 provider 状态。
### 4.4 Action 枚举与 CLI 映射
对齐 00 §3.1。**后台执行 `up/on/all/restart` 必须附加 `--no-login`**，禁止自动打开浏览器。

| ActionName | CLI（`node router.mjs …`） | 危险级 | 说明 |
|---|---|---|---|
| `Start` | `up <id> --no-login` | normal | 起进程 |
| `Stop` | `down <id>` | normal | 停并同步移除客户端 |
| `StopKeepOpenCode` | `down <id> --keep-oc` | normal | 停进程，保留 opencode |
| `Restart` | `restart <id> --no-login` | normal | 重启 |
| `OnlyEnable` | `on <id…> --no-login` | high | 排他：关闭其他家 |
| `Disable` | `off <id…>` | normal | 关开关、停进程、同步 |
| `EnableAll` | `all --no-login` | high | 全开 |
| `DisableAll` | `none` | high | 全关 |
| `Sync` | `sync` | normal | 开关与客户端对齐 |
| `SwitchAccountPreview` | `account <id> <key> --dry-run --json` | normal | 只预览 |
| `SwitchAccount` | `account <id> <key> --json` | normal | 写账号并重启 |
| `EnableAllAccounts` | `account <id> --all --json` | high | 恢复整池 |
| `Login` | `login <id>` | normal | **交互式**，挂起 |
| `AddAccount` | `account add <id>` | normal | **交互式**，挂起 |
| `Probe` | `node scripts/health.mjs <id…>` | normal | 显式真实试打，**从不**自动 |

`dryRun=true` 现仅映射到 `SwitchAccountPreview`；`--all` 对应 `EnableAllAccounts` 与 `up --all`（后者等价"先全开再启动"）；`providerIds=[]` 的全局动作（`all/none/sync`）由桥接补全受影响名单再执行。
### 4.5 其它写端点

| 端点 | body | 行为 | 现状 |
|---|---|---|---|
| `POST /gateway/models/refresh` | `{}` | 代理网关 `POST /v1/gateway/models/refresh`，清空模型缓存 | 现有 |
| `POST /gateway/combos` | `{op:"add"\|"rm", name, models?, strategy?}` | spawn `gateway combo add/rm` | **计划增加** `--json`；落地前返回文本元数据 |
| `POST /gateway/keys` | `{op:"add"\|"rm"\|"disable"\|"enable"\|"reset-usage", name?, providers?, days?, quota?, keyId?}` | spawn `gateway key …` | **计划增加** `--json`；`add` 的明文 secret **只在本次响应出现一次**且不落缓存 |
| `POST /settings` | `{theme?, refreshIntervals?, timezone?, locale?}` | 只改**前端/桥接本地**设置 | 现有设计 |

`POST /settings` **只影响**前端与桥接本地设置（主题、刷新间隔等），**不写** `gateway/data/*`，也**不改变**任何 provider 语义。`readOnly` 开关只经本地配置文件或桥接启动参数，**不**经此端点。
## 5. 字段级规范化

桥接把 CLI/网关的 legacy 结构映射为 00 §6 的领域模型；UI 只消费领域模型。
### 5.1 `router.mjs list --json` → `ProviderStatus`

| 来源字段 | 目标字段 | 规则 |
|---|---|---|
| `id/title/port/on/up/models/pid/pids/control/oc/ocUserOwned` | 同名 | 原样；`models` 允许 `null` |
| `auth.{ok,state,expiresAt,label}` | `auth` | `state` 未知值保留原文并显示 `unknown` |
| （推导） | `drift: DriftKind[]` | 由 `on/up/oc/ocUserOwned` 计算，见 §5.5 |

网关条目 `on==up`（叠加层）；`control` 原样映射显示，不参与状态机。
### 5.2 `account --json` → `AccountGroup`

| 来源 | 目标 | 规则 |
|---|---|---|
| `providers[]` | `groups[]` | 逐家映射 |
| `{id,title,kind,switchable}` | 同名 | `switchable` 直接透传 |
| `accounts[]` | `accounts[]` | `key,name,uid,enabled,active,detail` 原名 |
| `health` | `health` | 缺省补 `{level:"unknown",notes:[]}`，**不得**默认 `ok` |

单家 `account <id> --json` 的 `provider` → `groups[0]`；`uid` 只用于显示与身份对应，**不**拼接文件路径。
### 5.3 额度 → `QuotaRow`
来源为网关 `balance` 的 `providers[]` 或 CLI `qoder2pi credits json` 顶层数组，两者都映射为 `QuotaRow`。

| 场 | 规则 |
|---|---|
| `provider/kind/title/available` | 原样 |
| `reason/detail/account/serviceRunning/error` | 原样；`available=false` 时保留 `reason/detail` |
| `buckets[]` → `QuotaBucket[]` | `id,label,total?,used?,remaining,unit,resetDate?,expiring?`；`unit` 未知值保留原文 |
| `accounts[]` | 多账号行（Trae/CodeArts）；单账号失败只丢该账号，**不**丢整行 |
| `checkin.{supported,claimable,claimed,rewardCredits,note}` | 各自独立，缺省显示未知 |
| `fetchedAt` | 来源数据时间；`receivedAt` 为桥接接收时间，两者分开 |

数值计算前检查 finite 且非负；`days` 桶不并入 credits 汇总；不显示跨家总额/排行榜（00 §7）。
### 5.4 网关 `status` → `GatewayProviderSnap`

| 来源字段 | 目标字段 | 规则 |
|---|---|---|
| `id` | `id` | 原样 |
| （服务端补）`running/dialect/port` | 同名 | `dialect` 仅 `openai\|anthropic\|both\|null` |
| `weight/quotaRatio/inFlight/consecutiveFails/successRate` | 同名 | `quotaRatio` 可为 `null` |
| `cooldownUntil` | `cooldownUntil` | 无冷却为 `null`（网关以 `0` 表示） |
| `cooldownKind` | `cooldownKind` | `0`/空 → `null` |
| `stickySessions` | `sticky` | 重命名 |

`manualWeight/lastUsedAt/cooldownRemainingMs` 等可 additive 透传，UI 不依赖它们做状态判断。
### 5.5 `null` / 未知 / `0` / 空 与 drift
- **四种不同状态**：`null`（未知）、未查询、加载失败、真实 `0`；未知显示 `—`，`0` 显示 `0`。
- `DriftKind ∈ stopped | notSynced | stillRunning`：
  - `on=true && up=false` → `stopped`
  - `on=true && oc=false && !ocUserOwned` → `notSynced`
  - `on=false && up=true` → `stillRunning`
  - `ocUserOwned=true` → **永不**报 `notSynced`
- `up/reachable` 不代表凭证有效；凭证有效不代表 `oc=true`；`oc=true` 不代表请求会成功。
- `stale` 仅在"有旧数据且最近刷新失败或超阈值"时置位。
## 6. SSE 格式约定
### 6.1 帧格式
标准 `text/event-stream`：`event:` 给类型，`data:` 给**单行 JSON**，事件之间空行分隔。
```text
event: task.output
data: {"actionId":"act_7f3a","stream":"stdout","seq":3,"chunk":"重启 trae-local…\n"}

event: task.finished
data: {"actionId":"act_7f3a","status":"succeeded","exitCode":0,"refreshStatus":"confirmed"}
```
### 6.2 心跳与重连
- 心跳为**注释行** `: ping`（默认 15s），不产生 `event`，前端忽略。
- 可选 `retry: 3000`（毫秒）；前端默认指数退避，上限 30s。
- 断线重连带 `Last-Event-ID`（最后 `seq`/`id`），桥接尽力从该点续推；续不上则发 `event: reset` 要求前端**全量重查**。
- 窗口不可见（`document.hidden`）时暂停订阅，恢复可见立即补一次。
### 6.3 事件类型

| 事件 | 通道 | 载荷要点 |
|---|---|---|
| `log` | `/logs/stream` | `{provider, seq, chunk, truncated}` |
| `task.started` | `/actions/stream`、`/events` | `{actionId, action, providerIds, startedAt}` |
| `task.output` | 同上 | `{actionId, stream:"stdout"\|"stderr", seq, chunk}` |
| `task.finished` | 同上 | `{actionId, status, exitCode, refreshStatus}` |
| `refresh.pending` | 同上 | `{actionId}`：动作成功、开始只读确认 |
| `refresh.confirmed` | 同上 | `{actionId, changed:["providers","accounts"]}` |
| `refresh.failed` | 同上 | `{actionId, error}` 区分"动作成功但状态未确认" |
| `providers.changed` | `/events` | `{providers: ProviderStatus[]}` 增量 |
| `reset` | 全部 | `{}` 要求前端全量重查 |
### 6.4 日志流分块与截断
按行边界切块，单块有大小上限；超上限时块尾加 `…`（`\u2026`）并置 `truncated:true`，随后仍可继续推后续块。清理规则同 §9；**不**把日志写回磁盘。
## 7. 错误结构与退出码
### 7.1 错误结构
```json
{"schemaVersion":1,"generatedAt":"2026-11-12T03:00:00.000Z","ok":false,
 "error":{"code":"BACKEND_UNAVAILABLE","message":"local gateway is not running","provider":"codearts","retryable":true}}
```
`error={code, message, provider?, retryable}`；`message` **不得**含秘密、完整凭证路径内容或请求正文；`provider` 只在错误可归因到某家时出现。
### 7.2 错误码表

| code | HTTP | 含义 | retryable |
|---|---|---|---|
| `BACKEND_UNAVAILABLE` | 503 | 网关/CLI 不可达或 spawn 失败 | true |
| `CONTRACT_INVALID` | 502 | 上游 JSON 缺必需字段/类型错误 | false |
| `UNSUPPORTED_VERSION` | 409 | `schemaVersion` 高于已支持 major | false |
| `ACTION_FAILED` | 500 | 写命令非零退出 | 视动作 |
| `READ_ONLY` | 403 | 只读模式拦截写操作（04 的 `readonly` 视为同义） | false |
| `DEMO_FORBIDDEN` | 403 | 演示模式拦截写操作 | false |
| `RATE_LIMITED` | 429 | 上游 busy/限流（**不**等于离线） | true |
| `TIMEOUT` | 504 | 只读查询超时 | true |
| `NOT_FOUND` | 404 | 未知 provider/action/路径 | false |
| `BAD_REQUEST` | 400 | 参数非法（如 `probe` 与 `--no-probe` 冲突） | false |
### 7.3 退出码语义

| 场景 | 退出码 | 语义 |
|---|---|---|
| 只读查询 | `0` | 命令成功，**不代表**所有 provider 都健康 |
| 只读查询 | 非零 | 先尝试解析合法 JSON；解析不出才判后端失败 |
| `account check` | `1` | **有需处理账号**，不是失败 → `GET /accounts/check` 正常 `200` |
| `doctor` | 非零 | 有需处理项 → `data.issues > 0`，非 `ACTION_FAILED` |
| `health.mjs` | 非零 | 有失败项，仍逐项展示 |
| 写命令 | `0` | CLI 报告完成，**仍须**重新查询确认 |
| 写命令 | 非零 | `ACTION_FAILED`，保留退出码与脱敏输出，可做一次只读校正 |
| spawn 失败 | — | `BACKEND_UNAVAILABLE`，与"子进程返回非零"区分 |
## 8. 认证、CSRF 与模式拦截

| 关注点 | 约定 |
|---|---|
| 监听 | 仅 `127.0.0.1:8792`；非回环来源一律拒绝（无"仅 WLAN 调试"开关） |
| 面板 token | 启动生成一次性 token，注入 `index.html` 的 `<meta name="panel-token">`；请求头 `x-panel-token` 携带 |
| 校验 | 所有 `/api/*` 读端点校验 token；写端点额外要求**同源**（`Origin` 匹配） |
| CSRF | token cookie `SameSite=Strict`；写操作要求同源 + token，缺一即 `403` |
| 只读模式 | 命中写端点返回 `403 READ_ONLY`，在**桥接层**拦截，不靠前端隐藏按钮 |
| 演示模式 | `--demo` 下读端点返回匿名 fixtures，写端点返回 `403 DEMO_FORBIDDEN`；**不 spawn、不读真实文件** |
| 网关密钥 | 桥接集中持有回环 token；浏览器**不接触**上游 key 与网关 secret |

拦截点在 `frontend/server/index.mjs` 路由分发早期，早于任何 spawn/文件访问。
## 9. 兼容策略与禁用数据
### 9.1 兼容规则
- **增量优先**：新字段 additive；改义或删除字段**必须**升 `schemaVersion` 并同步 fixtures 与测试。
- 缺失 `schemaVersion` 的旧输出按 **legacy v0** 解析，把本地接收时间记为 `receivedAt`，**不**伪造成上游 `generatedAt`。
- **未知字段忽略**：解析器对未知对象字段透传不报错。
- **未知 enum**：保留原始字符串并显示 `unknown`，**不**崩溃、不默认 `valid`。
- **版本过高**：`schemaVersion` 高于已支持 major 时**停止结构化解析**、返回 `UNSUPPORTED_VERSION` 并提示升级，**不猜测**。
- 字段类型错误只影响最小可行范围；**只有**全局 envelope 损坏才判全局契约失败。
- 未知 provider 可只读显示，但**默认禁止**执行未映射的写动作。
### 9.2 禁止进入契约的数据
- access/refresh token、PAT、API Key、Authorization header。
- 完整 session、cookie、签名、HMAC 输入、解密材料。
- 未脱敏的邮箱、真实用户 ID、本机凭证绝对路径。
- 提示词、模型响应正文、完整请求/响应体。
- 任何可直接重放登录或签名的信息。
- 网关密钥明文（`key add` 返回的 secret 只在当次响应出现一次，不落缓存、不进日志）。

匿名 fixtures 使用 `example-*` 系虚构值；示例中的本机端口不构成秘密。
## 10. 数据源优先级

| 数据 | 首选 | 回退 | 备注 |
|---|---|---|---|
| 额度 | 网关 `GET /v1/gateway/balance` | CLI `qoder2pi credits json` | 回退时用 `source` 标注 |
| Provider 状态 | `router.mjs list --json` | 无 | 无 JSON 即 `BACKEND_UNAVAILABLE` |
| 账号 | `account --json` / `account check --json` | 无 | 已有结构化，直接用 |
| 健康 | `health.mjs --no-probe`（**文本**） | 无 | `--json` 落地前只返回清理后文本，**禁止**正则解析 |
| 网关调度/用量 | 网关 `status` / `usage` | usage 回退本地 JSONL | 桥接只 `fetch`，不管理网关生命周期 |
| 免费供应商 | `providers list --json` | 无 | 只读清单 |
| 组合/密钥/本地应答 | 网关派生 / CLI | 无 | 见 §11 计划端点 |
## 11. 能力缺口与计划端点

以下为**尚未实现**、实现前不可执行的增量（不虚构现有命令）：

| 缺口 | 现状 | 计划 |
|---|---|---|
| 健康 JSON | `health.mjs` 仅文本、`--no-probe` | 增加 `--json`，对齐 `tui/docs/05` §8.2 |
| 组合 JSON | `gateway combo list` 仅文本 | 增加 `--json`；读端点已由 `/v1/models` 派生 |
| 密钥 JSON | `gateway key list` 仅文本 | 增加 `--json`（只出 `prefix`） |
| 本地应答 JSON | `gateway local` 仅文本 | 增加 `gateway local status --json` |
| 本地应答写 | 无桥接端点 | 计划 `POST /gateway/local-answers`（`{switches}`） |
| 密钥读端点 | `GET /gateway/keys` | 本文补充，待 00 基线 §11 采纳 |

上述增量按 `tui/docs/05-backend-contract.md` §12 的增量兼容规则单独提案，**不在本轮改动** `router.mjs` / `gateway/` / `tui/`。
## 12. 相关文档

[00 设计基线](00-design-baseline.md)（§3/§6/§7/§11 为事实来源）·[04 技术架构](04-architecture.md)（桥接目录）·[07 安全与隐私](07-security.md)（脱敏）·[14 用量分析设计](14-usage-analytics.md)（用量口径）·[09 测试策略](09-testing.md)（契约 fixtures）·[`tui/docs/05-backend-contract.md`](../../tui/docs/05-backend-contract.md)（上位同构契约）。
