# 05 后端契约

状态：设计基线  
目的：固定 TUI 与现有 Node.js CLI 的边界、兼容规则和错误语义

## 1. 基本原则

1. `router.mjs` 和既有集成脚本是控制与数据来源。
2. TUI 使用参数数组启动子进程，不经过 `sh -c`、`cmd /c` 或 PowerShell 拼接。
3. 结构化状态只从 JSON 推导；人类文本用于任务输出和诊断展示。
4. 操作后必须重新查询，不从人类文本中解析“启动成功”来伪造状态。
5. JSON 中禁止出现 access token、refresh token、PAT、Bearer、完整 session 或凭证文件内容。
6. 所有示例均为匿名虚构数据。

## 2. 命令映射

### 2.1 现有只读命令

| 能力 | 命令 | 返回 |
|---|---|---|
| Provider 状态 | `node router.mjs list --json` | 顶层对象 |
| 全部账号 | `node router.mjs account --json` | 顶层对象 |
| 单家账号 | `node router.mjs account <id> --json` | 顶层对象 |
| 额度 | `node integrations/qodbuddy2pi/assets/qoder2pi credits json` | 顶层数组 |
| OpenCode 用量 | `opencode api experimental.session.stats --param from=<ms> --param to=<ms> --param tools=summary` | `{ data: SessionStats.Info }` |
| 日志 | `node router.mjs logs <id> <lines>` | 人类文本 |
| 自检 | `node router.mjs doctor` | 人类文本和退出码 |
| 无试打健康 | `node scripts/health.mjs --no-probe` | 当前为文本；计划增加 JSON |

路径示例以 POSIX 分隔符书写；Windows 实现必须传递正确路径对象，不能把命令拼成字符串。

### 2.2 现有写命令

| Action | 参数 |
|---|---|
| `Start` | `up <id>` |
| `Stop` | `down <id>` |
| `StopKeepOpenCode` | `down <id> --keep-oc` |
| `Restart` | `restart <id>` |
| `OnlyEnable` | `on <id...>` |
| `Disable` | `off <id...>` |
| `EnableAll` | `all` |
| `DisableAll` | `none` |
| `Sync` | `sync` |
| `SwitchAccountPreview` | `account <id> <account> --dry-run --json` |
| `SwitchAccount` | `account <id> <account> --json` |
| `EnableAllAccounts` | `account <id> --all --json` |
| `Login` | `login <id>`，交互式挂起执行 |
| `AddAccount` | `account add <id>`，交互式挂起执行 |
| `Probe` | `scripts/health.mjs <id...>`，显式执行真实试打 |

后台执行 `up/on/all/restart` 时必须传 `--no-login`，防止缺凭证时自动打开浏览器或进入不可见交互。只有用户明确选择登录动作时，TUI 才挂起并执行登录命令。

签到没有统一的八家命令。MVP 只启用已经由现有 Node 侧明确支持且能限定 provider/账号的操作；未统一的来源保持只读，待 Node 侧补充契约后再开启。Rust 不直接实现厂商签到协议。

## 3. 进程协议

### 3.1 stdout 与 stderr

- `--json` 查询的 stdout 必须只包含一份完整 JSON。
- stderr 可包含有限诊断，但 TUI 不得把 stderr 拼进 JSON 解析。
- 文本命令的 stdout/stderr 分开捕获，在任务详情中按来源显示。
- 所有文本在展示前去除 ANSI 和不安全控制序列。
- 捕获输出必须有大小上限；达到上限时标记“输出已截断”。

### 3.2 退出码

- 查询命令 `0`：命令执行成功，不代表所有 provider 都健康。
- 查询命令非零：先尝试解析合法结构化结果；无法解析时作为后端失败。
- `health.mjs` 的非零可能表示“检查完成但有失败项”，TUI 必须展示逐项结果。
- 写命令 `0`：CLI 报告动作完成；随后仍需刷新真实状态。
- 写命令非零：动作失败，保留退出码和脱敏输出；可以做一次只读状态校正。
- 无法 spawn 与“子进程返回非零”是不同错误，不得合并。

### 3.3 超时与取消

