# dumate2api — 百度搭子（DuMate）的 OpenAI 兼容反代

把百度搭子桌面端（DuMate，千帆桌面版）的订阅积分转成本机 OpenAI 兼容端点，供
opencode / pi 和任意 OpenAI 客户端使用。**零依赖**，只读桌面端落盘的登录态与模型目录，
不保存新凭证。

```
opencode / pi / curl
  ↓  OpenAI /v1/chat/completions
dumate-proxy.js  127.0.0.1:8795
  ↓  自动发现随机端口 + 免鉴权透传
http://127.0.0.1:<随机端口>/api/qianfanproxy/v1   （dumate-main-server.exe）
```

## 为什么需要它

DuMate 桌面端自己就是 opencode 套壳：它启动一个 Go 写的 `dumate-main-server.exe`，
在上面暴露 `/api/qianfanproxy/v1/chat/completions`。这个端点**不需要鉴权**——鉴权在
桌面端进程内部完成（它带着百度智能云的登录态去调 console）。

但直接连它有两个障碍：

1. **端口每次启动随机分配**（实测 52730、52985 之类），客户端没法写死 baseURL；
2. **没有模型清单接口**：`/api/qianfanproxy/v1/models` 返回 404，模型表只存在于
   桌面端落盘的 opencode 配置里。

所以中间放一层本机代理：固定端口 8795、动态发现上游端口、从桌面端配置读模型目录，
复用同一份登录态与积分。

## 启动

```bash
node integrations/dumate2api/dumate-proxy.js
# 或由 router 托管（推荐）：
node router.mjs up dumate
node router.mjs logs dumate 80
```

默认 `127.0.0.1:8795`。端口可用 `DUMATE_PORT` / `PORT` / `--port` 改。

## 登录

DuMate 没有命令行登录接口。打开 **百度搭子桌面端**登录后，它会把账号写到：

```
%APPDATA%\qianfan-desktop-app\auth.json
```

结构是 `{ activeProfileId, accountProfiles: [{ profileId, displayName, bceUserId, loginType }] }`。
反代每次请求都重新读，所以桌面端重新登录后无需重启。

```bash
node router.mjs login dumate      # 拉起桌面端并等它写回登录态
node router.mjs account dumate    # 单账号信息（昵称 / 登录方式 / 登录时间）
```

## 端口是怎么发现的

main-server 的端口只在启动时写进日志，反代按顺序找：

| 顺序 | 来源 | 匹配 |
|---|---|---|
| 1 | `DUMATE_MAIN_PORT` 环境变量 | 直接用（调试/固定端口时用） |
| 2 | `log\electron.log` | `[Backend] Started on port (\d+)` / `--port=(\d+)` |
| 3 | `log\desktop-main\Main.log` | 应用配置里的 `"Port":(\d+)` |
| 4 | 进程命令行（PowerShell） | `dumate-main-server.exe … --port=(\d+)` |

发现结果缓存 5 秒；请求连不上时**强制重新发现并重试一次**，所以桌面端重启换端口后
反代不用重启。

> ⚠️ 日志会持续增长（前端每次请求都写一行）。启动时写的端口行可能早已被挤出
> 「末尾 N 字节」窗口，所以查找分三级：末尾 1MB → 开头 1MB → 整份（上限 64MB）。
> 只读末尾会让额度接口在桌面端跑久了之后间歇性失败。

## 模型目录从哪来

扫描 `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<账号>\config\opencode\opencode.json`，
取 mtime 最新的一份，读 `provider.QianfanPersonalQuota.models`。按文件 mtime 缓存，
桌面端升级/换号后自动跟上；`?refresh=1` 可跳过缓存。

剔掉内部条目：`llm-mock`、`dumate-image*`（生图）、`qianfan-ocr`、`qwen3-embedding*`、
`qwen3-reranker*`、`model-*`（路由/校验/摘要等内部子模型）。保留 `dm-auto-model/*`
（自动选择入口，实测可调）。当前 23 个对话模型。

模型 id 直接用配置里的 key（`glm-5`、`qwen4-max`、`kimi-k31`…）。注意 `glm-5` 在配置里
的 `id` 字段是 `model-text`，但**实测直接传 `glm-5` 也能通**，代理按客户端请求原样透传。

