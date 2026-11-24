# 文档索引

本目录是 router 的**经验手册**：不只列命令，还记录每个判断的依据、踩过的坑和边界。
根目录 [README](../README.md) 负责快速开始与速查；本页负责回答「遇到什么问题该读哪一篇」。

## 阅读路径

| 你的目标 | 建议顺序 |
|---|---|
| 第一次跑起来 | [根 README 快速开始](../README.md#快速开始) → [全链路拓扑](01-topology.md) → [日常运维](05-operations.md) |
| 日常启停 / 切号 / 看日志 | [日常运维](05-operations.md) → [选择性启停](07-selective.md) → [进程生命周期](09-lifecycle.md) |
| 接入新供应商 | [排查清单](04-checklist.md) → [复用经验](06-reuse.md) → [踩坑记录](02-pitfalls.md) |
| 出故障先定位 | [踩坑记录](02-pitfalls.md) → [进程生命周期](09-lifecycle.md) → [本机限流](13-limits.md) |
| 看懂协议细节 | [Qoder 协议](03-qoder-protocol.md) → [CodeArts](08-codearts.md) → [不装 Agent 的 CodeArts](10-codearts-no-agent.md) |
| 用统一网关 | [网关运维](11-gateway.md) → [网关调优](12-gateway-tuning.md) |
| 用 TUI / 网页面板 | [TUI](../tui/README.md) → [TUI 文档](../tui/docs/README.md)；[网页面板](../frontend/README.md) → [前端文档](../frontend/docs/README.md) |

## 全部文档

| # | 文档 | 内容 |
|---|---|---|
| 01 | [全链路拓扑](01-topology.md) | 一张图看清客户端、反代、上游与端口；凭证落在哪；opencode 配置与模型清单来源。 |
| 02 | [踩坑记录](02-pitfalls.md) | P1–P33 实测坑：症状 → 真因 → 判断依据 → 修法，附错误码速查。 |
| 03 | [Qoder 网关协议要点](03-qoder-protocol.md) | COSY 签名、body 三段轮转编码、SSE 双层信封、tool_calls、模型目录、凭证与设备授权。 |
| 04 | [新供应商接入排查清单](04-checklist.md) | 从「要不要写代理」到「跑的是新代码」的 8 个阶段，附反检查清单。 |
| 05 | [日常运维](05-operations.md) | 启停、账号池、浏览器登录、模型刷新、各家供应商差异、Linux/Wine、升级与日志。 |
| 06 | [怎么把这套经验套到新供应商](06-reuse.md) | 8 步法：定性、找凭证、打穿最小请求、分层错误、写适配器、双端接入。 |
| 07 | [选择性启停（router）](07-selective.md) | on/off/all/none 为什么必须同时改三处，以及三个「关了但没关掉」的坑。 |
| 08 | [CodeArts Agent（华为云码道）](08-codearts.md) | 部署、pi/opencode 接入、可用模型、上游限制与对比。 |
| 09 | [反代进程生命周期（router 直管）](09-lifecycle.md) | PID、日志、端口清理、停止算法、登录自启与故障排查。 |
| 10 | [不装 Agent 的 CodeArts 实现说明](10-codearts-no-agent.md) | OAuth+PKCE+DPoP、STS 凭据、SDK-HMAC 签名、最小网关与验收清单。 |
| 11 | [统一网关运维](11-gateway.md) | 启停、客户端接入、开关语义、端口交叉校验、额度快照与排查顺序。 |
| 12 | [网关调优](12-gateway-tuning.md) | 降级链、权重、本地应答、失败分类与免费供应商排查。 |
| 13 | [本机限流](13-limits.md) | 并发/RPM/间隔/日上限四个维度、四档预设、硬约束与三层生效范围。 |

## 文档约定

- **命令位置**：所有 `node router.mjs ...` 命令默认在仓库根目录执行；`<repo>` / `$REPO` 都指仓库根目录。
- **占位符**：`<id>` 是 provider id（`node router.mjs list` 可查），`<key>` 是账号 slot，`<模型>` 是上游模型名。
- **平台**：示例里的 `C:\...` / `E:\...` 是 Windows 路径；Linux/macOS 换成 `/...`。涉及桌面端凭据的路径按实际系统写。
- **凭证**：只写路径与结构，不写真实值；示例账号、UID、AccessKey 前缀统一脱敏为 `demo`。
- **结构**：优先按「症状 → 真因 → 判断依据 → 修法」写；新增文档请沿用两位数编号，并同时更新本索引与上下篇导航。
- **第三方文档**：`integrations/codearts2api/`、`qodbuddy2pi/`、`traework2api/`、`zcode-bridge/` 下的文档是上游快照，保留原结构与许可证，不在本索引维护。

## 术语

| 术语 | 含义 |
|---|---|
| 反代 / provider | 本机监听一个端口、把 OpenAI/Anthropic 请求翻译成上游私有协议的小进程。 |
| provider id | `router.mjs` 使用的短名，如 `qoder-cn`、`trae-local`、`lingxi`。 |
| 消费端 | pi、opencode、Claude Code 等真正发起对话的客户端。 |
| 统一网关 | `:8785` 的叠加层，把多家反代合成一个 baseURL，模型名带 `<供应商>/<模型>` 前缀。 |
| 本机限流 | 在请求发出前限制并发 / RPM / 间隔 / 日上限，避免被上游判定为套流。 |

## 维护

- 新增或改名文档时，同步更新本页索引、上下篇导航和根 README 的文件地图。
- 示例统一脱敏；不要写入真实 token、cookie、UID、AccessKey、邮箱或本机用户名。
- 第三方快照目录的文档保持上游原样，不在这里维护。

---

← 返回 [根 README](../README.md) ｜ 下一步：[全链路拓扑](01-topology.md)