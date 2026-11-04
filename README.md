# AI 编程订阅 → 本地路由：经验手册

把 Qoder、Trae、WorkBuddy、CodeArts 的订阅额度路由到 pi 与 opencode。
本目录两件事：**反代进程控制器**（`router.mjs`）+ **踩过的坑与判断依据**（`docs/`）。
provider 接入的实现代码已经整合到 `integrations/`（qodbuddy2pi、traework2api、
codearts2api），本目录是一个单独的 git 仓库。第三方来源与许可见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`router.mjs` 现在**直接启动、停止、重启、探活全部六家反代**：Qoder、WorkBuddy、
Trae、CodeArts 都归它管，不再依赖各家的安装脚本来拉起进程。PID、日志与端口清理由
router 自己维护（见 [docs/09-lifecycle.md](docs/09-lifecycle.md)）。

```
本地客户端 / 官方 openapi         本机路由层                消费端
────────────────────────         ──────────────────        ──────────
Qoder 网关 (COSY 私有协议) ──► qoder-proxy.js   :8789/8790 ──► pi
WorkBuddy 反代 (OpenAI)    ──► codebuddy_proxy :8787/8788 ──► opencode
CodeArts (SDK-HMAC)        ──► CodeArts2API    :10087
Trae 反代 (第三方, OpenAI)  ──► tw2api :7864 → img-proxy :7863
```

## 目录

| 文件 | 内容 |
|---|---|
| **[router.mjs](router.mjs)** | **统一启停：`up` / `down` / `restart` / `logs`；`on` / `off` / `all` / `none` 三处一起改** |
| [integrations/](integrations/) | **整合进来的三套反代源码 + 本地二进制/凭证说明** |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方来源、commit、许可证与二进制分发限制 |
| [docs/09-lifecycle.md](docs/09-lifecycle.md) | **反代进程生命周期：PID、日志、端口清理、登录自启** |
| [docs/07-selective.md](docs/07-selective.md) | 选择性启停的原理与三个坑 |
| [docs/08-codearts.md](docs/08-codearts.md) | 第六家：CodeArts Agent（华为云）|
| [docs/01-topology.md](docs/01-topology.md) | 全链路拓扑、端口、凭证位置、谁提供什么 |
| [docs/02-pitfalls.md](docs/02-pitfalls.md) | **踩过的坑**（最有价值的一份）：症状 → 真因 → 判断依据 → 修法 |
| [docs/03-qoder-protocol.md](docs/03-qoder-protocol.md) | Qoder 网关协议逆向要点（COSY 签名、body 编码、SSE 信封） |
| [docs/04-checklist.md](docs/04-checklist.md) | 新接入一家供应商时的排查清单（按顺序走） |
| [docs/05-operations.md](docs/05-operations.md) | 日常运维：启停、换账号、看日志、升级 |
| [docs/06-reuse.md](docs/06-reuse.md) | 怎么把这套经验套到新的供应商上 |
| [scripts/health.mjs](scripts/health.mjs) | 一键体检：端口、模型数、凭证有效期、端到端试打 |
| [scripts/verify-all.sh](scripts/verify-all.sh) | provider × 两个客户端全量实测 |
| [check.sh](check.sh) | 上面两个的组合入口 |

## 用起来

```bash
cd E:/router
node router.mjs list             # 看各家状态（开关/进程/PID/opencode/端口）
node router.mjs up               # 按当前开关启动全部反代
node router.mjs up --login       # 启动，缺凭证时打开浏览器登录
node router.mjs login            # 只检查/补齐登录，不动开关
node router.mjs login qoder      # 只登录 Qoder 国际版（浏览器 OAuth）
node router.mjs down             # 停止全部反代
node router.mjs restart trae-local   # 只重启 Trae
node router.mjs logs codearts 80     # 看 CodeArts 日志尾部
node router.mjs on qoder-cn      # 只开 Qoder 国内版，其余关掉
node router.mjs all              # 全开
node router.mjs none             # 全关（省内存）
node router.mjs doctor           # 自检：命令、文件、端口、opencode

bash E:/router/check.sh          # 体检 + 全量（10 项）
bash E:/router/check.sh quick    # 只体检，不消耗额度
bash E:/router/check.sh tools    # 额外测工具调用（最慢但最能暴露问题）

node E:/router/scripts/health.mjs --no-probe
node E:/router/scripts/health.mjs workbuddy-global    # 只查一个
```

`scripts/health.mjs` 与 `scripts/verify-all.sh` 是**只读**的：不写配置、不改凭证，随时可跑。
`router.mjs up/down/restart/on/off` 会改进程与 `opencode.json`；登录自启用
`node router.mjs service install [id...]` 注册 Windows 计划任务。

六家均已接入。最近一次完整 API 实测覆盖 5 家 provider × 2 客户端 + 工具调用；
CodeArts 已单独验证 `/v1/models` 与 opencode 写入。跑全量前先 `node router.mjs all`。

## 反代进程归 router 管