## 端点

| 端点 | 作用 |
|---|---|
| `GET /health` | 进程、上游端口与来源、登录态、模型数、限流快照（不输出 key） |
| `GET /v1/models` | 模型清单；`?refresh=1` 跳过缓存 |
| `GET /v1/quota` | 积分余额 + 积分包明细（opencode `provider-credits` 插件用） |
| `GET /v1/credits` | 同上（别名） |
| `POST /v1/chat/completions` | 对话；流式、非流式、工具调用原样透传 |
| `* /v1/*` | 其余 OpenAI 兼容路径原样透传 |

积分接口：

```bash
curl -s http://127.0.0.1:8795/v1/quota
```

上游是 main-server 的 `GET /api/dumate/points/quota_overview`，需要两个头：

- `X-Dumate-Inapp-Key`：桌面端**这次启动**生成的 key，只写在 `log\electron.log` 的
  `DUMATE_INAPP_KEY: '<64 hex>'` 里，不在任何配置文件里；
- `X-Dumate-Account-Id`：`auth.json` 里的 `bceUserId`。

与 Loomy / 小浣熊不同，这家给的是**总额与已用**（`totalPoints` / `usedPoints`），
所以 `balance.total` 是真实分母，客户端可以画进度条。`subscriptions[]` 把订阅套餐、
登录奖励、活动赠送分开列（含到期时间）。上游被 401/403 拒绝时反代会重读 key 再试一次。

**没有逐模型倍率**：`multipliers` 返回空对象，显示端应报「上游没有公开倍率」，不猜。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DUMATE_PORT` / `PORT` | `8795` | 监听端口 |
| `DUMATE_HOST` | `127.0.0.1` | 监听地址 |
| `DUMATE_APP_DATA` | `%APPDATA%\qianfan-desktop-app` | 桌面端 userData 根 |
| `DUMATE_MAIN_PORT` | 自动发现 | 固定 main-server 端口（跳过发现） |
| `DUMATE_OPENCODE_JSON` | 自动扫描 | 指定模型目录文件 |
| `DUMATE_INAPP_KEY` | 读 `electron.log` | 固定 in-app key |
| `DUMATE_ACCOUNT_ID` | 读 `auth.json` | 固定账号 id |
| `DUMATE_CACHE_MS` | `60000` | 通用缓存时长 |
| `DUMATE_SHORT_TIMEOUT_MS` | `15000` | 额度/探活超时 |
| `DUMATE_CHAT_TIMEOUT_MS` | `1200000` | 对话上游超时（桌面端允许长任务） |
| `DUMATE_MAX_BODY` | `67108864` | 请求体上限（64MB） |
| `DUMATE_LIMITS` | 开 | 设 `off` 临时关掉本机限流（调试用，别长期关） |

本机限流走 `integrations/limits/limiter.js`：`dumate` 硬约束并发 2、默认档 `balanced`
（40/分钟、间隔 1.5 秒）。客户端可以绕过网关直连 :8795，所以反代自己也必须限。

## 已知边界

- **单账号**：登录态只有一份；换号只能在桌面端退出后重新登录。
- **桌面端必须在跑**：main-server 不在时反代返回 503 +「百度搭子桌面端未运行：请先打开 DuMate」。
  反代不自己拉起桌面端（那是 `router login dumate` 的事）。
- **没有 `/v1/models` 上游**：模型目录只能读文件；桌面端没写过配置时返回 503。
- **生图/OCR/向量模型不对外**：`dumate-image*`、`qianfan-ocr`、`qwen3-embedding*` 等被剔掉，
  它们不能走 `chat/completions`。
- **reasoning_content**：上游会返回思考内容（非流式在 `message.reasoning_content`，
  流式在 `delta.reasoning_content`），原样透传。短 `max_tokens` 可能全花在思考上，
  表现为「回复为空 + finish_reason=length」，不是故障。
- **不签到**：积分在桌面端签到/购买，反代与 credits 插件都只读。
- **端口与 key 都会变**：两者都只在启动时写日志，所以日志查找必须覆盖整份文件（见上）。