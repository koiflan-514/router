# AI 编程订阅 → 本地路由：经验手册

把 Qoder、Trae、WorkBuddy、CodeArts、ZCode、Loomy、商汤小浣熊、千问办公、百度搭子、WPS 灵犀、有道龙虾的订阅额度路由到 pi 与 opencode。
本目录两件事：**反代进程控制器**（`router.mjs`）+ **踩过的坑与判断依据**（`docs/`）。
provider 接入的实现代码已经整合到 `integrations/`（qodbuddy2pi、traework2api、
codearts2api、zcode-bridge、loomy2api、raccoon2api、qwenwork2api、dumate2api、
lingxi2api、lobsterai2api），本目录是一个单独的 git 仓库。第三方来源与许可见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`router.mjs` 现在**直接启动、停止、重启、探活全部十三家反代**：Qoder、WorkBuddy、
Trae、CodeArts、ZCode、Loomy、商汤小浣熊、千问办公、百度搭子、WPS 灵犀、有道龙虾都归它管，不再依赖各家的安装脚本来拉起进程。PID、日志与端口清理由
router 自己维护（见 [docs/09-lifecycle.md](docs/09-lifecycle.md)）。WPS 灵犀（`lingxi`）走官方
app-server JSON-RPC（stdio）接对话，注意它是完整 agent、不吐 OpenAI tool_calls，
适合对话不适合编码驱动，详见 [integrations/lingxi2api](integrations/lingxi2api/README.md)。
有道龙虾（`lobster`）优先复用桌面端自己的 tokenProxy（刷新与用量归它），桌面端退出后
直连上游，积分与签到见 [integrations/lobsterai2api](integrations/lobsterai2api/README.md)。

```
本地客户端 / 官方 openapi         本机路由层                消费端
────────────────────────         ──────────────────        ──────────
Qoder 网关 (COSY 私有协议) ──► qoder-proxy.js   :8789/8790 ──► pi
WorkBuddy 反代 (OpenAI)    ──► codebuddy_proxy :8787/8788 ──► opencode
CodeArts (SDK-HMAC)        ──► CodeArts2API    :10087
Trae 反代 (第三方, OpenAI)  ──► tw2api :7864 → img-proxy :7863
ZCode (Z.ai 套餐)          ──► zcode-bridge   :20131
Loomy (讯飞 iModel)        ──► loomy-proxy    :8791 ──► pi / opencode
商汤小浣熊 (OpenAI 兼容)    ──► raccoon-proxy  :8793 ──► pi / opencode
千问办公 (OpenAI+Anthropic) ──► qwenwork-proxy :8794 ──► pi / opencode
百度搭子 (OpenAI 兼容)      ──► dumate-proxy   :8795 ──► pi / opencode
WPS 灵犀 (app-server RPC)   ──► lingxi-proxy   :8796 ──► pi / opencode
有道龙虾 (LobsterAI)        ──► lobster-proxy  :8797 ──► pi / opencode
                                     ▲
                                     │ 可选：统一网关（:8785）把上面十三家拼成
                                     │ 一个端口 + 双协议 + 跨供应商转移
                             router-gateway ──► Claude Code / opencode / pi
```

十三家模型反代各自有端口，客户端可以直接连（上文那种用法），也可以连**统一网关**：
一个 baseURL、模型名带供应商前缀、某家挂了自动换家。网关是叠加层，不替代任何一家。
WPS 灵犀也在网关里，但它不吐 tool_calls——编码 agent 的降级链别把它排进去。

## 目录