- 只读状态、额度、日志查询有文档化超时和单请求去重。
- 超时后终止对应的只读子进程，保留旧数据并标记 stale。
- 写命令不套用普通查询短超时，避免在配置写入中途强杀。
- 登录等交互命令没有自动短超时，由用户在挂起终端中完成或取消。
- 进程取消只针对 TUI 启动的子进程，不使用 provider 名或端口做模糊 kill。

## 4. 通用 JSON 约定

新增或扩展 JSON 时遵循：

- `schemaVersion`：非负整数，当前设计版本为 `1`。
- `generatedAt`：RFC 3339 UTC 时间字符串，例如 `2026-11-05T00:00:00Z`。
- ID 使用稳定字符串，不使用表格序号作为跨请求身份。
- 可空字段使用 JSON `null`；未知、未查询和 0 不得混淆。
- 时间戳不转换为时间戳数字后再猜测单位；统一使用字符串。
- 浮点额度由 JSON number 表示；展示时再格式化，不用二进制浮点推导账务。
- 新增可选字段不得破坏旧消费者；移除或改义字段需要升级 schemaVersion。
- Rust 解析忽略未知对象字段；缺失的必需字段产生局部契约错误。

现有输出缺少 `schemaVersion/generatedAt` 时，NodeBackend 按 legacy v0 解析，并把本地成功接收时间记录为 `receivedAt`。不能把接收时间伪造成上游采集时间。

## 5. Provider 状态契约

### 5.1 命令

```bash
node router.mjs list --json
```

### 5.2 目标结构

`schemaVersion`、`generatedAt` 和结构化 `auth.state/expiresAt` 已作为增量字段实现；现有字段保持原名：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-05T00:00:00Z",
  "enabled": ["qoder-cn", "codearts"],
  "providers": [
    {
      "id": "qoder-cn",
      "title": "Qoder 国内版",
      "port": 8789,
      "on": true,
      "up": true,
      "models": 11,
      "pid": 1234,
      "pids": [1234],
      "control": "spawn",
      "oc": true,
      "ocUserOwned": false,
      "auth": {
        "ok": true,
        "state": "expiring",
        "expiresAt": "2026-11-06T00:00:00Z",
        "label": "凭证即将到期"
      }
    }
  ]
}
```

### 5.3 字段语义

| 字段 | 类型 | 规则 |
|---|---|---|
| `enabled` | string[] | 用户启用选择的 ID 集合 |
| `providers` | object[] | 全量 provider，不只包含 enabled |
| `id` | string | 稳定 provider ID，必须是已知白名单或作为未知只读项处理 |
| `title` | string | 显示名称 |
| `port` | integer | 预期本地端口，不代表一定监听 |
| `on` | boolean | 启用开关，不等于进程状态 |
| `up` | boolean | 当前进程/端口是否运行 |
| `models` | integer/null | 可用模型数；null 不是 0 |
| `pid` | integer/null | 主要监听或记录 PID |
| `pids` | integer[] | 相关 PID，可为空 |
| `control` | string | 后端控制方式，原样保留并映射显示 |
| `oc` | boolean | opencode 中是否存在 provider |
| `ocUserOwned` | boolean | 是否为用户自管配置，影响漂移判断 |
| `auth.ok` | boolean | 旧版总体判断，不能独立表达过期 |
| `auth.state` | enum | 新增结构化认证状态 |
| `auth.expiresAt` | string/null | 到期时间，不知道则为 null |
| `auth.label` | string | 人类说明，不作为状态机输入 |

`auth.state` 建议值：`valid`、`expiring`、`expired`、`missing`、`unknown`。后端无法确定时使用 `unknown`，不能默认为 `valid`。

## 6. 账号契约

### 6.1 命令

```bash
node router.mjs account --json
node router.mjs account <id> --json
```

### 6.2 全部账号示例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-05T00:00:00Z",
  "providers": [
    {
      "id": "workbuddy",
      "title": "WorkBuddy 国内版",
      "kind": "workbuddy",
      "switchable": true,
      "accounts": [
        {
          "key": "slot-a",
          "name": "example-user",
          "uid": "00000000-0000-0000-0000-000000000001",
          "enabled": true,
          "active": true,
          "detail": "凭证剩 29 天"
        }
      ]
    }
  ]
}
```

