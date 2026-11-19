# integrations

这些是 router 直接托管的第三方反代源码。来源、版本、许可证见根目录
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

```
integrations/
  qodbuddy2pi/     Qoder 代理 + WorkBuddy 运维命令 + WorkBuddy wheel
  traework2api/    Trae tw2api 源码 + img-proxy.js（tw2api.exe 本地忽略）
  codearts2api/    CodeArts2API Go 源码 + 本机二进制/状态（二进制与状态忽略）
  zcode-bridge/    ZCode（Z.ai）套餐额度桥（Go 标准库单二进制）
  loomy2api/       讯飞 Loomy 的 OpenAI 兼容反代（本仓库自写，零依赖 Node）
  raccoon2api/     商汤小浣熊（Raccoon Work）的 OpenAI 兼容反代（本仓库自写，零依赖 Node）
  qwenwork2api/    千问办公（QwenWork CN）的 OpenAI/Anthropic 反代（本仓库自写，零依赖 Node）
  dumate2api/      百度搭子（DuMate）的 OpenAI 兼容反代（本仓库自写，零依赖 Node）
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
cd E:/router
node router.mjs up
node router.mjs list
```

运行时的 PID 在 `E:\router\.run\processes.json`（已忽略）。