| 文件 | 内容 |
|---|---|
| **[router.mjs](router.mjs)** | **统一启停：`up` / `down` / `restart` / `logs`；`on` / `off` / `all` / `none` 三处一起改** |
| **[gateway/](gateway/README.md)** | **统一网关：一个端口 + Anthropic/OpenAI 双协议 + `<供应商>/<模型>` 路由 + 跨供应商故障转移 + 密钥与用量** |
| **[gateway/free-providers.mjs](gateway/free-providers.mjs)** | **18 家免费供应商：3 家本机免账号（Ollama/LM Studio/llama.cpp）+ 15 家有免费额度（需 key）** |
| [integrations/](integrations/) | **整合进来的反代源码 + 本仓库自写的 Loomy / 小浣熊 / 千问办公 / 百度搭子 / WPS 灵犀代理 + 本地二进制/凭证说明** |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方来源、commit、许可证与二进制分发限制 |
| [docs/09-lifecycle.md](docs/09-lifecycle.md) | **反代进程生命周期：PID、日志、端口清理、登录自启** |
| [docs/07-selective.md](docs/07-selective.md) | 选择性启停的原理与三个坑 |
| [docs/08-codearts.md](docs/08-codearts.md) | CodeArts Agent（华为云）|
| [docs/10-codearts-no-agent.md](docs/10-codearts-no-agent.md) | **不装 Agent 的 CodeArts 复刻说明：给 AI 的协议、签名与 OAuth 配置稿** |
| [docs/01-topology.md](docs/01-topology.md) | 全链路拓扑、端口、凭证位置、谁提供什么 |
| [docs/02-pitfalls.md](docs/02-pitfalls.md) | **踩过的坑**（最有价值的一份）：症状 → 真因 → 判断依据 → 修法 |
| [docs/03-qoder-protocol.md](docs/03-qoder-protocol.md) | Qoder 网关协议逆向要点（COSY 签名、body 编码、SSE 信封） |
| [docs/04-checklist.md](docs/04-checklist.md) | 新接入一家供应商时的排查清单（按顺序走） |
| [docs/05-operations.md](docs/05-operations.md) | 日常运维：启停、换账号、看日志、升级 |
| [docs/11-gateway.md](docs/11-gateway.md) | **统一网关运维：启停、端口交叉校验、额度快照、排查顺序、与 OpenResolver 对照** |
| [docs/12-gateway-tuning.md](docs/12-gateway-tuning.md) | **网关调优：降级链怎么配、本地应答怎么关、失败分类怎么读** |
| [docs/13-limits.md](docs/13-limits.md) | **本机限流：为什么限、四个维度、四档预设、硬约束、三层生效范围** |
| [docs/06-reuse.md](docs/06-reuse.md) | 怎么把这套经验套到新的供应商上 |
| [scripts/health.mjs](scripts/health.mjs) | 一键体检：端口、模型数、凭证有效期、端到端试打 |
| [scripts/pi-models.mjs](scripts/pi-models.mjs) | **把全部上游写进 pi 的 `models.json`：本机十三家 + `router-gateway` + 免费供应商（写前备份）** |
| [scripts/lib/pi-sync.mjs](scripts/lib/pi-sync.mjs) | pi 模型表的唯一写入点：读改写 / 备份 / 合并 / 删除，网关与免费供应商的 provider 构造 |
| [scripts/verify-all.sh](scripts/verify-all.sh) | provider × 两个客户端全量实测 |
| [check.sh](check.sh) | 上面两个的组合入口 |
| [tui/](tui/README.md) | **Rust TUI 控制仪表盘：统一查看、启停、账号、额度、日志与诊断** |
| [frontend/](frontend/README.md) | **网页面板：React 19 + Vite 的浏览器控制台；经回环桥接复用 CLI 与网关，SSE 推流** |

## 用起来

