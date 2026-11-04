# 全链路拓扑

## 一张图

```
┌─────────────────────────────────────────────────────────────────────┐
│ 消费端                                                               │
│   pi            —— 原生协议（扩展直接注册 provider）                   │
│   opencode      —— 只会说 OpenAI /v1/chat/completions                │
└───────────┬─────────────────────────────────┬───────────────────────┘
            │                                 │
┌───────────▼─────────────┐   ┌───────────────▼───────────────────────┐
│ Qoder 私有协议           │   │ OpenAI 兼容                           │
│ qoder-proxy.js           │   │ WorkBuddy 反代 (codebuddy_proxy)       │
│   :8789 (cn)             │   │   :8787 (国内)  :8788 (国际)           │
│   :8790 (global)         │   │ Trae: tw2api :7864 → img-proxy :7863  │
│                           │   │ CodeArts2API :10087                   │
└───────────┬─────────────┘   └───────────────┬───────────────────────┘
            │                                 │
┌───────────▼─────────────┐   ┌───────────────▼───────────────────────┐
│ gateway.qoder.com.cn    │   │ copilot.tencent.com   (国内)           │
│ api3.qoder.sh           │   │ www.codebuddy.ai      (国际)           │
│ + openapi.* (只读接口)   │   │ snap-access.cn-north-4.myhuaweicloud  │
└─────────────────────────┘   └───────────────────────────────────────┘
```

## 为什么 Qoder 需要自己写代理

pi 能直连 Qoder，是因为扩展 `pi-provider-qoder` 实现了它的私有协议：

- **COSY 签名**：RSA 加密 AES key + MD5 串，body 与 path 都参与签名
- **自定义 body 编码**：base64 后做「三段轮转」，再换一套字母表
- **SSE 信封**：`data:{"headers":…,"body":"<内层 JSON 字符串>"}` 双层嵌套

opencode 不会这些。WorkBuddy/Trae 不需要代理，因为它们（的第三方反代）本来就吐
OpenAI 格式。**判断新供应商要不要写代理：看它是否说 OpenAI。说不说的都是协议问题，
不是账号问题。**

## 端口与进程

| 端口 | 进程 | 谁管 | 端点 |
|---|---|---|---|
| 7863 | img-proxy.js | `router.mjs up trae-local` | `/v1/*` |
| 7864 | tw2api | 同上（Trae 内段） | `/v1/models`, `/healthz` |
| 8787 | codebuddy_proxy | `router.mjs up workbuddy` | `/v1/*` |
| 8788 | codebuddy_proxy --global | `router.mjs up workbuddy-global` | `/v1/*` |
| 8789 | qoder-proxy.js --region cn | `router.mjs up qoder-cn` | `/health`, `/v1/*` |
| 8790 | qoder-proxy.js --region global | `router.mjs up qoder` | 同上 |
| 10087 | codearts2api | `router.mjs up codearts` | `/v1/*`, `/admin` |

六个反代的进程都由 `router.mjs` 直接 spawn，PID 记录在
`E:\router\.run\processes.json`。Windows 登录自启用
`node router.mjs service install [id...]` 生成 `router-<id>` 计划任务；旧的
`qoder2pi-proxy` / `workbuddy2pi` 任务可以保留，router 启动前会先把它们 `/End`。

## 凭证在哪

| 供应商 | 文件 | 结构要点 |
|---|---|---|
| Qoder | `~/.pi/agent/auth.json` 的 `qoder-cn` / `qoder` | `access`(job/device token) + `refresh` + `machineID` |
| WorkBuddy | `~/.codebuddy-session.json`、`~/.codebuddy-global-session.json` | `auth.accessToken`、`auth.expiresAt`、`account.nickname` |
| WorkBuddy 多账号 | `~/.workbuddy2api/sessions/*.json`、`sessions-global/` | 每个 slot 一份；生效文件是上面那两个 |
| Trae | `E:\router\integrations\traework2api\auths\trae-*.json` | 反代自己维护，`router login trae-local` 写入 |
| CodeArts | `%APPDATA%\codearts-agent\User\globalStorage\state.vscdb` | AK/SK/STS + refresh_token，DPAPI + AES-GCM；由 CodeArts2API 解密并续期 |

**关键点：Qoder 的 auth.json 是 pi 与 opencode 共用的。** 代理读同一份文件，所以
在 pi 里登录一次，两边都能用；代理刷新后会写回，pi 也跟着受益。

## opencode 的配置怎么组织

有两份配置会被合并：

- `~/.config/opencode/opencode.jsonc` —— Trae 的 `trae-local` 在这里（历史原因）
- `~/.config/opencode/opencode.json` —— 本项目写的 provider（`qoder-cn`/`qoder`/
  `workbuddy`/`workbuddy-global`/`codearts`）

合并逻辑收在 `assets/opencode-config.js` 一处：只改 `provider` 里自己那个键，别的
provider 与顶层设置原样保留，改写前备份。

> ⚠️ 教训：测试时把 `opencode.jsonc` 挪走过一次，Trae 就从 opencode 里消失了。
> **动配置文件前先想清楚「谁依赖它」，测完立刻挪回。**

## 模型清单取哪个来源

| 供应商 | 权威来源 | 为什么 |
|---|---|---|
| Qoder | 网关 `model/list`（代理实时拉） | 唯一真相 |
| WorkBuddy | **pi 里该 provider 可见的模型** | 反代自带的静态表与服务端真实可用集对不上 |
| Trae | 反代 `/v1/models` | 该反代自己维护，够准 |
| CodeArts | 反代 `/v1/models` | CodeArts2API 同步上游模型清单 |

WorkBuddy 的反代静态表里列着服务端根本不认的 `claude-4.0`/`gpt-5`，却漏了真正能用的
`deepseek-v4.1-flash`。pi 扩展读的是桌面端落盘的产品配置（`~/.workbuddy/cache/
acc-product-config-v*.json`），那份才对。所以 `opencode install` 优先采用 pi 的清单。
