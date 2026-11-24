# lingxi2api — WPS 灵犀 → OpenAI 兼容反代（对话 + 智点积分）

把 WPS 灵犀桌面端的订阅额度转成本机 OpenAI 兼容端点：opencode / pi 通过
`/v1/models` 与 `/v1/chat/completions` 真正调用灵犀的模型对话，credits 插件通过
`/v1/quota` 查智点余额。零依赖，只用 `node:` 内建模块。

```
opencode / pi / curl
  ↓  POST /v1/chat/completions（OpenAI 格式，流式/非流式）
lingxi-proxy.js  127.0.0.1:8796
  ↓  spawn + JSON-RPC over stdio（LINGXI_WPS_SID 鉴权）
lingxi.exe --stdin（官方 app-server，随桌面端安装）
  ↓  私有协议 → 云端 aigateway
pro / max / deepseek-v4.1-flash / qwen3.8_max / GLM-5.3-Flash …（13 个）

积分另走只读 HTTP：
  GET /v1/quota → Cookie: wps_sid → https://lingxi.wps.cn/api/public/v1/credits/balance
```

## 为什么走 app-server，而不是云端 HTTP

灵犀是 **Electron 外壳 + Go app-server** 的 agent 形态，云端没有可直达的 OpenAI
兼容面。实测（2026-11）：

- `POST /api/public/v1/agent-runtime/chat/completions` 对任何 body 都回同一个
  `400 InvalidArgument`——那一组其实是工具端点（search/web、image/generate 等），
  不是对话入口。
- 没有公开的模型清单接口（`/models`、`/chat/models` 全 404）。
- 桌面端的 19836 端口是 remoteBridge WebSocket（连远端 WPS 云），61719 是应用内
  浏览器调试桥，都不是本地模型接口。
- 真正的模型调用在 Go app-server 内部完成。它官方支持 `-stdin`（JSON-RPC over
  stdio）+ `-auth-storage runtime` + `LINGXI_WPS_SID` 环境变量鉴权——这是 CLI
  帮助里明写的方式，比逆向云端 aigateway 可靠得多。

所以反代自己 spawn 一个常驻 app-server 子进程，把 OpenAI 请求翻译成它的原生
JSON-RPC。**协议全部逆向实测打通**，要点见下。

## app-server 协议（逆向所得，实测验证）

启动：

```
lingxi.exe --stdin --auth-storage=runtime
  --config <APP_DATA>\app-server-data\config.json
  --data-dir <APP_DATA>\app-server-data\state
env: LINGXI_WPS_SID=<sid>
```

EXE 在 `%APPDATA%\WPS 灵犀\app_server_link\service\lingxi.exe`。

握手与方法：

1. `initialize`，params 用 **snake_case**：
   `{protocol_version:'2026-08-13', device_id:<64位hex>, client_type:'lingxi_claw'}`。
   标准 ACP/LSP/MCP 的 params 形状都不对（回 -32602）。
2. 成功后**必须发 `initialized` 通知**，否则后续所有方法回 -32600（未就绪）。
3. 方法名用**斜杠**：`session/start`、`run/start`、`model/list`、`account/status`、
   `session/list`。二进制里那些点号名（`session.start` 等）是内部 telemetry 名，
   不是 RPC 方法名。
4. `session/start` params：`{session_type:'cowork_client', agent:'lingxiclaw',
   client_type:'lingxi_claw'}` → 返回 `session_id`。
5. `run/start` params：`{session_id, model:{provider:'lingxi', model_name:'pro'},
   agent_input:{text:'…', files:[]}}`。**model 必须是对象**（字符串回 -32602），
   `agent_input.text` 必须是字符串。

错误码语义（这家自己的一套，别按 JSON-RPC 标准猜）：

| code | 含义 |
|---|---|
| -32600 | 未就绪（没发 `initialized`）或业务冲突（data.result 如 SessionNotExisted） |
| -32601 | NoImpl，方法不存在 |
| -32602 | InvalidArgument，方法对但参数错 |

回复事件流（`run/start` 的 RPC 响应返回后事件还在继续）：

- `component.content`（`type:'c_text'`）的 `delta` —— 流式正文；
- `component.end`（`c_text`）的 `full_content` —— 该段完整文本（兜底）；
- `c_recommend` 是推荐问题，**要过滤**；
- `token_usage.updated` 的 `usage` —— input/output/total tokens；
- `stream.end` / `run.end` —— 结束；`error` 事件带 `details.hint`。

## 能力边界：是 agent，不是裸模型

灵犀的 lingxiclaw 是**完整 agent**：自己联网搜索、跑工具循环、按 run 计费。
实测传 OpenAI `tools` 它**不吐 `tool_calls`**——它自己查完（比如联网搜天气）
直接返回最终文本。因此：

- 模型清单里标 `capabilities.tool_call:false`，opencode 侧如实写 `tool_call:false`；
- **适合对话**（多轮、system、流式都正常），**不适合当 opencode/pi 的编码 agent
  驱动**，也别排进网关的编码降级链；
- 每次 chat 请求新建 session（干净上下文），OpenAI messages 压成一段带角色标记的
  文本交给 agent；
- 所有 RPC 串行（mutex 队列），与桌面端单窗口语义一致；并发请求排队执行。