```bash
cd D:/router
node router.mjs gateway up        # 起统一网关（:8785，一个端口两种协议）
node router.mjs gateway install   # 让 opencode 与 pi 用 router-gateway/<供应商>/<模型>
node router.mjs list             # 看各家状态（开关/进程/PID/opencode/端口）
node router.mjs account          # 看账号池与当前生效账号
node router.mjs account add workbuddy     # 浏览器登录，往账号池里加一个账号
node router.mjs account remove workbuddy c # 删除账号（先归档到 retired-*，可恢复）
node router.mjs account restore workbuddy  # 把删掉的账号从归档捡回来
node router.mjs account check             # 只列出需要重登 / 快过期 / 积分为 0 的账号
node router.mjs account merge codearts    # 合并同一账号的重复记录（重登会新增记录）
node router.mjs claim zcode               # 领取 ZCode 限时套餐（周末/夜间 Token 包）
node router.mjs limits                    # 看本机限额（并发/速率），防止上游判定套流
node router.mjs limits raccoon max        # 改某家档位（safe/balanced/fast/max）
node router.mjs limits --apply            # 把限额下发给自带限流器的反代（CodeArts）
node router.mjs service claim install     # 定时领取：每 2 小时自动跑一次
node router.mjs account workbuddy b       # 切到 WorkBuddy 的 slot b（自动重启）
node router.mjs account codearts GT-demo   # CodeArts 只启用这个账号
node router.mjs account trae-local --all      # Trae 恢复全部账号参与调度
node router.mjs login loomy      # 拉起源飞 Loomy 桌面端并等它写回登录态
node router.mjs up loomy         # 启动 Loomy 反代（:8791）
node router.mjs login raccoon    # 拉起商汤小浣熊桌面端并等它写回 IAM token
node router.mjs up raccoon       # 启动小浣熊反代（:8793）
node router.mjs login qwenwork   # 拉起千问办公桌面端，登录后发一句话才会签发 key
node router.mjs up qwenwork      # 启动千问办公反代（:8794）
node router.mjs login dumate     # 拉起百度搭子桌面端并等它写回登录态
node router.mjs up dumate        # 启动百度搭子反代（:8795）
node router.mjs up lingxi        # 启动 WPS 灵犀反代（:8796，对话 + 智点余额）
curl -s http://127.0.0.1:8796/v1/quota    # 查灵犀智点余额
node router.mjs up lobster       # 启动有道龙虾反代（:8797，对话 + 积分/签到）
curl -s http://127.0.0.1:8797/v1/quota    # 查龙虾积分包、签到状态与倍率
node router.mjs sync             # 让 opencode 与 pi 的 provider 跟开关一致（--no-pi 只同步 opencode）
node router.mjs models           # 按上游 /v1/models 刷新 opencode 与 pi 的模型清单
node router.mjs pi               # 看 pi 的 provider 与扩展状态
node router.mjs pi sync          # 刷新 pi 模型表，并部署积分/签到扩展
node scripts/pi-models.mjs       # 只刷新 pi 的 models.json：十三家反代 + router-gateway + 免费供应商
node scripts/pi-models.mjs gateway   # 只写统一网关（一个 baseURL，模型名带供应商前缀）
node scripts/pi-models.mjs free      # 只写免费供应商（有 key / 本机免账号的那些）
node router.mjs up               # 按当前开关启动全部反代
node router.mjs up --all         # 全开并启动（等价于 all；开关为空时也不会“什么都不发生”）
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

node router.mjs gateway status        # 网关调度快照：权重/冷却/并发/粘性
node router.mjs gateway key add --name dev --providers trae-local,zcode --days 30
node router.mjs gateway combo add --name fast --models 'trae-local/glm-5.3-flash,zcode/glm-5.3'
node router.mjs gateway local          # 本地应答开关（省额度）
node router.mjs gateway usage --days 7   # 用量聚合（网关没跑也能读）
node router.mjs gateway balance        # 各家额度汇总
node router.mjs gateway doctor         # 网关自检 + 端口交叉校验
node router.mjs gateway refresh-quota  # 采集额度写快照（影响调度权重）
node router.mjs providers list         # 18 家免费供应商（3 本机 + 15 有免费额度）
node router.mjs providers key openrouter sk-or-...   # 配 key（加密落盘）
node router.mjs providers test         # 探活（只验地址，不验 key）
node gateway/selftest.mjs              # 网关自测：66 项（不耗额度）

bash E:/router/check.sh          # 体检 + 全量（10 项）
bash E:/router/check.sh quick    # 只体检，不消耗额度
bash E:/router/check.sh tools    # 额外测工具调用（最慢但最能暴露问题）

node E:/router/scripts/health.mjs --no-probe
node E:/router/scripts/health.mjs workbuddy-global    # 只查一个
```

`scripts/health.mjs` 与 `scripts/verify-all.sh` 是**只读**的：不写配置、不改凭证，随时可跑。
`router.mjs up/down/restart/on/off` 会改进程与 `opencode.json`；`account` 会改账号池
并重启对应反代（`--dry-run` 可只看不写）；登录自启用
`node router.mjs service install [id...]` 注册 Windows 计划任务。

### TUI 控制仪表盘

`tui/` 提供可选的 Rust 终端界面，复用本目录的 Node.js 控制逻辑。先用匿名数据查看界面：

```bash
cd D:/router
cargo run --manifest-path tui/Cargo.toml -- --demo
```

连接真实本机 router（需要 Node.js；交互式终端）：

```bash
cargo run --manifest-path tui/Cargo.toml -- --router-root .
cargo run --manifest-path tui/Cargo.toml -- --router-root . --read-only
```

TUI 启动和刷新只读，不会自动登录、签到或试打；启停、切号和多目标操作都有确认。
`7` 打开用量分析，可查看 OpenCode 真实会话、Token、活动、工具成功率和模型聚合。
设计、键位、安全边界与已知限制见 [tui/README.md](tui/README.md) 和
[tui/docs/](tui/docs/README.md)。

### 网页面板

