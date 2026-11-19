# 第三方代码说明

本仓库的 `integrations/` 下放了几套反代实现的源码快照。它们各自保留原许可证，
router 只负责启动、停止和写 opencode provider，不改变它们的协议行为。
`integrations/loomy2api`、`integrations/raccoon2api` 与 `integrations/qwenwork2api` 是本
仓库自写的零依赖 Node 代理（未复制第三方代码），仅对接讯飞 Loomy / 商汤小浣熊 / 千问办公
各自公开的 OpenAI（或 Anthropic）兼容端点，故不在此表列出。

| 目录 | 上游 | 快照 commit | 许可证 |
|---|---|---|---|
| `integrations/qodbuddy2pi` | https://github.com/CraigKettleman/qodbuddy2pi | `33fcb412013d923d2f27ccbd085b4f4d5763c3e7` + 本地工作树改动 | MIT |
| `integrations/traework2api` | https://github.com/wanghui040127-ui/trae-free-credits（`1-traework2api/`） | `e736e6a61444fbc37dc1b7ae35fd6a1438a0e3fa` + 本地脚本 | MIT |
| `integrations/codearts2api` | https://github.com/2951461586/CodeArts2API | `c11aa7bba77d148ed04dec2c6a67b74cb8732293` | Apache-2.0 |
| `integrations/zcode-bridge` | https://github.com/azrinaldi/zcode-bridge | `main` 分支快照（v0.1.0，2026-11-03） | MIT |

`integrations/zcode-bridge` 有本地修改（两处，均已在该目录源码中注明）：

1. `internal/server/server.go`：新增 `relayIfGatewayError()`，把「HTTP 200 + `{code,msg}`」
   的网关错误还原成 429/402/400，而不是翻译成空回复。
2. `internal/auth/http.go` + `auth.go`：桌面凭据 KDF 的 platform 用 `win32`
   （Electron 的 `process.platform`）而不是 Go 的 `windows`，并剥掉用户名的域名前缀，
   否则 Windows 上永远解不开 `~/.zcode/v2/credentials.json`。

限时套餐领取（`router claim zcode`）的协议细节参考了 MIT 项目
[L0NE-6/ZCode-Daily](https://github.com/L0NE-6/ZCode-Daily)，未直接复制其代码。

## 二进制

- `integrations/traework2api/tw2api.exe`
  - 来自上游 [Sliverkiss/traework2api](https://github.com/Sliverkiss/traework2api)。
  - 上游未附开源许可证，**不随本仓库分发**，已在 `.gitignore` 中忽略。
  - 本机已有的二进制可以继续使用；换机器时请自行从上游构建或获取。
- `integrations/codearts2api/codearts2api.exe`
  - 由 `integrations/codearts2api` 的 Go 源码构建，构建产物已在 `.gitignore` 中忽略。
  - 重新构建：`cd integrations/codearts2api && go build -o codearts2api.exe .`
- `integrations/zcode-bridge/zcode-bridge.exe`
  - 由 `integrations/zcode-bridge` 的 Go 源码构建（纯标准库，Go 1.27+），产物已在 `.gitignore` 中忽略。
  - 重新构建：`cd integrations/zcode-bridge && go build -trimpath -o zcode-bridge.exe ./cmd/zcode-bridge`
- `integrations/qodbuddy2pi/assets/vendor/workbuddy2api-2.0.7-py3-none-any.whl`
  - MIT © 2026 Mayer，作为 qodbuddy2pi 的 vendored 依赖保留。

## 凭证与运行时数据

以下内容只在本机存在，已被 `.gitignore` 忽略，不会提交：

- `integrations/traework2api/.env.local`
- `integrations/traework2api/auths/`
- `integrations/traework2api/data/`
- `integrations/codearts2api/codearts2api-data.json`
- `integrations/zcode-bridge/data/`（`accounts.json` 里是套餐 JWT）
- `integrations/zcode-bridge/plan-jwt.json`
- 各目录的 `*.log` / `*.jsonl`

Qoder 的 `~/.pi/agent/auth.json`、WorkBuddy 的 `~/.codebuddy-session*.json`
仍在用户主目录，不进入本仓库。

## gateway/ 里的移植代码

`gateway/` 是统一网关，其中六个模块移植自 MIT 项目
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
（`src/route/classify.js`、`src/messages.js`、`src/http.js`、`src/local-optimize.js`、
`src/combos.js`、`src/providers/registry.json`）。各文件头部的注释保留了原始出处与
移植时的取舍说明。

`gateway/free-providers.mjs` 的注册表**只保留了原 76 家里有免费额度的 18 家**
（3 家本机免账号 + 15 家有免费额度），其余 61 家是纯付费直连，与本项目定位不符。
原注册表的字段结构被保留，但 `notes` 没有照抄——那是 dsh 自己的实现细节。