### 6.3 字段规则

- `key` 是切换命令使用的稳定账号标识，来自现有账号逻辑。
- `uid` 仅用于显示和身份对应，不用于拼接任意文件路径。
- `enabled` 表示账号池内参与状态；`active` 表示当前生效；两者可以同时出现不同的合法组合。
- `switchable=false` 时不显示普通切换操作。
- `detail` 只用于补充显示，核心状态应使用布尔或新增结构化字段。
- 空 `accounts` 是合法结果，应显示登录/添加账号入口。

账号切换结果沿用现有 `account --json` 的 `ok/error/provider/accounts` 等结构；TUI 对成功与失败都先检查退出码和结构化结果，不解析 ANSI 文案。

## 7. 额度契约

### 7.1 现有命令与兼容形状

```bash
node integrations/qodbuddy2pi/assets/qoder2pi credits json
```

现有返回是顶层数组，不强行在 MVP 改为对象 envelope。NodeBackend 将其包装为本地 `QuotaSnapshot`，记录 `receivedAt`。

### 7.2 匿名示例

```json
[
  {
    "provider": "qoder-cn",
    "kind": "qoder",
    "title": "Qoder 国内版",
    "available": true,
    "account": "example-user",
    "buckets": [
      {
        "id": "addon",
        "label": "加购额度",
        "total": 800,
        "used": 704,
        "remaining": 96,
        "unit": "credits"
      }
    ],
    "checkin": {
      "supported": false,
      "claimable": false,
      "rewardCredits": 0,
      "note": "活动未开放"
    }
  },
  {
    "provider": "workbuddy",
    "kind": "workbuddy",
    "title": "WorkBuddy 国内版",
    "available": true,
    "serviceRunning": true,
    "buckets": [
      {
        "id": "credential",
        "label": "凭证有效期",
        "remaining": 29,
        "unit": "days"
      }
    ],
    "checkin": {
      "supported": false,
      "claimed": false,
      "rewardCredits": 0
    }
  }
]
```

Trae、CodeArts 的多账号行使用 `accounts[]`。各账号可能包含 `remaining/total/unit/resetDate/expiring/checkin/error` 等字段。解析必须允许单账号失败，不因一个账号缺字段而丢弃整个 provider。

### 7.3 统一规则

- `available=false` 时保留 `reason` 和 `detail`。
- `fetchedAt` 是来源数据时间；`receivedAt` 是 TUI 收到时间，两者分开。
- `days` 不参与 credits 汇总。
- `checkin.supported/claimable/claimed` 各自独立，缺少时显示未知。
- 数值计算前检查 finite 和非负范围；异常值显示原始详情，不 panic。
- 示例结构不是穷尽列表；未知字段忽略，核心字段缺失按局部数据错误处理。

## 8. 健康检查契约

### 8.1 计划命令

```bash
node scripts/health.mjs --no-probe --json
node scripts/health.mjs qoder-cn --json
```

第二条会执行真实试打，只能由用户显式触发。`--no-probe` 与真实试打不能同时出现。