`frontend/` 提供同一套能力的**浏览器控制台**（React 19 + Vite）。它不直接碰进程，而是通过一个
**只监听回环（`127.0.0.1:8792`）的 Node 桥接服务**复用 `router.mjs` 与统一网关：桥接用参数数组
spawn CLI、代理网关 HTTP、用 SSE 推送日志与任务进度。浏览器不直连网关（网关无 CORS，也不能启停进程）。

```bash
cd frontend
npm install
npm run dev                 # 开发：http://127.0.0.1:5173（Vite 代理到桥接）
npm run build && npm run start   # 生产：http://127.0.0.1:8792（桥接同源托管页面与 /api）
npm run start -- --demo     # 演示：匿名数据，不 spawn 进程、不读真实文件
npm run start -- --read-only # 只读：写操作在桥接层被拒绝
```

页面：总览、服务、额度、账号、日志、诊断、用量、网关（调度/用量/降级链/密钥/免费供应商/本地应答）、
设置。安全语义与 TUI 一致：危险操作显式确认、写任务串行、只读/演示在桥接层拦截、日志/任务输出脱敏。
设计与契约见 [frontend/README.md](frontend/README.md) 和 [frontend/docs/](frontend/docs/README.md)。

### 更新模型列表

反代上游加/删模型后，一条命令刷新所有已开启的：

```bash
node router.mjs models              # 全部已开启的；也可指定 id：models zcode loomy
```

它按各家来源走对应路径（都会先备份 `opencode.json`）：Qoder/Trae/CodeArts/ZCode/Loomy
直接拉 `/v1/models`；WorkBuddy 交给 `workbuddy2pi opencode install`，因为它的模型表只能
来自 pi 扩展。注意 `node router.mjs sync` 只补「开关里有、客户端里没有」的 provider，
**不会**刷新已存在的模型清单——上游增删模型要跑 `node router.mjs models`。默认两边一起
刷新；`--no-pi` 只动 opencode。

`/v1/models` 需要桌面端登录态的那些家（Loomy、小浣熊、灵犀、龙虾）在未登录时回 401，
这时 `sync` 会退到 pi 模型表里的快照写 provider，选择器里至少不是空的；登录后再跑
`models` 换成实时目录。

需要分来源手工刷新时：

```bash
node integrations/qodbuddy2pi/assets/qoder2pi opencode install          # Qoder 两个区域
node integrations/qodbuddy2pi/assets/workbuddy2pi opencode install      # WorkBuddy 国内
node integrations/qodbuddy2pi/assets/workbuddy2pi global opencode install # WorkBuddy 国际
node scripts/pi-models.mjs                                             # pi 的 Trae / CodeArts / ZCode / Loomy
```

Trae 的 provider 在 `~/.config/opencode/opencode.jsonc`（用户自管，router 按设计不改），
要更新得手工编辑那一份；`scripts/pi-models.mjs` 只写 pi 侧。

WorkBuddy 的模型目录以 pi 扩展读到的产品目录为准（`workbuddy.ts`；国际版没有桌面端
目录时用内置静态表，静态表按上游 `/v3/config` 校准），不要直接抄反代的
`/v1/models`，那份是包作者猜的。Qoder 的代理有 1 小时模型缓存，必要时先
`curl 'http://127.0.0.1:8789/v1/models?refresh=1'` 强制刷新。

### 双系统共享账号

两套 Windows（例如 `C:\Users\Administrator` 与 `D:\Users\demo`）共用同一个
`E:\router` 时，账号和配置默认会各自漂移。router 用 `E:\router\.shared-home`
作为共享库（已在 `.gitignore`，里面是凭证，绝不入库）：

```bash
node router.mjs sync-homes                 # 立即合并并写回两边
node router.mjs sync-homes --status        # 只看共享库，不写文件
node router.mjs sync-homes --homes "C:\Users\Administrator;D:\Users\demo"   # 首次登记
```

每次运行 `router.mjs` 都会在启动前和退出前自动同步一次，所以正常用 `up` / `account`
即可，不需要手动记命令。规则：

- **WorkBuddy**：账号池按 uid 做并集，不会因为同步丢号；当前账号按最后一次切换为准。
- **Qoder**：每个区域只有一条凭证；首次同步固定为当时账号，之后同一 `userID` 自动
  续期。明确重新登录会更新共享账号，另一套系统里的旧备份不会把账号换回去。
