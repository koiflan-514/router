# lingxi2api — WPS 灵犀的智点积分反代（只读）

把 WPS 灵犀桌面端的「智点」余额暴露成本机只读接口，供 opencode / pi 的 credits
插件和任意客户端查询。**目前只接积分，不接对话**——原因见下。

```
opencode / pi 的 credits 插件 / curl
  ↓  GET /v1/quota
lingxi-proxy.js  127.0.0.1:8796
  ↓  Cookie: wps_sid=<从 Electron cookie 库解出>
https://lingxi.wps.cn/api/public/v1/credits/balance
```

## 为什么只有积分，没有对话

灵犀是 **Electron 外壳 + Go app-server** 的 agent 形态（`lingxi.exe`，JSON-RPC over
stdio），不是普通的 HTTP OpenAI 上游。实测：

- `POST /api/public/v1/agent-runtime/chat/completions` 对**任何 body（连空 `{}`）**
  都回同一个 `400 InvalidArgument`，说明卡在 body 校验之前，试过 OpenAI 标准格式、
  `prompt` / `query` / `input`、补 `client_type` + `device_id` + `wps_sid`、stream 开关、
  换模型名等 15 种形状都无效。它挂在 `agent-runtime` 下，那一组其实是工具端点
  （`search/web`、`image/generate`、`asr/transcribe`、`ppt/templates`）。
- **没有模型清单接口**：`/models`、`/agent-runtime/models`、`/chat/models` 全 404。
- 真正的模型调用走 Go 里的 `kllmagent/llm/aigateway`；另一个主机常量
  `aibot-api.wps.cn` 对 `/v1/*`、`/api/v1/*` 都回 `failed to match any routes`，路由前缀未知。

所以本反代**刻意不提供** `/v1/models` 与 `/v1/chat/completions`（返回明确的 501），
router 里也用 `creditsOnly: true` 标记，**不写进 opencode/pi 的模型 provider**，
免得客户端里出现一个选中就报错的假模型。

真要对话，唯一可行但语义不同的路是：自己 spawn `lingxi.exe` app-server，用 SID
鉴权走 JSON-RPC `session.start` / `run.start`，把 agent 的文本事件转成 OpenAI 流。
但它是带工具、沙箱、300 步上限的 agent（lingxiclaw），按 run 计费，延迟与行为都和
普通模型不同——那是另一件事，这里不做。

## 凭据链条

这是这家唯一特殊的地方：SID **不在** `app-server-data/auth.json` 里（那份是
`auth_storage=runtime`，落盘的 `wps_sid.value` 是空串），而在 Electron 的 cookie jar：

```
%APPDATA%/WPS 灵犀/Local State → os_crypt.encrypted_key（DPAPI 保护）
  └─ DPAPI Unprotect（当前用户）→ 32 字节主密钥
       └─ AES-256-GCM 解 Partitions/lingxi-passport-v2-<hash>/Network/Cookies
          里 name=wps_sid 的 encrypted_value（v10 + 12B nonce + 密文 + 16B tag，
          明文前还有 32 字节 SHA256(host) 前缀，要去掉）
            └─ wps_sid（.wps.cn 域，50 字符）
```

`auth-binding-key.v1` 只用于认证快照的 HMAC 绑定，**不是**快照密钥，别拿它去解
`auth-snapshot.json`（那个是另一套 `Gy` 存储格式）。

cookie 库被桌面端持续写入，直接开会撞 `SQLITE_BUSY`；反代先复制到临时目录再只读打开。
`expires_utc` 是 WebKit 微秒时间戳（1601 起算），超出 JS 安全整数，必须 `CAST ... AS TEXT`。

 SID 缓存 2 分钟（DPAPI 要起 PowerShell，太贵）；上游回 401/403 时强制重读再试一次。

## 启动

```bash
node integrations/lingxi2api/lingxi-proxy.js
# 或由 router 托管（推荐）：
node router.mjs up lingxi
node router.mjs logs lingxi 80
```

