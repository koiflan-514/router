# 12 术语表

状态：设计基线  
目的：统一 CLI、JSON、TUI、文档和测试中的语义

## 1. 核心对象

### Provider

一个模型来源及其本地接入实例。当前十三家 ID：

- `qoder-cn`
- `qoder`
- `trae-local`
- `codearts`
- `zcode`
- `loomy`
- `raccoon`
- `qwenwork`
- `dumate`
- `lingxi`
- `lobster`
- `workbuddy`
- `workbuddy-global`

`gateway` 是叠加层，不是第十四家反代。

Provider 是路由和控制对象，不等于模型、账号或厂商本身。文档中避免混用“渠道”“线路”“模型源”。

### Region

同一服务商在国内与国际两套独立端点上的区域属性。Qoder 和 WorkBuddy 各有两个 provider，但区域不是独立的第三层控制对象。

### Model

provider 暴露的具体模型。`models` 字段是可取得的模型数量，不代表当前选中模型，也不代表每个模型都通过真实试打。

### Proxy / Gateway

本机常驻反代或网关，将厂商订阅/凭证转换为客户端可用端点。TUI 管理的是现有 router 对它们的控制结果，不直接实现协议转换。

## 2. 服务状态

### 启用开关 `on`

`router.json` 中用户选择的启用状态。表示期望选择，不保证进程运行。

### 进程状态 `up`

当前反代是否运行/端口是否可达，由现有 router 探测。`up=true` 不保证凭证有效或模型请求成功。

### 客户端配置 `oc`

provider 是否出现在 opencode 配置中。与 `on/up` 独立。

### 用户自管配置 `ocUserOwned`

provider 来自用户自己的 `.jsonc` 等配置时，router 不应强行改动。此类配置不应按普通漂移反复报警或自动删除。

### 配置漂移 Drift

需要关注的 `on/up/oc` 不一致。例如：

- `on=true, up=false`：已启用但进程未运行。
- `on=true, oc=false`：已启用但未写入客户端，且不是用户自管。
- `on=false, up=true`：选择关闭但进程仍在。

漂移是状态描述，不总是错误；`down --keep-oc` 等操作可能有意产生特定组合。

### 控制方式 `control`

后端对 provider 的管理方式，例如 router spawn。TUI 原样映射显示，不自行改变进程所有权。

## 3. 账号状态

### Account Key

账号在现有 router 账号池中的稳定 key，用于受控切换命令。不是 API Key，也不是 secret。

### UID

上游或本地账号标识。只用于身份对应和显示，不等于凭证，也不用于拼接任意文件路径。

### 当前生效 `active`

当前正在使用的账号。单账号 provider 与多账号轮询 provider 的显示方式可以不同。

### 参与轮询 `enabled`

账号池内是否参与调度。`enabled=true` 不一定表示当前每一次请求都用它，也不等于 `active=true`。

### 可切换 `switchable`

该 provider 是否支持普通账号切换。Qoder 单账号换号需要重新登录，不能套用 WorkBuddy/Trae/CodeArts 的槽位交互。

### Slot

WorkBuddy 等账号池中的凭证槽位。Slot key 不是凭证内容。

## 4. 认证状态

### `valid`

后端确认凭证当前有效。

### `expiring`

凭证仍可能可用，但接近到期。阈值由后端或明确配置决定，不由 UI 从 label 猜测。

### `expired`

凭证已过期。进程仍可能 `up=true`。

### `missing`

缺少必要凭证或账号。

### `unknown`

后端无法判断。不能为了界面美观归一成 valid 或 expired。

### 登录 Login

现有 CLI 的交互流程，可能包含浏览器 OAuth、PAT 输入、本地临时网关和重启。登录不是只读刷新的一部分。

## 5. 额度与签到

### Credits

特定厂商返回的积分计数。不同厂商的 credits 不保证等值，也不能直接解释成法币。

### Spend

真实货币或明确计费口径下的费用。当前十三家 credits 余额不等于 Spend；没有可靠数据时 TUI 不显示 Spend。

### Remaining / Total / Used

剩余、总量和已用。只有同一账号、同一额度桶、同一单位下才可比较或计算比例。

### Expiring

将在特定日期失效的额度部分。与 remaining、resetDate 分开显示。

### Reset Date

额度重置日期，不必然等于凭证到期日。

### WorkBuddy 凭证代额度

WorkBuddy 没有公开 credits 余额接口。现有 `quota.js` 读取生效 session 的 `auth.expiresAt` 与 `auth.refreshExpiresAt`：

- 凭证有效期 = access token 到期时间；
- 续期有效期 = refresh token 到期时间；
- 两者是凭证寿命，不是可用积分；国际版上游可能让两者相同。

