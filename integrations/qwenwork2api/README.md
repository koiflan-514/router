# qwenwork2api — 千问办公（QwenWork CN）的 OpenAI / Anthropic 兼容反代

本仓库自写，零依赖（只用 `node:` 内建模块），单文件 `qwenwork-proxy.js`，默认监听 `127.0.0.1:8794`。

## 这家特殊在哪

千问办公桌面端是 Electron 应用，**不把 token 明文落盘**：

| 文件 | 内容 | 能不能读 |
|---|---|---|
| `%APPDATA%/QwenWorkCN/auth.dat` / `auth-v2.dat` | 宿主登录态（JWT） | ✗ 加密绑定本机身份，**刻意不解** |
| `%APPDATA%/QwenWorkCN/Local State` | `os_crypt.encrypted_key` | ✓ DPAPI 保护，同一用户可解 |
| `~/.qwenworkcn/engine-maas-key.dat` | MaaS 推理 key | ✓ Chromium OSCrypt(`v10`)，密钥来自上一行 |
| `~/.qwenworkcn/.status.json` | 昵称 / 套餐 / 登录状态 | ✓ 明文 |

解密链条是标准的 Chromium OSCrypt：

```
Local State: os_crypt.encrypted_key (base64, "DPAPI" 前缀 + DPAPI blob)
   └─ DPAPI Unprotect (CurrentUser) → 32 字节主密钥
        └─ AES-256-GCM 解 engine-maas-key.dat（"v10" + 12B nonce + 密文 + 16B tag）
             └─ {"credentials":{"<sessionId>":{"accessKey":"sk-mm-v1.…","expiresAtMs":…,"baseUrl":"https://api9.qwenwork.cn/v1"}}}
```

**这是「同一用户的本地文件」，不是伪造设备身份**：桌面端自己也是这么读的，代理只是共用同一份凭据。

## 凭据续期

桌面端签的 key 只有 **2 小时**。反代用官方通道自己续：

```
POST {baseUrl}/access-tokens/exchange   {"ttl_ms": 7200000}
→ {"access_token": "sk-mm-v1.…", "expires_at": 1794819682377}
```

启动时跑一次，之后每 10 分钟检查，剩余不足 30 分钟就再换一把。所以**桌面端关掉后代理仍能跑**
（只要 exchange 线路可用）；桌面端重新登录换了 key 时，磁盘上的 `expiresAtMs` 更新，
反代会自动采纳更新的一条。

**过期就没救了**：exchange 需要一把有效 key，过期的 key 换不了新 key。所以代理要长期在线；
如果停着超过 2 小时导致 key 过期，只能重启千问办公桌面端（实测重启就会重新签发），
或在对话框里随便发一句。不用重启反代——它下一次请求会重读 `engine-maas-key.dat`。

## 端点

| 本机 | 上游 | 说明 |
|---|---|---|
| `GET /health` | — | 凭据来源、到期时间、模型目录来源、限流状态（不输出 key） |
| `GET /v1/models` | — | 13 个模式（读桌面端日志里的 `chat-modes-v2` 目录） |
| `GET /v1/quota` | — | 逐模式 `price_factor` + 限时折扣；**余额拿不到**（见下） |
| `POST /v1/chat/completions` | `…/v1/chat/completions` | OpenAI 方言，原样透传 |
| `POST /v1/messages` | `…/v1/messages` | Anthropic 方言，原样透传（上游原生支持） |

其余 `/v1/*` 去掉前缀后透传。

## 为什么额度拿不到

桌面端的余额在 `gateway.qwenwork.cn/api/v1/adapter/user/wallets`，但它要**宿主 JWT**
（不是 MaaS key），而宿主 JWT 在 `auth-v2.dat` 里、加密绑定本机身份。

反代**不去解它**——那是登录态本体，解出来的收益（一个数字）远小于风险。所以：

- `/v1/quota` 的 `balance` 是 `null`，`quotaNote` 说明原因
- 倍率是完整可用的（来自模型目录的 `price_factor` + 限时折扣）

插件侧因此显示「无余额信息」，但倍率照常：

```
QwenWork  无余额信息
          账号：1 个
          套餐 个人基础版
          千问办公的额度接口要宿主登录 JWT（auth-v2.dat，加密绑定本机），反代不解密它
          倍率：13 个模型有上游倍率
```

## 模型目录从哪来

`chat-modes-v2/*.lkg` 是**加密的**（`UU1D…` base64 密文），读不出明文。但桌面端每次拉目录
都会把整个 `responseBody` 打进 `logs/<日期>/main.log`，那份是明文。所以：

1. 先从最近的 `main.log` 里取**最后一条**完整 catalog（括号配平解析，不怕行尾噪声）
2. 再试 `.lkg`（万一日后变明文）
3. 都不行用内置 13 行兜底表

`/health` 的 `catalog.source` 会写明当前用的是哪一种，避免「看起来有模型但不知道新不新」。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `QWENWORK_PORT` / `--port` | `8794` | 监听端口 |
| `QWENWORK_HOST` | `127.0.0.1` | 监听地址 |
| `QWENWORK_DATA_DIR` | `%APPDATA%/QwenWorkCN` | 桌面端 userData（`Local State` 在这） |
| `QWENWORK_HOME` | `~/.qwenworkcn` | CLI 家目录（`engine-maas-key.dat` 在这） |
| `QWENWORK_EXCHANGE_TTL_MS` | `7200000` | exchange 申请的 TTL |
| `QWENWORK_REFRESH_AHEAD_MS` | `1800000` | 剩余不足这么多就续期 |
| `QWENWORK_CHAT_TIMEOUT_MS` | `1200000` | 对话超时 |
| `QWENWORK_LIMITS` | — | 设 `off` 临时关掉本地限流（别长期关） |

## 运行

```bash
node integrations/qwenwork2api/qwenwork-proxy.js          # 127.0.0.1:8794
node integrations/qwenwork2api/qwenwork-proxy.js --port 8794
```

router 里：

```bash
node router.mjs up qwenwork
node router.mjs login qwenwork     # 拉起桌面端，登录后**发一句话**才会签发 key
node router.mjs account qwenwork
node router.mjs logs qwenwork 80
```

## 已知行为

- **只登录不对话时没有 key**：桌面端在首次推理请求时才签发 `engine-maas-key.dat`。
  `router account` 会显示「尚未签发推理凭据」，此时去桌面端随便发一句即可。
- **换机器/换用户解不开**：OSCrypt 主密钥由当前用户的 DPAPI 保护。换用户后需要重新登录桌面端。
- **上游 401 会自动重读凭据并重试一次**：桌面端可能刚轮换过 key，重读磁盘通常就恢复了。
- **两种方言都是原生的**：上游 `/v1/messages` 真支持 Anthropic 协议（含 `thinking` 块），
  网关会优先走原生，不额外转换。
