# lobsterai2api — 有道龙虾（LobsterAI）反代

把网易有道 **LobsterAI（有道龙虾）** 桌面端的订阅额度暴露成本机 OpenAI 兼容端点。
本仓库自写，零依赖 Node；不复制、不伪造桌面端凭据。

- 监听：`http://127.0.0.1:8797`
- 上游：`https://lobsterai-server.youdao.com/api/proxy/v1/*`
- 登录态：`%APPDATA%\LobsterAI\lobsterai.sqlite` 的 `kv.auth_tokens`（桌面端自己写的）
- 桌面端模型代理：`%APPDATA%\LobsterAI\openclaw\loopback-state.json` 里的 `ports.tokenProxy`

## 为什么不是重新实现一遍

LobsterAI 桌面端已经有一个本地 tokenProxy：

```
/v1/chat/completions → https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions
```

它负责三件麻烦事：带 access token、401 自动 refresh、把客户端版本/用量头补齐。所以反代
**优先把对话转发给这个本地代理**；桌面端没在跑时，才用 SQLite 里的 access token 直连
上游（同样会在 401 时尝试 refresh，但只在内存里换，不写桌面端数据库）。

反代自己补的是桌面端代理没有的部分：

| 能力 | 来源 |
|---|---|
| `/v1/models` | 上游 `/api/models/available` + 虚拟模型 `yd-fast` / `yd-ultra` |
| `/v1/quota` | 上游 `/api/subscription` + `/api/user/quota` + `/api/user/profile` |
| 签到状态 | 上游 `/api/client-activities/slot` + `/<activity>/context` |
| 签到 | 同上的 `actions/check_in`（只在明确 `checkin:true` 时调用） |
| 虚拟模型解析 | 上游 `/api/models/<id>/resolve` |

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 进程、桌面端代理端口、登录态、SQLite 能力（不输出 token） |
| GET | `/v1/models` | 模型清单；`?refresh=1` 跳过 60 秒缓存 |
| GET | `/v1/quota` | 积分余额 + 积分包 + 签到状态 + 逐模型倍率 |
| GET | `/v1/credits` / `/admin/api/credits` | 同上（别名） |
| POST | `/v1/checkin` | 每日签到（真实领取积分） |
| POST | `/v1/chat/completions` | 对话；`yd-fast` / `yd-ultra` 会先解析成真实模型 |
| * | `/v1/*` | 其余 OpenAI 兼容路径原样透传 |

## 积分与倍率

`/api/subscription` 是本机唯一能拿到「当前还剩多少积分」的接口：

- `boostCreditsRemaining`：积分包（含新订阅活动、每日登录奖励）
- `monthlyCreditsRemaining` / `bonusCreditsRemaining`：套餐月度额度 / 奖励额度
- `trial.creditsRemaining`：试用额度，**已经包含在 boost 包里**，不再重复相加

所以 `balance.total = 本轮积分包总量 + 月度上限 + 奖励上限`，
`balance.remaining = boost + monthly + bonus`。本例账号是 `1099.99/1100`，
分账两行：`新订阅用户活动` 999.99/1000、`每日登录奖励` 100/100。

倍率来自 `/api/models/available` 的 `costMultiplier`（已含分时计价与限时免费），
`limitedFreeActive` 为真时 `effective` 记 0，标签写「限时免费」。

签到状态来自活动接口：今天已签到时 `claimed:true, reward:100`；`actions` 里出现
`check_in` 才认为可签。签到接口是幂等的，重复调用返回 `51104 已领取` 时会转成
「今日已签到」，不会误报成功。

## 用法

```bash
node router.mjs up lobster          # 由 router 托管（:8797）
node router.mjs login lobster       # 打开 LobsterAI 桌面端登录
curl -s http://127.0.0.1:8797/health
curl -s http://127.0.0.1:8797/v1/models
curl -s http://127.0.0.1:8797/v1/quota
curl -s http://127.0.0.1:8797/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

也可以单独跑：

```bash
node integrations/lobsterai2api/lobster-proxy.js --port 8797
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOBSTER_PORT` | `8797` | 监听端口（`--port` 优先） |
| `LOBSTER_HOST` | `127.0.0.1` | 监听地址 |
| `LOBSTER_APP_DATA` | `%APPDATA%\LobsterAI` | 桌面端 userData 根 |
| `LOBSTER_UPSTREAM_BASE` | `https://lobsterai-server.youdao.com` | 上游地址（直连模式） |
| `LOBSTER_CHAT_TIMEOUT_MS` | `1200000` | 对话超时（20 分钟） |
| `LOBSTER_SHORT_TIMEOUT_MS` | `20000` | 模型/额度接口超时 |
| `LOBSTER_CACHE_MS` | `60000` | 模型目录缓存 |
| `LOBSTER_MAX_BODY` | `67108864` | 请求体上限 |

## 边界

- **需要 `node:sqlite`（Node 22.5+）才能读积分**：桌面端代理在跑时对话不需要它，
  但 `/v1/quota` 要读 `auth_tokens`。读不到时会明确回 401，不会编一个余额。
- **不保证非流式**：上游当前对 `/v1/chat/completions` 总是回 SSE（即使 `stream:false`），
  与桌面端行为一致；编码 agent 都走流式，不受影响。
- **虚拟模型会换算**：`yd-fast` / `yd-ultra` 是桌面端的路由档位，反代转发前会先调
  `/api/models/<id>/resolve` 换成真实模型；解析失败直接报错，不把档位名当模型名发给上游。
- **凭据只读**：反代不写 `auth_tokens`；refresh 只发生在内存里。桌面端仍然负责持久化。
- **登录只能在桌面端**：`router login lobster` 只是把 LobsterAI 拉起来，没有命令行登录接口。