| 能力 | 命令 | 说明 |
|---|---|---|
| 启停 | `up` / `down` / `restart` | 六家统一走 spawn；带 `id` 只动这几家 |
| 浏览器登录 | `login [id...] [--force]` | 缺凭证时打开浏览器；交互式 `up/all` 默认自动尝试 |
| 看状态 | `list` / `status` | 开关、端口、PID、登录态、opencode、模型数 |
| 看日志 | `logs <id> [行数]` | 按 provider 聚合 stdout/stderr |
| 只停进程 | `down --keep-oc` | 保留 opencode provider，下次启动不用重写 |
| 登录自启 | `service install [id...]` | 生成 `router-<id>` 计划任务；`service uninstall` 停止并移除 |
| 自检 | `doctor` | 检查命令、工作目录、凭证变量、端口、opencode |

细节（为什么 PID 树 + 端口双重清理、日志在哪、Trae 两段式进程怎么收）见
[docs/09-lifecycle.md](docs/09-lifecycle.md)。

### 登录

交互式终端里，`up` / `all` / `on` / `reload` 发现某家没有凭证时会直接打开浏览器；
`--no-login` 关掉自动登录，`--login` 在非交互环境里强制尝试。也可以只跑登录：

```bash
node router.mjs login                 # 当前开启的供应商逐个检查
node router.mjs login qoder           # 只登录 Qoder 国际版（浏览器 OAuth）
node router.mjs login workbuddy --force   # 强制重新登录
```

| 供应商 | 浏览器登录方式 |
|---|---|
| Qoder 国际版 | 打开 `qoder.com/device/selectAccounts`，轮询 deviceToken，成功后写回 `~/.pi/agent/auth.json` |
| Qoder 国内版 | 只支持 PAT：打开 PAT 页面，终端里粘贴 `pt-...`，再交给 `qoder2pi login` |
| Trae | 启动 tw2api 后调 `login.ps1`，浏览器登录并自动回调 `127.0.0.1:18080` |
| CodeArts | 启动网关后调 `/admin/api/login/start`，浏览器 OAuth 回调网关本地端口 |
| WorkBuddy | 调 `workbuddy2pi login`，浏览器登录后写入账号池 |

## Git

本目录是单一仓库。源码、文档、vendored wheel 入库；凭证、日志、运行时 PID 和
上游二进制（`tw2api.exe`、`codearts2api.exe`）不入库。提交前可以这样确认：

```bash
git status
git diff --cached --stat
```

`integrations/` 的来源、快照 commit 与许可证见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 四条最贵的教训

1. **错误码的文字会骗人。** WorkBuddy 国际版的 `code 11128` 提示「可能不是官方客户端
   发出」，看着像要伪造客户端身份。真因是反代版本旧（缺 `X-Conversation-*` 头）+
   端点字符串不匹配（`workbuddy.ai` vs `codebuddy.ai`）。**先查版本与字符串，再怀疑身份。**

2. **同一份反代在国内站能用、国际站不能用，不代表账号有问题。** 两个站点的网关校验
   策略不同（国内站校验证书链没有 conversation 闸门）。**遇到「国内正常国际异常」，
   第一反应应该是「两个站点的校验规则不同」，去读上游的 changelog 与源码。**

3. **服务定义写死了二进制路径。** 旧版计划任务的 `.cmd` 里固化了 wheel 绝对路径，
   升级后 `restart` 不会换代码，必须重装服务。router 直管后每次启动都重新扫描
   `vendor/` 里最新的 wheel，绕开了这个问题；但**升级后仍要验证「进程实际加载的是
   哪个版本」，而不是「磁盘上放的是哪个版本」**。

4. **代理把上游错误变成「静默超时」，等于把可诊断的问题变成不可诊断的。**
   Qoder 国际版的排队限流（`10605 isQueued`）藏在 SSE 信封里，早期实现要等整条流读完
   才判断，于是客户端 60 秒后只看到连接被重置。修完是 433ms 返回
   `429 Retry-After: 30` + 一句人话。**任何「等很久然后什么都没发生」的故障，
   优先怀疑中间层在等一个永远不会来的响应。**

## 现状快照（2026-11-03）

| 来源 | provider | 端口 | pi | opencode | 备注 |
|---|---|---|---|---|---|
| Qoder 国内版 | `qoder-cn` | 8789 | ✓ 9 | ✓ 10 | |
| Qoder 国际版 | `qoder` | 8790 | ✓ 1 | ✓ 1 | 套餐只启用 1 个模型 |
| Trae | `trae-local` | 7863 | ✓ 10 | ✓ 10 | 第三方反代 |
| WorkBuddy 国内版 | `workbuddy` | 8787 | ✓ 32 | ✓ 23 | 反代 2.0.7 |
| WorkBuddy 国际版 | `workbuddy-global` | 8788 | ✓ 26 | ✓ 26 | 反代 2.0.7 + 端点修正 |
| CodeArts Agent | `codearts` | 10087 | ✓ 13 | ✓ 13 | 第三方 Go 网关，全部扣积分 |

实时状态跑 `node scripts/health.mjs`。
