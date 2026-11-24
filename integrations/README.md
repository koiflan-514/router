# integrations

router 直接托管的各家反代与桥接源码。来源、版本、许可证见根目录
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。文档总索引见
[docs/README.md](../docs/README.md)。

## 目录与端口

| 目录 | provider id | 端口 | 说明 | 文档 |
|---|---|---|---|---|
| `qodbuddy2pi/` | `qoder-cn` / `qoder` / `workbuddy` / `workbuddy-global` | 8789 / 8790 / 8787 / 8788 | Qoder 代理 + WorkBuddy 运维与 wheel | [README](qodbuddy2pi/README.md) |
| `traework2api/` | `trae-local` | 7863 / 7864 | Trae 反代（tw2api + img-proxy） | [说明](traework2api/说明.md) |
| `codearts2api/` | `codearts` | 10087 | CodeArts Go 网关 | [README](codearts2api/README.md) |
| `zcode-bridge/` | `zcode` | 20131 | ZCode（Z.ai）套餐桥 | [README](zcode-bridge/README.md) |
| `loomy2api/` | `loomy` | 8791 | 讯飞 Loomy 的 OpenAI 兼容反代 | [README](loomy2api/README.md) |
| `raccoon2api/` | `raccoon` | 8793 | 商汤小浣熊的 OpenAI 兼容反代 | [README](raccoon2api/README.md) |
| `qwenwork2api/` | `qwenwork` | 8794 | 千问办公 OpenAI/Anthropic 反代 | [README](qwenwork2api/README.md) |
| `dumate2api/` | `dumate` | 8795 | 百度搭子 OpenAI 兼容反代 | [README](dumate2api/README.md) |
| `lingxi2api/` | `lingxi` | 8796 | WPS 灵犀 app-server 桥 + 智点积分 | [README](lingxi2api/README.md) |
| `lobsterai2api/` | `lobster` | 8797 | 有道龙虾反代 + 积分/签到 | [README](lobsterai2api/README.md) |
| `token-limits2pi/` | —（pi 扩展） | — | pi 上下文 / 输出限额扩展 | [README](token-limits2pi/README.md) |

## 快速开始

所有命令在仓库根目录执行：

```bash
node router.mjs list                 # 看 provider id 与端口
node router.mjs up <id>              # 启动一家
node router.mjs logs <id> 40         # 看日志
node router.mjs login <id>           # 缺凭证时登录
```

router 的默认路径：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `QODBUDDY_REPO` | `integrations/qodbuddy2pi` | qoder-proxy.js、workbuddy2pi、wheel |
| `ROUTER_TRAE_DIR` | `integrations/traework2api` | tw2api、img-proxy、auths、data |
| `ROUTER_CODEARTS_DIR` | `integrations/codearts2api` | codearts2api、状态文件、run.log |
| `ROUTER_LOOMY_DIR` | `integrations/loomy2api` | loomy-proxy.js |
| `ROUTER_RACCOON_DIR` | `integrations/raccoon2api` | raccoon-proxy.js |
| `ROUTER_QWENWORK_DIR` | `integrations/qwenwork2api` | qwenwork-proxy.js |
| `ROUTER_DUMATE_DIR` | `integrations/dumate2api` | dumate-proxy.js |
| `ROUTER_LINGXI_DIR` | `integrations/lingxi2api` | lingxi-proxy.js（对话 + 积分） |
| `ROUTER_LOBSTER_DIR` | `integrations/lobsterai2api` | lobster-proxy.js（对话 + 积分/签到） |

本地文件缺失时，router 会回退到旧位置（`E:\qodbuddy2pi`、
`E:\trae-free-credits\1-traework2api`、`~/codearts2api`），所以迁移期间仍可运行。

## 本地补丁

- `qodbuddy2pi/assets/workbuddy2pi`：`VENDOR_DIR` 支持
  `WORKBUDDY2API_VENDOR` 环境变量，让 router 的浏览器登录直接使用仓库内 wheel，
  不依赖 `~/.workbuddy2api/vendor` 里的旧副本。
- `qodbuddy2pi/assets/quota.js`：新增 `loomyCredits()` 与 `raccoonCredits()`，从
  `loomy2api` / `raccoon2api` 的 `/v1/quota` 读积分与模型倍率，供
  `qoder2pi credits json`（router TUI 额度页）使用。

## 为什么二进制不提交

- `tw2api.exe` 的上游没有开源许可证，不能再分发。
- `codearts2api.exe` 是可复现的 Go 构建产物，按惯例不入库；源码已完整保留。
- WorkBuddy 的 wheel 是 MIT 依赖，已包含在 `qodbuddy2pi/assets/vendor/`。

## 本地运行

```bash
cd <repo>
node router.mjs up
node router.mjs list
```

运行时的 PID 在 `<repo>\.run\processes.json`（已忽略）。

---

← 返回 [文档索引](../docs/README.md) ｜ [根 README](../README.md)