- **opencode / pi models / Qoder 模型缓存**：以最新修改的一份为准，写回所有 home。
- **opencode 插件**（`~/.config/opencode/plugins/{provider-credits,token-limits}`）：代码不做 mtime
  合并。首次在某台机器上跑同步时从共享库装一份；已有就**不覆盖**，避免把正在改的版本
  冲掉。要升级就手工替换那一份（或在改动后删掉它让同步重装）。
- 所有被覆盖的文件都会留 `.bak-sync-<时间>` 备份。

十三家均已接入（ZCode、Loomy、小浣熊、千问办公、百度搭子、WPS 灵犀、有道龙虾需登录后才有模型）。最近一次完整 API 实测覆盖 5 家 provider × 2 客户端 + 工具调用；
CodeArts 已单独验证 `/v1/models` 与 opencode 写入。跑全量前先 `node router.mjs all`。

## 反代进程归 router 管

| 能力 | 命令 | 说明 |
|---|---|---|
| 启停 | `up` / `down` / `restart` | 十三家模型反代统一走 spawn；带 `id` 只动这几家 |
| 浏览器登录 | `login [id...] [--force]` | 缺凭证时打开浏览器；交互式 `up/all` 默认自动尝试 |
| 看状态 | `list` / `status` | 开关、端口、PID、登录态、opencode、模型数 |
| 账号切换 | `account [id] [账号]` | 列出/切换 WorkBuddy、CodeArts、Trae 的账号；`--all` 恢复整池、`--dry-run` 只预览 |
| 账号增删 | `account add` / `account remove` / `account restore` | 加账号走浏览器登录；删除先归档到 `retired-*`，可 restore 捡回 |
| 账号体检 | `account check` | 只列需要处理的账号（需重登 / 快过期 / 积分为 0 / 冷却中），并给出修复命令 |
| 账号去重 | `account merge codearts` | 按套餐用量指纹找出同一账号的多条记录并合并（重登会新增记录） |
| 限时套餐 | `claim zcode` / `service claim install` | 领取 ZCode 周末/夜间 Token 包；可注册每 2 小时的计划任务 |
| **本机限额** | `limits [id] [tier]` / `limits --check` / `limits --apply` | 并发/速率/间隔/每日上限，见 [docs/13-limits.md](docs/13-limits.md) |
| 添加账号 | `account add <id>` | 浏览器登录后写入账号池；已有账号只更新不重复 |
| 看日志 | `logs <id> [行数]` | 按 provider 聚合 stdout/stderr |
| 只停进程 | `down --keep-oc` | 保留 opencode provider，下次启动不用重写 |
| 双系统同步 | `sync-homes [--status]` | 合并共享账号库并写回两个 home；启动/退出自动跑 |
| 登录自启 | `service install [id...]` | 生成 `router-<id>` 计划任务；`service uninstall` 停止并移除 |
| 自检 | `doctor` | 检查命令、工作目录、凭证变量、端口、opencode |
| **统一网关** | `gateway up/status/key/usage/balance/doctor` | 见 [gateway/README.md](gateway/README.md) |

细节（为什么 PID 树 + 端口双重清理、日志在哪、Trae 两段式进程怎么收）见
[docs/09-lifecycle.md](docs/09-lifecycle.md)。

### 统一网关（可选）

十三家各自是独立端口、各自一套模型清单。**网关把它们拼成一个端口**，客户端只配一次：

```bash
node router.mjs gateway up          # 起网关（:8785）
node router.mjs gateway install     # 把网关写成 opencode + pi 的 provider
curl -s http://127.0.0.1:8785/v1/models | head -c 300
```

三个关键点：

- **模型名三种写法**：`trae-local/glm-5.3-flash`（只用这家）、`glm-5.3-flash`（按权重自动选）、
  `combo:fast`（自己定一条降级链）。
- **双协议**：`/v1/messages` 与 `/v1/chat/completions` 同时可用；上游只支持 OpenAI 的
  （Qoder/Trae/WorkBuddy/Loomy）会自动转换，CodeArts/ZCode 走原生。
- **跨供应商转移**：某家 429/5xx/额度耗尽时自动换下一家，客户端只看到 200。

还有两个「省额度、少踩坑」的特性：

- **本地应答**：Claude Code 每轮都发的五个固定问题（额度探测、命令前缀、会话标题、
  建议模式、文件路径）在网关进程内直接答，不花一次上游调用。
- **工具调用配对修复**：一段「有 tool_use 没有 tool_result」的历史会让上游 400，而且
  因为历史不变，之后每一轮都 400。网关在收口上修一次。