模型清单来自 `model/list`（13 个）：pro、max、deepseek-v4.1-flash、
deepseek-v4-pro-0813、qwen3.8_flash、qwen3.8_max、mimo-v2.6-pro、GLM-5.3-Flash 等，
带 context window / max_new_tokens / 多模态 / reasoning_efforts。
**pro 模式部分账号不可用**（实测报 Unavailable）；`deepseek-v4.1-flash` 最稳，
体检试打用它。

## 凭据链条

SID **不在** `app-server-data/auth.json` 里（那份是 `auth_storage=runtime`，落盘的
`wps_sid.value` 是空串），而在 Electron 的 cookie jar：

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
SID 缓存 2 分钟（DPAPI 要起 PowerShell，太贵）；积分上游回 401/403 时强制重读再试一次。
app-server 子进程用启动时的 SID；SID 轮换后重建子进程。

## 启动

```bash
node integrations/lingxi2api/lingxi-proxy.js
# 或由 router 托管（推荐）：
node router.mjs up lingxi
node router.mjs logs lingxi 80
```

默认 `127.0.0.1:8796`。端口可用 `LINGXI_PORT` / `PORT` / `--port` 改。
启动时预热 app-server 并拉一次模型清单。

## 登录

灵犀只能在桌面端登录。登录成功后 SID 写进 cookie 库，反代自动读到，无需重启。

```bash
node router.mjs login lingxi      # 确认桌面端已安装并提示如何登录
node router.mjs account lingxi    # 单账号视图
```

## 端点

| 端点 | 作用 |
|---|---|
| `GET /health` | 进程、app-server 就绪态、模型数、凭据来源（SID 只显示掩码） |
| `GET /v1/models` | OpenAI 模型清单（来自 app-server `model/list`，缓存 5 分钟，`?refresh=1` 强刷） |
| `POST /v1/chat/completions` | 对话；流式（SSE）与非流式、多轮 messages、system、reasoning_effort |
| `GET /v1/quota` | 智点余额 + 分项 + 每个积分包（credits 插件用，只读） |
| `GET /v1/credits` | 同上（别名） |
| `GET /v1/usage` | 智点收支明细（赠送/消费，带任务名与 session_id，只读） |

对话示例：

```bash
curl -s http://127.0.0.1:8796/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
# 流式加 "stream":true；实测非流式 ~3s，delta → finish stop + usage → [DONE]
```

积分实测返回（账号 demo）：

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
  "chatAvailable": true
}
```

`balance.total` 是**真实发放总量**（`bonus_summary.total_value + purchased_summary.total_value`），
不是编出来的 100%，所以客户端能画进度条。`buckets` 按到期时间排序，快过期的排前面。
`multipliers` 是空对象——上游没有公开逐模型倍率，显示端应报「—」而不是猜。

积分上游端点：

- `GET /api/public/v1/credits/balance` — 余额与分项
- `GET /api/public/v1/credits/transaction_summary` — 收支明细
- `GET /api/public/v1/account/profile` — 账号 id / 昵称 / corp_id

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LINGXI_PORT` / `PORT` | `8796` | 监听端口 |
| `LINGXI_HOST` | `127.0.0.1` | 监听地址 |
| `LINGXI_APP_DATA` | `%APPDATA%\WPS 灵犀` | 桌面端 userData 根 |
| `LINGXI_APP_SERVER` | `<APP_DATA>\app_server_link\service\lingxi.exe` | app-server 可执行文件 |
| `LINGXI_WPS_SID` | 读 cookie 库 | 固定 SID（调试/无桌面端时用） |
| `LINGXI_DEVICE_ID` | 桌面端的 device_id | initialize 用的 64 位 hex |
| `LINGXI_UPSTREAM` | `https://lingxi.wps.cn` | 积分上游域名（cowork.wps.cn 也可） |
| `LINGXI_SID_CACHE_MS` | `120000` | SID 缓存时长 |
| `LINGXI_QUOTA_CACHE_MS` | `30000` | 余额缓存时长 |
| `LINGXI_TIMEOUT_MS` | `15000` | 积分上游请求超时 |
| `LINGXI_CHAT_TIMEOUT_MS` | `180000` | 单次对话（run）超时 |

需要 Node 22.5+（用 `node:sqlite` 读 cookie 库）。

## 已知边界

- **单账号**：登录态只有一份；换号只能在桌面端退出后重新登录。
- **桌面端必须登录过一次**：cookie 库里才有 SID；app-server 随桌面端安装。
- **不吐 tool_calls**：见上文能力边界；编码 agent 驱动请选别家。
- **RPC 串行**：并发 chat 请求在反代内排队，延迟叠加；限额档 balanced（并发 2）。
- **对话真实消耗智点**：按 run 计费，agent 可能自己联网搜索（多花一点）。
  积分端点只读，不签到、不改账号；智点在桌面端做任务领取。
- **SID 会轮换**：桌面端重新登录会换 SID；反代缓存 2 分钟，上游 401 时强制重读。
- **其他 Windows 用户**：DPAPI 主密钥绑定当前用户，换用户解不开，需重新登录桌面端。
- **协议是逆向的**：app-server 升级可能改 params/事件形状；`/health` 的
  `appServerReady` 与 `modelError` 是第一排查点。

---

← 返回 [integrations 索引](../README.md) ｜ [文档索引](../../docs/README.md)
