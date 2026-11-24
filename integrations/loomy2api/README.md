# loomy2api — 讯飞 Loomy 的 OpenAI 兼容反代

把 Loomy 桌面端（讯飞 iModel）的订阅额度转成本机 OpenAI 兼容端点，供 opencode / pi
和任意 OpenAI 客户端使用。**零依赖**，只读桌面端登录态，不保存新凭证。

```
opencode / pi / curl
  ↓  OpenAI /v1/chat/completions
loomy-proxy.js  127.0.0.1:8791
  ↓  带 session token + ChatId / MsgId / TurnId / traceparent
https://loomyad.xunfei.cn/api/v1   （以 Loomy 桌面端当前配置为准）
```

## 为什么需要它

Loomy 桌面端自己就是 opencode 套壳，它的 `imodel` provider 用 `useSessionAuth: true`：
请求必须带桌面端登录态的 session token，以及 Loomy 的归因头（缺 `traceparent` 时
上游会挂到超时）。opencode / pi 直接连会缺这些上下文，所以中间放一层本机代理，
复用桌面端同一份登录态与额度。

## 启动

```bash
node integrations/loomy2api/loomy-proxy.js
# 或由 router 托管（推荐）：
node router.mjs up loomy
node router.mjs logs loomy 80
```

默认 `127.0.0.1:8791`。端口可用 `LOOMY_PORT` / `PORT` / `--port` 改。

## 登录

Loomy 没有命令行登录接口。打开 **Loomy 桌面端**登录后，它会把登录态写到：

```
C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>\userData\auth-session.json
```

反代每次请求都重新读这个文件，所以桌面端重新登录后无需重启。
非 Windows 或自定义安装位置可用 `LOOMY_CONFIG_ROOT` / `LOOMY_AUTH_FILE` 覆盖。

## 端点

| 端点 | 作用 |
|---|---|
| `GET /health` | 进程、上游地址、登录态（不输出 token） |
| `GET /v1/models` | 模型清单；`?refresh=1` 跳过 60 秒缓存，`?type=chat` 只留对话模型 |
| `GET /v1/quota` | 积分余额 + 逐模型倍率（opencode `provider-credits` 插件用） |
| `POST /v1/chat/completions` | 对话；流式、非流式、工具调用原样透传 |
| `* /v1/*` | 其余 OpenAI 兼容路径原样透传 |

积分接口：

```bash
curl -s http://127.0.0.1:8791/v1/quota
```

返回 `wallet.balance`（常驻积分）+ `wallet.daily`（每日积分）= `wallet.available`。
上游没有给“总额”，所以 `balance.total` 固定为 `0`，客户端应只显示余量而不是编造
百分比。倍率来自模型展示名里的 `(x0.8)` / `（x0.0）` 标记。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LOOMY_PORT` / `PORT` | `8791` | 监听端口 |
| `LOOMY_HOST` | `127.0.0.1` | 监听地址 |
| `LOOMY_CONFIG_ROOT` | `C:\Users\Public\Loomy\<hash>` | Loomy 配置根 |
| `LOOMY_AUTH_FILE` | `<root>\userData\auth-session.json` | 登录态文件 |
| `LOOMY_UPSTREAM_BASE` | 读 Loomy 的 `opencode.json` 里 `provider.imodel.options.baseURL` | 上游地址 |
| `LOOMY_VERSION` | 读桌面端版本 | `loomy-version` 请求头 |
| `LOOMY_CACHE_MS` | `60000` | 模型清单缓存 |
| `LOOMY_CHAT_TIMEOUT_MS` | `1200000` | 对话上游超时（与桌面端一致） |

## 已知边界

- **单账号**：Loomy 登录态只有一份；换号只能在桌面端退出后重新登录。
- **session 失效**：反代返回 401，并提示打开桌面端重新登录；没有自动续期接口。
- **生图模型**：`/models` 里 `type=image` 的条目不能走 `chat/completions`，router 写
  opencode 时用 `?type=chat` 过滤；生图仍请用 Loomy 客户端。
- **倍率来自展示名**：上游没有结构化倍率字段，名字里没写就按“未知/浮动”处理，
  不猜。
- **不签到**：每日积分在 Loomy 桌面端领取，反代与 credits 插件都只读。

---

← 返回 [integrations 索引](../README.md) ｜ [文档索引](../../docs/README.md)