### 免费供应商（叠加在 13 家之上）

除了 13 家本机反代，网关还能接入 **18 家免费供应商**：

```bash
node router.mjs providers list              # 看状态
node router.mjs providers key openrouter sk-or-v1-...
node router.mjs providers test openrouter
```

| 类别 | 数量 | 要 key | 例子 |
|---|---|---|---|
| 本机免账号 | 3 | 否 | Ollama、LM Studio、llama.cpp |
| 有免费额度 | 15 | 是 | OpenRouter、OpenCode Zen、Gemini、NVIDIA NIM |

它们**不进 `PROVIDERS`**（那张表是「spawn 什么进程」），而是由网关直接当作上游。
配好 key 之后，模型名同样是 `<供应商>/<模型>`，可以和 13 家混在一条降级链里：

```bash
node router.mjs gateway combo add --name free \
  --models 'trae-local/glm-5.3-flash,openrouter/openrouter/free,gemini/gemini-3.8-flash'
```

key 不写进 `config.json`，单独放 `gateway/data/providers.json` 并 AES-256-GCM 加密。

网关是**叠加层**，不替代任何一家反代：十三家的进程、账号、登录仍由 router 管。
完整说明（调度公式、失败分类、密钥、配置、观测端点）见 [gateway/README.md](gateway/README.md)。

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
| Loomy | 无命令行登录：`router login loomy` 会拉起桌面端并等它写回 `auth-session.json` |
| 商汤小浣熊 | 无命令行登录：`router login raccoon` 会拉起桌面端并等它写回 `agent/config/auth.json` 的 IAM token |
| 千问办公 | 无命令行登录：`router login qwenwork` 会拉起桌面端；登录后**必须在对话里发一句**，桌面端才会签发 `engine-maas-key.dat` |
| 百度搭子 | 无命令行登录：`router login dumate` 拉起桌面端并等它写回 `auth.json` |
| WPS 灵犀 | 无命令行登录：在 WPS 灵犀桌面端登录，SID 写进 Electron cookie 库后反代自动读到 |
| 有道龙虾 | 无命令行登录：在 LobsterAI 桌面端登录，凭据写进桌面的 SQLite，反代自动读到 |

## 两个客户端各自怎么接

各家反代对 opencode 是统一口径（都是 OpenAI 兼容端点，`router sync` 写
`opencode.json`）；对 pi 则分三块，**写错地方会静默失效**（见
[docs/02-pitfalls.md](docs/02-pitfalls.md) P19）：

| pi 侧 provider | 谁负责 | 命令 |
|---|---|---|
| `qoder` / `qoder-cn` | 扩展 `pi-provider-qoder`（私有协议直连，不经反代） | `pi install integrations/qodbuddy2pi/assets/vendor/pi-provider-qoder` |
| `workbuddy` / `workbuddy-global` | 扩展 `~/.pi/agent/extensions/workbuddy.ts`（读桌面端产品配置） | 拷过去 + `node integrations/qodbuddy2pi/assets/workbuddy2pi ensure-auth-key` |
| `trae-local` / `codearts` / `zcode` / `loomy` / `raccoon` / `qwenwork` / `dumate` / `lingxi` / `lobster` | `~/.pi/agent/models.json` | `node router.mjs pi sync` 或 `node scripts/pi-models.mjs [id] [--dry-run]` |
| `router-gateway` | 统一网关的 pi provider（模型名 `<供应商>/<模型>` + combo） | `node router.mjs pi sync gateway` 或 `node router.mjs gateway install` |
| 免费供应商（18 家中有 key / 本机免账号的） | 每家一个直连 provider，与 opencode 同口径 | `node router.mjs pi sync free` 或 `node router.mjs providers install` |

`pi-models.mjs` 从各家 `/v1/models` 拉清单、带上 `apiKey`（Trae 取
`integrations/traework2api/.env.local`，CodeArts 取它自己签发的 `sk-ca-...`，
ZCode / Loomy / 小浣熊 / 有道龙虾用占位 key——本机回环不校验）与 `compat`，别的 provider（如 `TokenPlus`）
原样保留，写前备份到 `~/.pi/agent/models.backups/`。Qoder 与 WorkBuddy 会被它
主动跳过并说明原因。`router gateway install` 与 `providers install` 走同一份
写入实现（`scripts/lib/pi-sync.mjs`），所以两条路不会互相覆盖。