### 8.2 目标结构

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-05T00:00:00Z",
  "ok": false,
  "issues": 1,
  "providers": [
    {
      "id": "qoder-cn",
      "title": "Qoder 国内版",
      "url": "http://127.0.0.1:8789/v1",
      "reachable": true,
      "httpStatus": 200,
      "models": 11,
      "auth": {
        "state": "expiring",
        "expiresAt": "2026-11-06T00:00:00Z"
      },
      "probe": null,
      "error": null
    },
    {
      "id": "codearts",
      "title": "CodeArts Agent",
      "url": "http://127.0.0.1:10087/v1",
      "reachable": false,
      "httpStatus": 0,
      "models": null,
      "auth": { "state": "unknown", "expiresAt": null },
      "probe": null,
      "error": "connect failed"
    }
  ]
}
```

真实试打时 `probe` 为：

```json
{
  "attempted": true,
  "ok": false,
  "model": "example-model",
  "durationMs": 1200,
  "kind": "rate_limited",
  "detail": "HTTP 429: upstream busy"
}
```

`probe.kind` 至少区分 `success`、`rate_limited`、`auth_failed`、`timeout`、`upstream_error`、`invalid_response`、`unknown`。排队或 429 不应自动归一成进程离线。

在 JSON 尚未实现前，TUI 可以把文本健康输出展示为诊断结果，但不得用正则解析文本生成上述字段。

## 9. 日志与 doctor 文本协议

- `logs` 和 `doctor` 首版允许文本协议。
- 退出码、stdout、stderr、是否截断作为元数据保存。
- 文本只用于显示，不能用于构造 Provider/Account/Quota 的结构化状态。
- 删除 ANSI CSI/OSC 等序列及危险控制字符；保留普通换行和可读 Unicode。
- 日志内可能出现的 URL query、Authorization、token 字段和常见密钥形式按安全文档处理。
- TUI 不把日志写回原文件，也不因“清除视图”删除磁盘日志。

## 10. Action 内部结果模型

无论底层命令是否支持 JSON，TUI 统一生成：

| 字段 | 含义 |
|---|---|
| `actionId` | 本次任务唯一 ID |
| `action` | 受控 Action 枚举 |
| `providerIds` | 受影响 provider |
| `accountKey` | 可选账号 key |
| `startedAt/finishedAt` | 本地任务时间 |
| `exitCode` | 可空进程退出码 |
| `status` | queued/running/succeeded/failed/cancelled |
| `stdout/stderr` | 有界、清理和脱敏后的输出 |
| `refreshStatus` | pending/confirmed/failed/notRequired |

该模型属于 Rust 内部，不要求现有 Node CLI 原样输出。

## 11. 错误结构

新增机器接口若返回错误，应使用结构化字段：

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "BACKEND_UNAVAILABLE",
    "message": "local gateway is not running",
    "provider": "codearts",
    "retryable": true
  }
}
```

错误 message 不得包含秘密、完整凭证路径内容或请求正文。现有非 JSON 错误作为文本后端错误处理。

## 12. 兼容策略

### D-06 增量兼容，不解析人类文本推导状态

- 缺失 schemaVersion 的现有 list/account/credits 按 v0 适配。
- 新字段优先 additive；旧字段在迁移期保留。
- TUI 对未知 provider 可以只读显示，但默认禁止执行未映射的写动作。
- 对未知 enum 保留原始字符串并显示 `unknown`，不反序列化崩溃。
- schemaVersion 高于已支持 major 时停止结构化解析并提示升级，不猜测。
- 字段类型错误只影响最小可行范围；全局 envelope 损坏才判全局契约失败。
- 每次契约变更必须同步 fixtures、契约测试、UI 文档和术语。

## 13. 禁止进入契约的数据

- access/refresh token、PAT、API Key、Authorization header。
- 完整 session、cookie、签名、HMAC 输入、解密材料。
- 未脱敏的邮箱、真实用户 ID 或本机凭证绝对路径作为测试 fixture。
- 提示词、模型响应正文、完整请求/响应体。
- 可直接用于重放登录或签名的信息。

账号管理所需的非秘密标识可以返回，但文档和 fixtures 必须使用虚构值。

## 14. OpenCode 用量契约

用量统计是新增只读数据源：

```bash
opencode api experimental.session.stats \
  --param from=<unix-ms> \
  --param to=<unix-ms> \
  --param tools=summary
```

- 使用 OpenCode 官方 `SessionStats.Info`，不从日志或数据库推导。
- `steps` 保留为会话步骤，不转换为 HTTP 请求数。
- 模型包含 `id/providerID/variant`，按 steps 降序。
- Token 分为 input/output/reasoning/cache.read/cache.write；缓存不重复累计。
- `cost` 仅作为 OpenCode 上报值，不能折算厂商积分。
- 工具成功率与模型请求成功率分开。
- 时间范围是调用方提供的 Unix 毫秒区间；当前实现为 24h/7d/30d/全部。
- Windows 优先使用官方 `opencode.exe`，Linux 使用 PATH，支持 `ROUTER_OPENCODE`。
- 查询失败保留上一份数据并标记 stale，不影响 provider 控制。

完整字段、页面和验证规则见 [用量分析与视觉设计](14-usage-analytics.md)。
