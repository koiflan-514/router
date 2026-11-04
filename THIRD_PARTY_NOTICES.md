# 第三方代码说明

本仓库的 `integrations/` 下放了三套反代实现的源码快照。它们各自保留原许可证，
router 只负责启动、停止和写 opencode provider，不改变它们的协议行为。

| 目录 | 上游 | 快照 commit | 许可证 |
|---|---|---|---|
| `integrations/qodbuddy2pi` | https://github.com/CraigKettleman/qodbuddy2pi | `33fcb412013d923d2f27ccbd085b4f4d5763c3e7` + 本地工作树改动 | MIT |
| `integrations/traework2api` | https://github.com/wanghui040127-ui/trae-free-credits（`1-traework2api/`） | `e736e6a61444fbc37dc1b7ae35fd6a1438a0e3fa` + 本地脚本 | MIT |
| `integrations/codearts2api` | https://github.com/2951461586/CodeArts2API | `c11aa7bba77d148ed04dec2c6a67b74cb8732293` | Apache-2.0 |

## 二进制

- `integrations/traework2api/tw2api.exe`
  - 来自上游 [Sliverkiss/traework2api](https://github.com/Sliverkiss/traework2api)。
  - 上游未附开源许可证，**不随本仓库分发**，已在 `.gitignore` 中忽略。
  - 本机已有的二进制可以继续使用；换机器时请自行从上游构建或获取。
- `integrations/codearts2api/codearts2api.exe`
  - 由 `integrations/codearts2api` 的 Go 源码构建，构建产物已在 `.gitignore` 中忽略。
  - 重新构建：`cd integrations/codearts2api && go build -o codearts2api.exe .`
- `integrations/qodbuddy2pi/assets/vendor/workbuddy2api-2.0.7-py3-none-any.whl`
  - MIT © 2026 Mayer，作为 qodbuddy2pi 的 vendored 依赖保留。

## 凭证与运行时数据

以下内容只在本机存在，已被 `.gitignore` 忽略，不会提交：

- `integrations/traework2api/.env.local`
- `integrations/traework2api/auths/`
- `integrations/traework2api/data/`
- `integrations/codearts2api/codearts2api-data.json`
- 各目录的 `*.log` / `*.jsonl`

Qoder 的 `~/.pi/agent/auth.json`、WorkBuddy 的 `~/.codebuddy-session*.json`
仍在用户主目录，不进入本仓库。