### `days`

WorkBuddy 等来源的凭证有效天数，不是 credits，不能加入积分合计。余额展示带 `d` 后缀
（如 `29d / 39d / 344d`），避免与 credits 数字混淆；该单位通常没有总量，总量为
`None`/`0`/负数/NaN 时显示 `—`，进度只在 `total > 0` 时绘制。

### Check-in

真实领取动作。状态包括已领取、可领取、活动未开放、接口不支持、账号禁用和未知。查询签到状态与执行签到是两个动作。

### Claimable

后端明确判断当前可领取。未知或接口失败不算 claimable。

## 6. 数据状态

### Received At

TUI 成功收到后端数据的时间。

### Fetched At

上游或本地网关实际采集/缓存数据的时间。可能早于 receivedAt。

### Last Success

某数据源最近一次成功刷新时间，用于 stale 判断。

### Stale

有上一份成功数据，但最近刷新失败或超过新鲜度阈值。旧值可以保留，但必须标记，不能冒充实时。

### Unknown / Null

字段未知、未查询或后端无法提供。显示 `—`，不等于数值 0。

### Empty

查询成功且结果为空，例如空账号数组。不是查询失败。

### Partial Failure

某一 provider、账号或数据源失败，其他结果仍有效。不能清空整页。

## 7. 健康与性能

### Reachable

本地端点可连接或按既有健康逻辑可判定服务在线。不等于真实模型请求成功。

### Health Check

默认无真实对话的检查，包括端点、模型列表、凭证等。使用 `--no-probe`。

### Probe

真实 chat completion 试打，可能消耗积分并等待较长时间。只能显式执行。

### Rate Limited / Queued

上游 429 或排队状态。可能表示账号并发/额度限制，不应自动显示为进程离线。

### OpenCode 用量统计

来自官方 `experimental.session.stats` 的只读聚合数据。不是数据库导出，也不是反代日志估算。

### Steps

OpenCode 会话步骤。可以表示活动规模，但不等于 HTTP 请求数、模型调用次数或提示词数量。

### Token 构成

`input`、`output` 与 `reasoning` 分开显示。概览中的 Token 构成值是三者之和；cache.read/cache.write 单独显示，不重复累计。

### OpenCode 上报成本

`cost` 字段原义，是 OpenCode 统计口径下的成本。不是厂商积分余额，不据此推算真实扣费或跨厂商兑换。

### 每日活动

OpenCode `activity[]` 中的每日 steps，用于 Sparkline。没有活动时显示空状态，不生成随机曲线。

### 工具成功率

`tools.totals.succeeded / calls`。只描述工具调用，不代替 HTTP 请求或模型生成成功率。

### TTFT

Time To First Token。需要请求级流式遥测才能准确统计；当前 MVP 不从进程日志猜测。

### Latency / Throughput / Success Rate

请求级延迟、吞吐和成功率。当前没有统一事件数据时不进入 MVP。

## 8. 操作与任务

### Action

TUI 内部受控操作枚举。每个 Action 固定映射到 CLI 参数和副作用，不是用户输入的任意命令。

### Dry Run

只预览账号切换等结果，不写配置、不复制凭证、不重启。正式操作前使用。

### Write Task

会产生状态或配置副作用的任务。MVP 全局串行，不自动重试。

### Confirmed

动作完成后已重新查询到真实状态。不是单纯“进程退出码为 0”。

### Refresh Failed / 状态未确认

命令可能完成，但随后状态查询失败。必须区别于命令失败和已确认成功。

### Read-only Mode

只允许只读能力，在后端调度层阻断写操作，不只是隐藏按钮。

### Demo Mode

完全使用匿名 FixtureBackend，不访问真实 root、Node、账号和反代。模拟动作不改变真实环境。

### Interactive Handoff

TUI 暂时恢复普通终端，把 stdin/stdout/stderr 交给登录等交互 CLI，结束后恢复全屏界面。

## 9. 日志与显示

### Follow

日志视图跟随最新内容。只在页面可见且开启时定时读取。

### Pause

暂停视图跟随，不停止 provider 进程或磁盘日志写入。

### Clear View

清理 TUI 内存中的当前日志，不删除磁盘文件。

### Filter

过滤当前已加载日志，不代表搜索完整历史。

### Redaction

在显示前清理常见秘密和敏感字段。不能替代后端最小化输出。

### Control Sequence Sanitization

去除 ANSI/OSC 等终端控制序列及危险控制字符，防止日志改变终端状态。

### ASCII Mode

用普通 ASCII 符号替代边框和状态字形，适用于缺字或旧终端；不改变状态含义。

## 10. 命令近义词辨析

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