默认 `127.0.0.1:8796`。端口可用 `LINGXI_PORT` / `PORT` / `--port` 改。

## 登录

灵犀只能在桌面端登录。登录成功后 SID 写进 cookie 库，反代自动读到，无需重启。

```bash
node router.mjs login lingxi      # 确认桌面端已安装并提示如何登录
node router.mjs account lingxi    # 单账号视图
```

## 端点（全部只读，只支持 GET）

| 端点 | 作用 |
|---|---|
| `GET /health` | 进程、凭据来源、账号（不输出 SID 本体，只显示掩码） |
| `GET /v1/quota` | 智点余额 + 分项 + 每个积分包（credits 插件用） |
| `GET /v1/credits` | 同上（别名） |
| `GET /v1/usage` | 智点收支明细（赠送/消费，带任务名与 session_id） |

额度接口：

```bash
curl -s http://127.0.0.1:8796/v1/quota
curl -s 'http://127.0.0.1:8796/v1/usage?limit=10'
```

实测返回（账号 demo）：

```json
{
  "ok": true,
  "user": { "id": "0000000000", "name": "demo", "corpId": "0", "isCorp": false },
  "balance": { "remaining": 1897, "total": 1900, "used": 3, "unit": "credits" },
  "wallet": { "available": 1897, "bonus": 1897, "purchased": 0, "contract": 0, "granted": 1900, "consumed": 3, "enabled": true },
  "buckets": [
    { "label": "赠送智点", "total": 800, "used": 3, "remaining": 797, "expireAt": "2026-12-20T17:31:48+08:00" }
  ],
  "multipliers": {},
  "chatAvailable": false
}
```

`balance.total` 是**真实发放总量**（`bonus_summary.total_value + purchased_summary.total_value`），
不是编出来的 100%，所以客户端能画进度条。`buckets` 按到期时间排序，快过期的排前面。
`multipliers` 是空对象——上游没有公开逐模型倍率，显示端应报「—」而不是猜。

上游端点：

- `GET /api/public/v1/credits/balance` — 余额与分项
- `GET /api/public/v1/credits/transaction_summary` — 收支明细
- `GET /api/public/v1/account/profile` — 账号 id / 昵称 / corp_id

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LINGXI_PORT` / `PORT` | `8796` | 监听端口 |
| `LINGXI_HOST` | `127.0.0.1` | 监听地址 |
| `LINGXI_APP_DATA` | `%APPDATA%\WPS 灵犀` | 桌面端 userData 根 |
| `LINGXI_WPS_SID` | 读 cookie 库 | 固定 SID（调试/无桌面端时用） |
| `LINGXI_UPSTREAM` | `https://lingxi.wps.cn` | 上游域名（cowork.wps.cn 也可） |
| `LINGXI_SID_CACHE_MS` | `120000` | SID 缓存时长 |
| `LINGXI_QUOTA_CACHE_MS` | `30000` | 余额缓存时长 |
| `LINGXI_TIMEOUT_MS` | `15000` | 上游请求超时 |

需要 Node 22.5+（用 `node:sqlite` 读 cookie 库）。

## 已知边界

- **单账号**：登录态只有一份；换号只能在桌面端退出后重新登录。
- **桌面端必须在跑过一次**：至少登录过一次，cookie 库里才有 SID。
- **只读**：不支持任何写操作（签到、消费、改账号）；POST/PUT 一律 405。
- **不签到**：智点在桌面端做任务领取，反代与 credits 插件都只读。
- **没有对话**：`/v1/models` 与 `/v1/chat/completions` 返回 501，且 router 不把它写进
  opencode/pi 模型清单。
- **SID 会轮换**：桌面端重新登录会换 SID；反代缓存 2 分钟，上游 401 时强制重读。
- **其他 Windows 用户**：DPAPI 主密钥绑定当前用户，换用户解不开，需重新登录桌面端。