`node router.mjs pi` 把上面这些收成一张状态表：哪些 provider 走扩展、哪些在
`models.json`、各有几个模型、积分扩展装没装。`node router.mjs pi sync` 刷新模型表
并部署扩展；`node router.mjs pi install --force` 只重装扩展。`router sync` / `pi sync`
全量跑时还会把开关已关掉的本地 provider 从 pi 的模型表里移除，避免选择器里留着
点了就报连不上的条目。

### 在 opencode 里看积分

`~/.config/opencode/plugins/provider-credits/` 是一个只读插件：状态栏显示当前模型的
倍率与余额，侧边栏与 `/credits` 面板按显示宽度对齐列余额与逐模型倍率，另有
`credits` 工具供 agent 查询。它直连本机反代（`/v1/quota`、`/admin/api/credits`）与
官方只读接口，不保存新凭据、不签到（除非显式 `checkin:true`）。覆盖十三家里能查余额
的每一家：Trae、CodeArts、WorkBuddy 国内/国际、Qoder 国内/国际、Loomy、小浣熊、
千问办公、百度搭子、WPS 灵犀、有道龙虾、ZCode。拿不到的来源会写明原因，不用估算值冒充。

### 上下文与输出限额

两套客户端都默认把**所有模型**限制在 **300k 上下文 / 32k 输出**，并按同一阈值自动压缩：
`context - max(16k, 15% × context)`，300k 时就是 **255k**。

opencode 侧由 `~/.config/opencode/plugins/token-limits/` 提供，不用改 `opencode.json`：

```text
/limits                 # 滑块面板；或 Ctrl+Alt+L
/limits 300k 32k        # 当前模型
/limits provider 300k   # 当前供应商的所有模型
/limits all 300k 32k    # 全部模型
/limits reset           # 清除覆盖
```

覆盖值存在 OpenCode 的插件 storage 里，重启仍在；`opencode.json` 的 `limit` 保持原样。
插件按**生效后**的上下文自动压缩，到达阈值时排队走 OpenCode 原生的 `session.compact`；
调低限额后，已经超限的会话也会立刻排队压缩。`~/.config/opencode/cli.json` 里的
`"plugins": ["*", "-opencode.sidebar.context"]` 关掉内置 Context 卡片，由插件接管，
这样侧栏会显示 `limit` 与 `auto compact at` 的真实生效值。

pi 侧由 `~/.pi/agent/extensions/token-limits/` 提供（`node router.mjs pi install --limits`
部署），命令同名：

```text
/limits                       # 当前模型生效值与压缩阈值
/limits 200k 16k              # 当前模型
/limits provider 300k 32k     # 当前供应商
/limits all 300k 32k          # 默认值（所有模型，含以后新增的）
/limits reset                 # 当前模型回默认
/limits reset all             # 清空所有单项覆盖
```

默认值存在 `~/.pi/agent/token-limits.json`。`scripts/lib/pi-sync.mjs` 写 `models.json`
时会给每个模型补上 `contextWindow: 300000` / `maxTokens: 32000`，扩展再在
`before_provider_request` 里兜底输出上限，并在 `turn_end` 检查上下文调用 pi 原生的
`ctx.compact()`。扩展直连的 Qoder / WorkBuddy 模型由 `models.json` 的 `modelOverrides`
套同一组限额，所以 `pi --list-models` 里也是 300K / 32K。

Trae / CodeArts / ZCode / 百度搭子这些反代的 `/v1/models` 不报
`capabilities.reasoning`，pi 会因此只给 `off` 一个思考档。`scripts/lib/model-caps.mjs`
按模型族补 `reasoning: true`（DeepSeek V3/V4、GLM 4.5+、Kimi K2/K3、Qwen 3.5+、
豆包 Seed 2、MiniMax M2/M3、GPT-5/6 等），写 `models.json` 和网关目录时都会走这一层。

### 在 pi 里看积分

`node router.mjs pi sync` 会把积分/签到扩展装到
`~/.pi/agent/extensions/qodbuddy2pi/`（`index.ts` + `quota.js`）。装完后：

```text
/credits              # 一张表：十三家的余额、签到状态、当前模型倍率
/credits checkin      # 顺手把能签的都签了
/credits lobster      # 只看某个来源
```

也可以直接问模型（它有一个 `credits` 工具，参数 `provider` / `model` / `action`）：

> 我还剩多少积分？今天签到领了吗？这个模型多少倍率？

