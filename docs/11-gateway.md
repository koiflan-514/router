# 统一网关运维

网关是 `router.mjs` 的一个子命令族，不是第十三家反代。它把十二家的端口拼成一个，
所以它的运维语义要单独说清——尤其是「为什么它不跟着 `on/off` 走」。

## 启停

```bash
node router.mjs gateway up        # 起（:8785）
node router.mjs gateway down      # 停
node router.mjs gateway restart   # 重启（改了 config.json 后需要）
node router.mjs gateway status    # 调度快照
```

也可以走通用命令（网关在 `PROVIDERS` 里，id 是 `gateway`）：

```bash
node router.mjs up gateway
node router.mjs restart gateway
node router.mjs logs gateway 80
node router.mjs service install gateway    # 登录自启
```

## 客户端怎么接（opencode 与 pi）

`gateway install` 一次写两份 provider，内容同源（模型名都是 `<供应商>/<模型>`）：

```bash
node router.mjs gateway install    # opencode.json + ~/.pi/agent/models.json
node router.mjs gateway uninstall  # 两边一起移除
```

pi 侧只多一件事：`models.json` 里的模型条目把网关的 `context_length` 当成
`contextWindow`，combo 虚拟模型也会一并列出来（id 是 `combo:<名字>`）。如果只想刷新
pi、不想动 opencode，用 `node scripts/pi-models.mjs gateway`。

注意模型清单是**写入时**的快照：上游的目录变了要重跑 install（或 pi-models），
否则 pi 的选择器里还是旧名字。网关进程没起时模型仍会列出来，选中后才会报连不上。

## 为什么网关不参与 on/off 的开关语义

`on` / `off` / `all` / `none` 的语义是「改三处：后端进程、pi 可见性、opencode provider」。
网关不属于这个模型：

- 它没有「关掉」以外的状态——开着才有用；
- 它的 opencode provider（`router-gateway`）是**可选**的，由 `gateway install` 显式写入，
  不跟着开关自动增删。否则 `on gateway` 会顺手把十二家的 provider 全删掉。

所以：

| 行为 | 普通供应商 | 网关 |
|---|---|---|
| `list` 的「开关」列 | 开 / 关 | **叠加** |
| `on` / `off` | 改开关并立即生效 | 不适用（用 `gateway up/down`） |
| opencode provider | 跟着开关自动增删 | 只由 `gateway install/uninstall` 改 |
| drift 提示 | 开关≠进程会提示 | 不提示 |

## 端口交叉校验

网关的 `providers.mjs` 和 router 的 `PROVIDERS` **各有一份端口表**。这是刻意的：
网关只需要「端口 + 方言」，不需要 spawn 命令、日志路径、账号运维逻辑；把它们硬塞进
一张表会让两边都难读。

代价是可能漂移，症状是「请求打到旧端口 → 502」，极难查。所以：

```bash
node router.mjs gateway doctor
```

它先跑网关自检（数据目录、密钥、模型目录、额度快照），再逐条比两边的端口表：

```
端口交叉校验（router PROVIDERS ↔ gateway DESCRIPTORS）
✓ 11 家端口一致
```

加新一家时两处都要改，`doctor` 会指出漏了哪边。

## 改了配置之后

`gateway/data/config.json` 是**启动时读一次**的。改完要：

```bash
node router.mjs gateway restart
```

想让改动立刻生效的只有两类：

- 密钥（`key add/rm/disable`）—— 按 mtime 热加载，不用重启；
- 模型目录 —— `POST /v1/gateway/models/refresh`，或等 60 秒缓存过期。

## 额度快照与权重

调度权重里有一项是「额度比例」。它来自 `gateway/data/quota.json`：

```bash
node router.mjs gateway refresh-quota
```

这条命令走 `integrations/qodbuddy2pi/assets/quota.js` 的采集器，把各家的
`remaining/total` 折算成 `ratio` 写进快照。**快照超过 30 分钟就不再参与权重**
（`scheduler.mjs` 的 `QUOTA_STALE_MS`），避免拿着半天前的数字调度。

没跑过它也能正常工作：所有供应商的 `quotaRatio` 都是 `null`，权重退化成
「闲置时长 + 成功率」——不会因为缺数据就把某家判死。

想让它定时跑：

```bash
# Windows 计划任务，每 30 分钟
schtasks /Create /TN router-gateway-quota /TR "node D:\router\router.mjs gateway refresh-quota" /SC MINUTE /MO 30
```

## 排查顺序

请求失败时按这个顺序看，能少走弯路：

1. **`x-router-provider` 头**——网关说它最终用了哪家。没有这个头说明请求没到网关。
2. **`x-router-attempts` 头**——大于 1 说明换过家。配合 `gateway status` 看是谁在冷却。
3. **`gateway status`**——冷却剩余、连续失败次数、成功率。`cooldownKind` 会说是
   `rate_limit` 还是 `quota` 还是 `auth`。
4. **直连那家反代**——绕过网关打 `http://127.0.0.1:<port>/v1/chat/completions`。
   如果直连也失败，问题在上游或反代，不在网关。
5. **`gateway doctor`**——模型目录拿不拿得到、密钥对不对、端口表一致不一致。

常见症状对照：

| 现象 | 真因 | 修法 |
|---|---|---|
| 所有请求 502 | 十二家都没起 | `node router.mjs up` |
| 单个模型 404 但直连能通 | 模型目录缓存过期 | `POST /v1/gateway/models/refresh` |
| 404 且提示「该模型在：xxx」 | 写错了供应商前缀 | 按提示改前缀 |
| 429「约 N 秒后恢复」 | 该家额度/限流冷却中 | 等，或 `gateway status` 看是哪家 |
| 429「当前并发已满」 | 单家并发打满 | 调 `settings.maxInFlight` |
| opencode 报 API key 无效 | 网关在 `strict` 模式 | 去掉 `strict`，或给客户端配真密钥 |
| 流式只有空帧 | 上游无视 `stream:false`（已被聚合逻辑处理） | 升级到当前版本 |

## 与 OpenResolver 的对应关系

这次升级参考了 [OpenResolver](https://github.com/ZephyrBD/OpenResolver) 的四块设计。
两张表对照着看，便于在两个项目之间搬运经验：

| 能力 | OpenResolver | 本项目 |
|---|---|---|
| 单端口双协议 | `gateway.mjs` | `gateway/server.mjs` |
| `<pool>/<model>` 路由 | `routing.mjs` | `gateway/route.mjs`（多两种写法） |
| 加权/粘性/冷却/熔断 | `pools/base.mjs` | `gateway/scheduler.mjs`（**供应商级**） |
| 密钥 + 白名单 + 配额 | `auth/guard.mjs` + `auth/keys.mjs` | `gateway/auth.mjs` + `gateway/keys.mjs` |
| 按天用量 | `panel/usage.mjs` | `gateway/usage.mjs` |
| 协议转换 | `adapters/*` | `gateway/protocol.mjs` |
| 网页面板 | `panel/` | 不做（已有 Rust TUI） |

刻意不同的三处：

1. **调度单位是供应商，不是账号。** 换账号要改文件再重启进程，一个 HTTP 请求里做不了。
2. **密钥热加载。** OpenResolver 新建密钥后要重启网关；这在 CLI 场景下容易误判成
   「密钥没生成」。
3. **回环默认完全放行，带无效密钥也不拦。** opencode / pi 会强制带占位 `apiKey`，
   只放行「完全不带密钥」会让它们全部 401。