TUI 状态栏只显示**当前正在用的那一家**的余额，并在有公开倍率时带上当前模型的倍率
（例如 `Lobster 684.88 · x0.05`），不会把四五家堆在一行。数据层 `quota.js` 与
`qoder2pi credits` 共用：只读本机反代与 pi 自己的凭证，不伪造设备身份、不改登录态；
签到只在 `/credits checkin` 或工具 `action: "checkin"` 时真的发请求。拿不到的来源
会显示原因（未登录 / 服务没起 / 反代 401），而不是静默省略。

## 隐私与安全

本仓库只放代码、文档与可复现的配置样例，**不含任何真实凭证**：

- 账号池、cookie、token、`state.vscdb` 解密结果、网关密钥库与用量都落在
  `.gitignore` 覆盖的目录（`.shared-home/`、`gateway/data/`、`**/auths/`、
  `**/data/`、`.env*`、`*.log` 等），不入库。
- 文档与示例里的账号名、UID、AccessKey 前缀、Windows 用户名与机器名已脱敏为
  `demo` / `DEMO-PC`；示例积分与倍率只用于说明格式，不是真实账号快照。
- 日志、运行时 PID、opencode 会话状态和上游二进制
  （`tw2api.exe`、`codearts2api.exe`、`zcode-bridge.exe`）不入库；第三方来源、
  快照 commit、许可证与分发限制见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 提交前自检：`git status --short`、`git diff --cached --stat`，确认没有
  `.env`、日志、凭证文件或真实账号信息。

**声明**：本项目用于个人学习与自有账号的本地路由，不提供、不分发任何上游服务
或账号。使用前请阅读各供应商的服务条款；因使用本工具导致的账号限制、额度损失
或服务中断，由使用者自行承担。

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

## 现状快照（2026-11-20）

| 来源 | provider | 端口 | pi | opencode | 备注 |
|---|---|---|---|---|---|
| Qoder 国内版 | `qoder-cn` | 8789 | ✓ 12 | ✓ 13 | Free 套餐 + 加购额度；pi 不列 Auto，opencode 会列；免费号按并发排队（10605） |
| Qoder 国际版 | `qoder` | 8790 | ✓ 1 | ✓ 12 | 套餐只启用 1 个模型；opencode 走代理目录，会把 12 个都列出来 |
| Trae | `trae-local` | 7863 | ✓ 31 | ✓ 31 | 第三方反代 |
| WorkBuddy 国内版 | `workbuddy` | 8787 | ✓ 30 | ✓ 35 | 反代 2.0.7；已剔除 11102/11150 的 5 个失效条目 |
| WorkBuddy 国际版 | `workbuddy-global` | 8788 | ✓ 10 | ✓ 21 | 反代 2.0.7 + 端点修正；只保留当前免费账号能调通的模型 |
| CodeArts Agent | `codearts` | 10087 | ✓ 12 | ✓ 12 | 第三方 Go 网关，全部扣积分 |
| ZCode (Z.ai) | `zcode` | 20131 | ✓ 6 | ✓ 6 | zcode-bridge（MIT）；用桌面端凭据 |
| Loomy（讯飞） | `loomy` | 8791 | ✓ 6 | ✓ 6 | 本仓库自写反代；账号已被停用，opencode 侧用 pi 模型表兜底 |
| 商汤小浣熊 | `raccoon` | 8793 | ✓ 10 | ✓ 9 | 本仓库自写反代；读桌面端 IAM token，上游本来就吐 OpenAI |
| 千问办公 | `qwenwork` | 8794 | ✓ 13 | ✓ 13 | 本仓库自写反代；解 Electron OSCrypt 读 MaaS key 并自续期，原生双方言 |
| 百度搭子 | `dumate` | 8795 | ✓ 23 | ✓ 23 | 本仓库自写反代；main-server 端口每次启动随机，模型目录读桌面端落盘的 opencode.json |
| WPS 灵犀 | `lingxi` | 8796 | ✓ 13 | ✓ 13 | 本仓库自写反代；spawn 官方 app-server（JSON-RPC stdio），从 Electron cookie 库解 wps_sid；agent 形态不吐 tool_calls |
| 有道龙虾 | `lobster` | 8797 | ✓ 23 | ✓ 23 | 本仓库自写反代；读桌面端 SQLite 登录态，优先复用桌面端 tokenProxy；积分包 + 签到 + 倍率 |
| 统一网关 | `router-gateway` | 8785 | ✓ 159 | ✓ 159 | 十三家并集 + combo；由 `gateway install` 写入 |

实时状态跑 `node scripts/health.mjs`。
