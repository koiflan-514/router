# 日常运维

> **适合**：日常使用与运维：启停、切号、刷新模型、升级、看日志。  
> **前置**：已完成 [快速开始](../README.md#快速开始)。  
> **相关**：[选择性启停](07-selective.md) · [进程生命周期](09-lifecycle.md) · [本机限流](13-limits.md)

## 一眼看状态

```bash
node router.mjs list                 # 开关 / 进程 / PID / opencode / 端口
node router.mjs account              # 账号池 / 当前生效账号
node router.mjs doctor               # 命令、文件、端口、opencode 自检
node scripts/health.mjs              # 端口 + 凭证 + 端到端试打
node scripts/health.mjs --no-probe   # 只看端口与凭证（省额度）
bash scripts/verify-all.sh           # pi + opencode 全量
bash scripts/verify-all.sh tools     # 工具调用（最慢，最有用）
```

## 启停反代

十三家反代统一走 router，不再分别调各家的 `start` / `stop`：

```bash
node router.mjs up                   # 按开关启动（开关为空时什么都不启动）
node router.mjs up --all              # 先全开再启动，等价于 router.mjs all
node router.mjs up trae-local         # 只启动一家（不改开关）
node router.mjs restart workbuddy     # 重启
node router.mjs down                 # 停止全部
node router.mjs down --keep-oc        # 只停进程，保留 opencode provider
node router.mjs logs codearts 80      # 日志尾部
```

生命周期、PID 与端口清理细节见 [09-lifecycle.md](09-lifecycle.md)。

## 双系统共享账号

双系统共用 `<repo>` 时，用共享库把两边的登录态、账号池和 opencode/pi 配置对齐：

```bash
node router.mjs sync-homes                 # 立即同步
node router.mjs sync-homes --status        # 只读查看
node router.mjs sync-homes --homes "C:\Users\Administrator;D:\Users\demo"
```

共享库固定在 `<repo>\.shared-home`，每次 `router.mjs` 启动/退出也会自动跑一次。
WorkBuddy 账号池按 uid 并集合并；Qoder 单账号首次同步固定为当时账号，之后同 userID
自动续期，明确重新登录会更新共享账号；当前 WorkBuddy 账号以最后一次 `account` 切换为准。
覆盖前都会在文件旁留 `.bak-sync-<时间>` 备份。

## 浏览器登录

router 会先读凭证文件，不靠端口猜：

| 供应商 | 判定 | 登录动作 |
|---|---|---|
| Qoder 国内版 | `~/.pi/agent/auth.json` 的 `qoder-cn.access` | 打开 PAT 页面；交互终端里粘贴 `pt-...` |
| Qoder 国际版 | 同上 `qoder.access` | 打开 `qoder.com/device/selectAccounts`，轮询设备授权 |
| Trae | `integrations/traework2api/auths/trae-*.json` | 启动 tw2api 后跑 `login.ps1`，自动回调 `127.0.0.1:18080` |
| CodeArts | 数据文件 `accounts[].session` | 启动网关后走 `/admin/api/login/start` 浏览器 OAuth |
| WorkBuddy | `~/.codebuddy*-session.json` 的 `auth.accessToken` | `workbuddy2pi [global] login` |

```bash
node router.mjs login                 # 当前开启的供应商逐个检查
node router.mjs login qoder           # 只登录国际版
node router.mjs login trae-local       # 会临时启动 tw2api，登录后恢复原状态
node router.mjs login --force          # 已登录也重新走一遍
```

交互式 `up` / `all` / `on` / `reload` 默认会自动打开浏览器；脚本、计划任务或管道里
只打印提示。`up --login` 可强制尝试，`--no-login` 可关闭自动登录。

> router 调用的是 `integrations/qodbuddy2pi/assets` 里的源码。想在 shell 里直接敲
> `qoder2pi` / `workbuddy2pi`，可以加别名：
> `alias qoder2pi='node integrations/qodbuddy2pi/assets/qoder2pi'`。

## 切换账号

`router account` 统一了各家不同的换号方式，不用再记 `workbuddy2pi account`、
CodeArts 控制台或 Trae 的 state 文件：

```bash
node router.mjs account                    # 所有账号 + 当前生效
node router.mjs account workbuddy          # 只看一家
node router.mjs account workbuddy b        # 切到 slot b（运行中会自动重启）
node router.mjs account codearts GT-demo   # 只启用这个账号
node router.mjs account trae-local --all      # 恢复整池参与调度
node router.mjs account codearts 2 --dry-run  # 预览，不写文件不重启
node router.mjs account add workbuddy         # 浏览器登录，往池里加一个账号
```

添加账号统一用 `account add <id>`（等价写法 `account <id> --add`）。它会走该家
原有的浏览器登录流程：WorkBuddy 新 uid 写新 slot、已有 uid 只更新；CodeArts
登录成功即入库；Trae 按登录的 uid 落一个 `auths/trae-<uid>.json`。同一个账号
不会重复添加。Qoder 是单账号，不能往池里加，换号用 `login <id> --force`。

## 增删账号与账号体检

```bash
node router.mjs account check                 # 只列出需要处理的账号
node router.mjs account remove workbuddy c    # 删除 slot c
node router.mjs account remove trae-local 3 --force   # 有故障的账号要 --force
node router.mjs account restore workbuddy     # 从归档恢复
```

**删除是两步的：先归档，再从调度池移除。** WorkBuddy 的 slot 与 Trae 的
`auths/trae-<uid>.json` 会先被复制到同级 `retired-<时间>/` 目录，`account restore`
可以把它们捡回来（同名不覆盖）。CodeArts 的凭证存在网关数据文件里、删掉就没了，
只能重新登录；Qoder 没有账号池。

`account remove` 会拒绝两件事，都是为了让误操作不至于丢凭证：

- **当前生效的 WorkBuddy 账号**：先 `account workbuddy <别的 slot>` 再删。
- **`health` 判为 error 的账号**（除非加 `--force`）：这类账号通常只要重新登录，
  删掉反而把凭证弄丢了。提示里会直接给重新登录的命令。

还有一个容易踩的点：WorkBuddy 账号池是按 uid 求**并集**合并的（双系统共享库），
所以删掉 slot 后，下一轮 `sync-homes` 会把它从共享库或另一套系统里捞回来，删除
等于没删。因此删除时会往 `.shared-home/tombstones.json` 记一条墓碑，合并阶段先按
墓碑剔除；`account restore` 与用同一 uid 重新登录都会解除墓碑。

### 账号体检

`account check` 与 `list` 的账号告警都基于同一套本地判断，**不发请求、不耗额度**：

| 级别 | 判据 | 典型处理 |
|---|---|---|
| `error` | CodeArts `status != ok`；Trae 上游冷却中；凭证已过期 | 重新登录（`login <id> --force`） |
| `warn` | 3 天内到期；Trae 积分为 0；CodeArts 失败过但还能用 | 提前续期 / 换号 / 关注 |
| `unknown` | 本地没有足够信息（如 WorkBuddy 只有 access token 到期时间） | — |

CodeArts 的 `status` 是网关最近一次真实调用的结论，比到期时间可信，所以 `error`
优先于时间判断。Qoder 的 access token 过期不算故障——PAT 型凭证会自动换新的
job token（见 [02-pitfalls.md](02-pitfalls.md) P20），因此只报 `warn`。

### CodeArts 重登会多一条记录

CodeArts 的浏览器登录**每次都在账号池里新增一条**，不会更新旧账号：
网关用 `user_data` 或 `access_key` 判断「同一个账号」，而浏览器登录这条路径
两者都给不出——`user_data` 为空、`access_key` 每次都是新签发的 STS，
连 `domain_id` 也取不到，于是无从比对。

后果是反复 `login --force` 会把池子撑大：同一个人的两份凭据都在池里，轮询时
重复消耗同一份额度，其中一份坏掉还会让请求随机失败。

**怎么认出「是同一个人」**：`domain_id` 拿不到，但 `/admin/api/credits` 的
**累计用量**是稳定的——同一账号返回完全相同的 `token_used` / `total` / `used`：

```
hw000000000000000     token_used=947496598  total=7600  used=6610.75
CodeArts HSTADEMO1     token_used=947496598  total=7600  used=6610.75   ← 同一人
CodeArts HSTADEMO2     token_used=221038131  total=6600  used=2322.98   ← 另一个
```

（`resource_id` 也能用，但它藏在 `package_url` 的查询串里，而且多数时候上游
不返回套餐详情，取不到；用量字段更可靠。）

```bash
node router.mjs account merge codearts --dry-run   # 先看确认哪几条是同一人
node router.mjs account merge codearts             # 合并：默认保留桌面端那条
ROUTER_CODEARTS_KEEP=browser node router.mjs account merge codearts   # 改保留浏览器那条
```

默认保留**桌面端导入**的记录（`user_data` 有值，能跟随 IDE 自动续期）；
想留浏览器登录的那条就设 `ROUTER_CODEARTS_KEEP=browser`。

**不要**按账号名判断：浏览器登录的名字是 AccessKey 前缀（`CodeArts HSTADEMO1`），
每次登录都不同，按名字归组会误删。

| 供应商 | 账号在哪 | 切换语义 |
|---|---|---|
| WorkBuddy 国内/国际 | `~/.workbuddy2api/sessions{,-global}/<slot>.json` | 把目标 slot 复制到 `~/.codebuddy*-session.json`；运行中重启反代 |
| CodeArts | 数据文件 `accounts[]` | 只留目标账号 `enabled`；网关在跑时走 `/admin/api/accounts` 的 `toggle`，不需要重启 |
| Trae | `auths/trae-<uid>.json` + `data/state.json` | 只留目标账号 `disabled=false`；运行中重启 tw2api |
| Qoder 国内/国际 | `~/.pi/agent/auth.json` 每个区域一条 | 没有账号池，只能重新登录换号 |
| ZCode | `integrations/zcode-bridge/data/accounts.json` | 池内全部参与轮询；「切换」= 改 `default` 轮询头；增删走 bridge 自己的 `login` 命令 |
| 商汤小浣熊 | `~/.office-raccoon/agent/config/auth.json` | 单账号；IAM JWT 30 天，桌面端自动续期；换号只能在桌面端退出再登录 |
| 千问办公 | `~/.qwenworkcn/engine-maas-key.dat` | 单账号；MaaS key 2 小时，反代用 `/v1/access-tokens/exchange` 自续期；换号只能在桌面端退出再登录 |
| Loomy | `C:\Users\Public\Loomy\<hash>\userData\auth-session.json` | 单账号；换号只能在 Loomy 桌面端退出后重新登录 |

`--all` 只对 CodeArts / Trae 有意义（恢复全部账号）；WorkBuddy 的生效文件同一时刻
只能指向一个 slot，所以不支持。Qoder / Loomy / 小浣熊是单账号，也不支持。

> CodeArts 默认是**多账号轮询**，不是「当前账号」；`account codearts <账号>` 是把它
> 收敛成单账号。想恢复轮询执行 `account codearts --all`。

## 更新模型列表

上游加/删模型后，一条命令刷新所有已开启的（先备份 `opencode.json`）：

```bash
node router.mjs models            # 也可只刷某几家：models zcode loomy raccoon qwenwork
```

按来源走的分支：Qoder / Trae / CodeArts / ZCode / Loomy 直接拉 `/v1/models`；
WorkBuddy 走 `workbuddy2pi opencode install`（模型表只能来自 pi 扩展）。

**`router.mjs sync` 不刷新已有模型**：它只在 provider 不存在时写入，已存在就跳过。
ZCode 的 opencode 侧长期只有 1 个模型、Qoder 国内版还留着上游已停用的模型，
都是这个行为造成的。要刷新模型目录用 `router.mjs models`（opencode 与 pi 一起刷）。

`sync` 现在会顺手把 pi 的模型表也补齐；`--no-pi` 保留原来只同步 opencode 的语义。
pi 侧单独操作：

```bash
node router.mjs pi            # provider、模型数、扩展状态
node router.mjs pi sync       # 刷新 pi 模型表 + 部署积分/限额扩展
node router.mjs pi install --force   # 只重装扩展
node router.mjs pi install --limits  # 只装 /limits 限额扩展
```

pi 侧所有模型默认 **300k 上下文 / 32k 输出**：`scripts/lib/pi-sync.mjs` 写
`models.json` 时统一补 `contextWindow` / `maxTokens`（扩展直连的 Qoder、WorkBuddy
模型走 `modelOverrides`），`token-limits` 扩展再负责 `/limits` 覆盖、输出上限兜底和
`context - max(16k, 15%)` 的自动压缩。opencode 侧同一组默认值由
`plugins/token-limits` 的 `token-limits/overrides` 保存。

反代的 `/v1/models` 不报 `capabilities.reasoning` 时，`scripts/lib/model-caps.mjs`
按模型族补 `reasoning: true`（DeepSeek V3/V4、GLM 4.5+、Kimi K2/K3、Qwen 3.5+、
豆包 Seed 2、MiniMax M2/M3、GPT-5/6 等）；否则 pi 的 `/thinking` 只会显示 `off`。
网关的 `/v1/models` 与 `models.json` 都走同一套推断。

需要分来源手工刷新时：

```bash
node integrations/qodbuddy2pi/assets/qoder2pi opencode install
node integrations/qodbuddy2pi/assets/workbuddy2pi opencode install
node integrations/qodbuddy2pi/assets/workbuddy2pi global opencode install
node scripts/pi-models.mjs          # pi 的 Trae / CodeArts / ZCode / Loomy
```

Trae 的 provider 在用户自管的 `~/.config/opencode/opencode.jsonc` 里（带注释，router
不改它），要更新只能手工编辑；`scripts/pi-models.mjs` 只写 pi 侧。

- Qoder 代理缓存模型目录 1 小时；急着看新模型先
  `curl 'http://127.0.0.1:8789/v1/models?refresh=1'`。`router models` 不会强制刷新这个缓存，
  缓存没到期时写回的还是旧目录。
- `qoder2pi opencode install` **不会**注册开机自启（2026-11-06 起）。它只临时拉起
  代理；原来那条命令会走 `startProxy()`，在没注册服务时顺手装一个 ONLOGON 计划任务，
  刷新个模型列表就多出开机自启。要常驻请显式跑
  `node integrations/qodbuddy2pi/assets/qoder2pi proxy install-service`。
- WorkBuddy **不要**抄反代的 `/v1/models`，那是包作者的静态表。国内版读
  `~/.workbuddy/cache/acc-product-config-v*.json`；国际版没有桌面端目录时用
  `workbuddy.ts` 里的静态表，按上游 `/v3/config` 和当前账号实测维护。
- 刷新后跑 `node router.mjs list` 与 `node scripts/health.mjs --no-probe`
  对一下数量；两个客户端可用 `opencode models` / `pi --list-models` 复查。

## ZCode（Z.ai）

反代是 `integrations/zcode-bridge`（MIT，Go 标准库单二进制，端口 20131），
把 ZCode 的**套餐额度**转成 OpenAI + Anthropic 两种方言。

```bash
node router.mjs login zcode                 # OAuth 设备码，浏览器确认
node router.mjs account zcode               # 账号环；default 是轮询头
node router.mjs account add zcode --label work
node router.mjs account remove zcode <id>
node router.mjs on ... zcode                # 开关打开后写 opencode provider
```

**没套餐时也能起服务，但调用一律失败**：`/v1/models` 会返回内置静态表（6 个），
真正能调哪些模型取决于账号的套餐。先确认账号有套餐：

```bash
curl -s http://127.0.0.1:20131/v1/quota
# plans 为空 = 这个账号没有 ZCode 套餐，不是额度临时用完
```

**`/v1/models` 是「当前套餐的授权模型」，不是产品全量目录。** 有套餐时它会用
`quota.ByModel` 按 entitlement 求和（见 `server.go: liveModels`），所以清单会随套餐
变化——只剩 1 个模型往往说明当前套餐只授权了那一个（例如
`zcode-v3-start-plan-1111` 只发 `glm-5.3-flash` 的 3 亿 token），不是反代坏了。
判断方法：

```bash
curl -s http://127.0.0.1:20131/v1/quota | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.plans||[]).map(p=>p.plan_id+' -> '+(p.entitlements||[]).map(e=>(e.capabilities||[]).join('|')).join(',')).join('\n')||'无套餐')})"
```

想列出全部产品模型，看内置静态表：`curl -s http://127.0.0.1:20131/v1/models` 在有套餐时
不会显示它们——这是刻意的，列出来点中就 429。

ZCode 桌面端登录的可能不是 z.ai 而是 **bigmodel.cn（国内版）**，那是另一条产品线：
本反代只对接 `zcode.z.ai`，对 bigmodel 套餐无效。判断方法：桌面端
`~/.zcode/v2/credentials.json` 里出现 `oauth:bigmodel:*`，或日志里
`hasActiveStartPlan: false`。

ZCode 的登录**每次都会多一条账号记录**（每次拿到新 JWT），但账号 id 由 JWT 的
`user_id` 派生，所以同一个账号会覆盖更新，不会像 CodeArts 那样攒重复。JWT 不返回
`exp` 时按 24 小时处理，到期要重新 `login zcode`。

### 桌面端凭据与限时套餐

如果 `accounts.json` 为空，bridge 会依次回落到 **`plan-jwt.json`** 和 **ZCode 桌面端**凭据
（`~/.zcode/v2/credentials.json` 里的 `zcodejwttoken`）。`account zcode` 会把它们显示成
`(pinned)` / `(desktop)`，这两条都不可删除。

**固定某个账号**（桌面端换号不影响反代）：把该账号的 JWT 写进
`integrations/zcode-bridge/plan-jwt.json`：

```json
{ "jwt": "eyJhbGciOi..." }
```

它优先于桌面端凭据。`claim zcode` 也用同一份 token，所以领到的套餐不会因为桌面端
切账号而失效。

国内版 ZCode 会在**周末/夜间**放出限时 Token 套餐（`ZCODE WEEKEND BUILD` 等），
需要手动点领取。router 可以在本地自动领：

```bash
node router.mjs claim zcode --dry-run     # 只看当前有什么可领
node router.mjs claim zcode               # 领优先级最高的一个
node router.mjs claim zcode --plan <id>   # 指定活动
node router.mjs service claim install     # 每 2 小时自动领一次
node router.mjs service claim status
```

协议来自 MIT 项目 [L0NE-6/ZCode-Daily](https://github.com/L0NE-6/ZCode-Daily)：
`GET /api/v1/zcode-plan/billing/preview` 列出可领套餐，`POST /api/v1/zcode-plan/billing/claim`
提交 `{"plan_id": "..."}`，两者都要 `X-Device-Mid`。设备指纹首次生成后固定在
`integrations/zcode-bridge/data/device-mid.txt`。

已领过的活动上游回 `1003`（按成功处理），名额用完回 `1005`，所以定时任务重复跑不会
重复消耗。

## Loomy（讯飞）

反代在 `integrations/loomy2api`（本仓库自写，零依赖 Node，端口 8791）。它读 Loomy
桌面端的登录态，把 `imodel` 网关转成 OpenAI 兼容端点：

```bash
node router.mjs up loomy                 # 启动
node router.mjs login loomy              # 拉起源飞 Loomy 桌面端并等登录
node router.mjs account loomy            # 单账号信息（手机号 / 登录时间）
node router.mjs logs loomy 80            # 看日志

curl -s http://127.0.0.1:8791/health
curl -s http://127.0.0.1:8791/v1/quota   # 积分余额 + 逐模型倍率
curl -s 'http://127.0.0.1:8791/v1/models?type=chat'
```

登录态文件是
`C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>\userData\auth-session.json`，
由桌面端写入、反代只读。桌面端重新登录后不需要重启反代。

**注意：**

- `/v1/models` 里 `type=image` 的生图模型不能走 `chat/completions`；router 写
  opencode 时用 `?type=chat` 过滤，生图仍用 Loomy 客户端。
- 积分接口返回 `balance`（常驻）+ `dailyBalance`（每日）= `availableBalance`
  （当前可用），没有“总额”。`/v1/quota` 的 `balance.total` 固定为 `0`，显示端
  只报余量，不编百分比。
- 倍率写在模型展示名里（`(x0.8)` / `（x0.0）`）；没写就是未知，不猜。
- 每日积分在 Loomy 桌面端领取，反代和 `provider-credits` 插件都不自动签。
- opencode 的 `provider-credits` 插件已接入 Loomy：状态栏/侧边栏显示可用积分，
  `/credits` 里列出 5 个有倍率的对话模型（`spark-x2.6` 当前 x0.00）。

## 商汤小浣熊（Raccoon Work）

反代在 `integrations/raccoon2api`（本仓库自写，零依赖 Node，端口 8793）。
**这家上游本来就吐 OpenAI**：桌面端 box-agent 的 `config.yaml` 里写着
`provider: openai`、`api_base: https://xiaohuanxiong.com/api/web/llm/v2`，所以代理
不做任何协议转换，只补三件事——IAM 鉴权、模型目录、积分。

```bash
node router.mjs up raccoon                # 启动
node router.mjs login raccoon             # 拉起小浣熊桌面端并等它写回 token
node router.mjs account raccoon           # 单账号信息（个人版 / 组织）
node router.mjs logs raccoon 80           # 看日志

curl -s http://127.0.0.1:8793/health
curl -s http://127.0.0.1:8793/v1/quota    # 积分余额 + 逐模型倍率
curl -s http://127.0.0.1:8793/v1/models
```

登录态文件是 `~/.office-raccoon/agent/config/auth.json`：

```json
{ "access_token": "<IAM JWT>", "office_identity": "personal" }
```

旧版（OfficeV3）的 agent home 是 `~/.box-agent`，老机器上凭证在那里；代理两个都看。
桌面端重新登录后不需要重启反代。

**Linux/macOS 的路径不一样**（实测 2026-11）：桌面端把 agent home 放在 Electron 的
userData 下，也就是 `~/.config/office-raccoon/agent/config/auth.json`
（macOS 是 `~/Library/Application Support/office-raccoon/...`）。
早先代理只认 `~/.office-raccoon` 与 `~/.box-agent`，在 Linux 上装了、登了也一直报
「未登录」——现在 `authCandidates()` 会把 userData 路径排在前面，两个平台都能认。

**端点映射：**

| 本机 | 上游 |
|---|---|
| `GET /v1/models` | `GET /api/web/llm/v2/model_catalog`（9 个对话模型 + 逐模型倍率） |
| `POST /v1/chat/completions` | `POST /api/web/llm/v2/chat/completions`（原样透传，流式/工具调用都由上游处理） |
| `POST /v1/images/generations` | `POST /api/web/llm/v2/images/gen` |
| `GET /v1/quota` | `GET /api/web/points/v1/balance` + 上面的目录 |

**注意：**

- IAM token 有效期 30 天，由桌面端用 refresh 自动续期。过期时 `/health` 会写
  `user.expired: true`，`router list` 的登录态会变成「即将到期/已过期」。
- 模型清单里 `raccoon-*` 是桌面端自研模型（`visible: false`，但**能调**，且是默认
  模型），不要因为 `visible` 就剔掉。
- `sn-sensenova-6-8-flash*` 目前「限免到 11 月 30 日」，`billing_effective_multiplier`
  为 0；`/v1/quota` 会把活动名放进 `multipliers[id].labels`。
- 上游对未知模型**不报错**，会静默回落到 `raccoon-090dd3`。所以「模型 id 写错」在这
  家表现为「答得像另一个模型」，而不是 404。
- 生图走 `/v1/images/generations`，上游返回 `b64_json`，一次约 20–30 秒。
- 积分接口返回 `available_points`（可用）+ `daily_points`（每日）+ `reward_points`
  （赠送），没有总额；`/v1/quota` 的 `balance.total` 固定为 `0`。
- opencode 的 `provider-credits` 插件已接入小浣熊：首页状态栏显示
  `Raccoon 9.3k`，`/credits` 里列出 9 个模型的倍率（`sn-sensenova-6-8-flash`
  显示 `x0.00  原价 x0.50 · 限免到11月30日`），IAM token 临期时会提醒。

## 千问办公（QwenWork CN）

反代在 `integrations/qwenwork2api`（本仓库自写，零依赖 Node，端口 8794）。
**这家上游原生支持两种方言**（`/v1/chat/completions` 与 `/v1/messages`），所以代理
不做协议转换，难点全在**凭据层**。

```bash
node router.mjs up qwenwork               # 启动
node router.mjs login qwenwork            # 拉起桌面端（登录后要发一句话才签发 key）
node router.mjs account qwenwork          # 单账号信息（昵称 / 套餐 / 凭据条数）
node router.mjs logs qwenwork 80          # 看日志

curl -s http://127.0.0.1:8794/health
curl -s http://127.0.0.1:8794/v1/quota    # 逐模式倍率 + 限时折扣
curl -s http://127.0.0.1:8794/v1/models
```

**凭据链条**（这是这家唯一特殊的地方）：

```
%APPDATA%/QwenWorkCN/Local State → os_crypt.encrypted_key（DPAPI 保护）
  └─ DPAPI Unprotect（当前用户）→ 32 字节主密钥
       └─ AES-256-GCM 解 ~/.qwenworkcn/engine-maas-key.dat（"v10" + nonce + 密文 + tag）
            └─ {"credentials":{"<sessionId>":{"accessKey":"sk-mm-v1.…","baseUrl":"https://api9.qwenwork.cn/v1"}}}
```

`auth.dat` / `auth-v2.dat` 是宿主登录态，加密绑定本机身份，**反代刻意不去解它**。

**自续期**：桌面端签的 key 只有 2 小时，反代用官方通道自己续：

```bash
POST https://api9.qwenwork.cn/v1/access-tokens/exchange  {"ttl_ms": 7200000}
→ {"access_token":"sk-mm-v1.…","expires_at":<ms>}
```

启动跑一次，之后每 10 分钟检查、剩余不足 30 分钟就换。所以**桌面端关掉后代理仍能跑**。
但**过期后无法自续**：exchange 需要有效 key。代理停超过 2 小时就得重启桌面端重新签发，
反代下一次请求会自动读到，不用重启。

**注意：**

- **只登录不对话时没有 key**：桌面端在首次推理请求时才写 `engine-maas-key.dat`。
  `router account qwenwork` 会显示「尚未签发推理凭据」，去桌面端随便发一句即可。
- **额度拿不到是设计选择**：余额在 `gateway.qwenwork.cn/api/v1/adapter/user/wallets`，
  要宿主 JWT；反代不解 `auth-v2.dat`，所以 `/v1/quota` 的 `balance` 为 `null`，
  `quotaNote` 写明原因。**倍率是完整的**（来自模型目录的 `price_factor` + 限时折扣）。
- **模型目录来自日志**：`chat-modes-v2/*.lkg` 是加密的，但桌面端把整个目录明文打进
  `logs/<日期>/main.log`，反代从那里取最后一条。`/health` 的 `catalog.source` 会写明来源。
- **换用户/换机器解不开**：OSCrypt 主密钥由当前用户的 DPAPI 保护，需要重新登录桌面端。
- **上游 401 会自动重读凭据重试一次**：桌面端刚轮换 key 时通常就恢复了。

## 百度搭子（DuMate）

反代在 `integrations/dumate2api`（本仓库自写，零依赖 Node，端口 8795）。
**这家上游免鉴权**：桌面端的 `dumate-main-server.exe` 暴露
`/api/qianfanproxy/v1/chat/completions`，鉴权在桌面端进程内部完成。代理只做三件事——
发现随机端口、读模型目录、透传。

```bash
node router.mjs up dumate                # 启动
node router.mjs login dumate             # 拉起 DuMate 桌面端并等登录
node router.mjs account dumate           # 单账号信息（昵称 / 登录方式 / 登录时间）
node router.mjs logs dumate 80           # 看日志

curl -s http://127.0.0.1:8795/health
curl -s http://127.0.0.1:8795/v1/quota    # 积分余额 + 积分包明细
curl -s http://127.0.0.1:8795/v1/models
```

登录态文件是 `%APPDATA%\qianfan-desktop-app\auth.json`：

```json
{ "activeProfileId": "…", "accountProfiles": [{ "displayName": "…", "bceUserId": "…", "loginType": "bce" }] }
```

**端口每次启动随机**，反代按 `DUMATE_MAIN_PORT` → `electron.log` → `Main.log` →
进程命令行 的顺序发现，缓存 5 秒；连不上时强制重新发现并重试一次，所以桌面端重启后
反代不用重启。

**注意：**

- **没有上游模型清单**：`/api/qianfanproxy/v1/models` 是 404。模型目录读桌面端落盘的
  `qianfan_desk_xdg/<账号>/config/opencode/opencode.json` 的
  `provider.QianfanPersonalQuota.models`，剔掉 `llm-mock` / `dumate-image*` /
  `qianfan-ocr` / `qwen3-embedding*` / `qwen3-reranker*` / `model-*`，保留
  `dm-auto-model/*`。当前 23 个。
- **额度接口要两个头**：`X-Dumate-Inapp-Key`（只在 `log\electron.log` 的
  `DUMATE_INAPP_KEY: '<64 hex>'` 里，每次启动都换）+ `X-Dumate-Account-Id`
  （`auth.json` 的 `bceUserId`）。上游 401/403 时反代会重读 key 再试一次。
- **日志会增长，查找不能只看末尾**：端口与 key 都写在启动时，跑久了会被挤出
  「末尾 N 字节」窗口。反代按 末尾 1MB → 开头 1MB → 整份（≤64MB）三级查找。
  只读末尾会让 `/v1/quota` 间歇性 501。
- **有真实总额**：`totalPoints - usedPoints`，所以 credits 插件能画进度条；
  订阅套餐 / 登录奖励 / 活动赠送分包列出，各带到期时间。
- **没有逐模型倍率**：`multipliers` 是空对象，显示端报「上游没有公开倍率」，不猜。
- **reasoning_content 原样透传**：短 `max_tokens` 可能全花在思考上，表现为
  「空回复 + finish_reason=length」，不是故障。
- opencode 的 `provider-credits` 插件已接入百度搭子：状态栏显示 `DuMate 10.3k`，
  `/credits` 里列出三个积分包与最近到期时间。

## WPS 灵犀

反代在 `integrations/lingxi2api`（本仓库自写，零依赖 Node，端口 8796）。
**对话 + 积分都接**：灵犀是 Electron + Go app-server 的 agent 形态，云端没有可直达的
OpenAI 兼容入口，所以反代自己 spawn 一个官方 `lingxi.exe --stdin`（JSON-RPC over
stdio），用桌面端 cookie 库里的 `wps_sid` 鉴权，把 OpenAI 的 `/v1/models` 与
`/v1/chat/completions` 翻译成 `initialize → session/start → run/start → 收集事件`。
协议细节与逆向依据见 [integrations/lingxi2api/README.md](../integrations/lingxi2api/README.md)。

**能力边界**：灵犀是完整 agent（自己联网搜索、跑工具循环），**不吐 OpenAI
tool_calls**——传 `tools` 它只会返回最终文本。模型标 `tool_call:false`，适合对话，
不适合当 opencode/pi 的编码 agent 驱动。多轮、system、流式都正常。

```bash
node router.mjs up lingxi             # 启动（对话 + 积分）
node router.mjs login lingxi          # 确认桌面端已安装
node router.mjs logs lingxi 80        # 看日志

curl -s http://127.0.0.1:8796/health
curl -s http://127.0.0.1:8796/v1/models
curl -s http://127.0.0.1:8796/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
curl -s http://127.0.0.1:8796/v1/quota    # 智点余额 + 每个积分包
curl -s 'http://127.0.0.1:8796/v1/usage?limit=10'   # 收支明细
```

**凭据链条**（这家唯一特殊的地方）：SID **不在** `app-server-data/auth.json`
（那份是 `auth_storage=runtime`，落盘为空），而在 Electron 的 cookie 库：

```
%APPDATA%/WPS 灵犀/Local State → os_crypt.encrypted_key（DPAPI 保护）
  └─ DPAPI Unprotect → 32 字节主密钥
       └─ AES-256-GCM 解 Partitions/lingxi-passport-v2-<hash>/Network/Cookies
          的 wps_sid（明文前有 32 字节 SHA256(host) 前缀，要去掉）
```

`auth-binding-key.v1` 只用于认证快照的 HMAC 绑定，不是快照密钥，别拿它去解
`auth-snapshot.json`。反代缓存 SID 2 分钟；上游 401 时强制重读再试一次。

**注意：**

- **积分端点只读**：`/v1/quota`、`/v1/usage` 只支持 GET；不签到、不改账号。
  对话走 `/v1/chat/completions`，会真实消耗智点。
- **有真实总额**：`bonus_summary.total_value + purchased_summary.total_value` 当分母，
  能画进度条；`buckets` 按到期时间排序，快过期的排前面。
- **没有逐模型倍率**：`multipliers` 是空对象，显示端报「上游没有公开倍率」。
- **pro 模式部分账号不可用**（实测报 Unavailable）；`deepseek-v4.1-flash` 最稳，
  体检试打用它。
- **智点在桌面端做任务领取**，反代与 credits 插件都只读。
- opencode/pi 的 credits 插件已接入灵犀：显示 `Lingxi 1897/1900 100%`，
  列出 4 个赠送智点包与最近到期时间。

## 有道龙虾（LobsterAI）

反代在 `integrations/lobsterai2api`（本仓库自写，零依赖 Node，端口 8797）。
桌面端本身已经有一条本地模型代理：Electron 主进程在随机端口（当前 58375）上起
`tokenProxy`，把 `/v1/chat/completions` 转发到
`https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions`，并负责 access
token 刷新与用量上报。所以反代**优先复用它**，桌面端退出后才用 SQLite 里的
access token 直连上游。

```bash
node router.mjs up lobster            # 启动（对话 + 积分 + 签到）
node router.mjs login lobster         # 打开 LobsterAI 桌面端登录
node router.mjs logs lobster 80       # 看日志

curl -s http://127.0.0.1:8797/health
curl -s http://127.0.0.1:8797/v1/models
curl -s http://127.0.0.1:8797/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
curl -s http://127.0.0.1:8797/v1/quota     # 积分包 + 签到状态 + 逐模型倍率
curl -s -X POST http://127.0.0.1:8797/v1/checkin   # 签到（今天已签会回「今日已签到」）
```

**登录态**：`%APPDATA%\LobsterAI\lobsterai.sqlite` 的 `kv.auth_tokens` /
`kv.auth_user`，由桌面端写入。反代只读，不写回；refresh 只在内存里发生。读 SQLite
用 Node 22.5+ 的 `node:sqlite`，没有它时对话仍可用（桌面端代理在跑时），但
`/v1/quota` 会明确报「读不到凭据」。

**桌面端代理**：端口与入站 token 在 `openclaw/loopback-state.json` 的
`ports.tokenProxy` / `proxyToken`。这个端口**每次启动可能变**，反代每次请求前重读；
连不上就落回直连上游。

**积分**：`/api/subscription` 给积分包（`boostCreditsRemaining`，含新订阅活动、
每日登录奖励）、套餐月度额度与奖励额度。反代把「本轮积分包总量 + 月度上限 + 奖励上限」
记为 `total`，试用额度不重复相加。签到状态来自活动接口
`/api/client-activities/slot` → `/<activity>/context`，今天已签时 `claimed:true`。

**倍率**：`/api/models/available` 的 `costMultiplier`，分时计价与限时免费已经算进
`effective`；`limitedFreeActive` 为真时显示 `x0.00 · 限时免费`。

**注意：**

- `yd-fast` / `yd-ultra` 是桌面端的虚拟档位，不是上游真实模型 id；反代转发前会先调
  `/api/models/<id>/resolve` 换真实模型，解析失败直接报错。
- 上游当前对 `/v1/chat/completions` **总是回 SSE**（即使 `stream:false`），与桌面端
  行为一致；编码 agent 都走流式，不受影响。
- 签到会真实领取积分，`/v1/checkin` 只在 credits 插件明确 `checkin:true` 时被调用；
  该接口幂等，重复调用返回「今日已签到」。
- opencode/pi 的 credits 插件已接入：显示 `Lobster 1099.97/1100 100%`，列出两个
  积分包（新订阅活动 / 每日登录奖励）与签到状态。

## Qoder

```bash
qoder2pi status                 # pi、扩展、两个区域、opencode 代理
qoder2pi login cn pt-xxxxxx     # 国内版（PAT）
node router.mjs login qoder   # 国际版：浏览器 OAuth（推荐）
qoder2pi logout cn              # 退出（auth.json 先备份）
qoder2pi models                 # 两个区域各自在 pi 里可见的模型

# 代理启停统一用 router（qoder2pi proxy 仍可用于看状态/兼容旧习惯）
node router.mjs up qoder-cn
node router.mjs restart qoder
node router.mjs down qoder-cn
node router.mjs logs qoder-cn 50

qoder2pi opencode status
qoder2pi opencode uninstall     # 兼容旧命令；日常用 router sync

qoder2pi credits                # 余额与签到
qoder2pi credits checkin
```

pi 里同一份数据换成交互入口：`node router.mjs pi sync` 部署
`~/.pi/agent/extensions/qodbuddy2pi/` 后，`/credits` 打表、`/credits checkin` 签到，
状态栏显示当前 provider 的余额与当前模型倍率；模型也能通过 `credits` 工具查询。

`/limits` 是另一个扩展（`~/.pi/agent/extensions/token-limits/`）：默认所有模型
300k / 32k，`/limits 200k 16k` 改当前模型，`/limits provider` / `all` 批量改，
阈值 255k 自动压缩。opencode 侧同名命令与默认值见根 README 的「上下文与输出限额」。

国内版**不支持**设备授权（只支持 PAT）；国际版两者都支持。router 的 `login qoder`
直接实现了国际版的 PKCE + deviceToken 轮询，成功后写回 `~/.pi/agent/auth.json`。

## WorkBuddy

```bash
workbuddy2pi status             # 服务、端点、凭证、账号
workbuddy2pi logs 100           # 反代自己的日志尾部（router logs 也行）
node router.mjs login workbuddy          # 浏览器登录并建档
node router.mjs login workbuddy-global   # 国际版
workbuddy2pi account renew      # 续期当前账号
workbuddy2pi opencode install   # 只写 opencode 配置，不会重启反代

# 查/切账号统一用 router（会直接重启反代，不依赖计划任务）
node router.mjs account workbuddy
node router.mjs account workbuddy <key>

# 启停统一用 router
node router.mjs up workbuddy
node router.mjs restart workbuddy
node router.mjs down workbuddy

workbuddy2pi global <命令>       # 同上，作用于国际版
```

> `workbuddy2pi account <key>` 仍可用，但它的重启依赖计划任务；router 的
> `account` 会先保存当前凭证再复制 slot，然后直接走 `doRestart`，更可控。

## 在 Linux 上装各家桌面端（登录态来源）

反代需要的不是「应用能跑」，而是**桌面端登录后写下的那份凭证**。所以每家先看官方
有没有 Linux 包；没有的话，登录这一步在本机就做不到，反代只能报「未登录」。

实测环境：CachyOS（Arch 系），有 `yay` / `pacman` / `flatpak`，**没有** AppImage
运行器（`appimagetool` / `gearlever` 都没装）。

| 来源 | AUR | Flatpak | 官方 Linux 包 | 结论 |
|---|---|---|---|---|
| **商汤小浣熊** `raccoon` | ❌ 无（AUR 的 `raccoon*` 是别的软件：Google Play 客户端、Python 库） | ❌ 无 | ✅ **有 .deb**（x64 / arm64） | 能装，见下 |
| **WPS 灵犀** `lingxi` | ⚠️ `lingxi-ai-bin` 是 **WPS 插件**（文小舟），不是灵犀桌面端 | ❌ 无 | ❌ 官网只给 Win/macOS | ✅ **用 Wine 跑 Windows 版** |
| **有道龙虾** `lobster` | ❌ 无（`lobster*` 是别的软件） | ❌ 无 | ❌ 官方 89 个历史版本只有 `windowsX64` / `macIntel` / `macArm` | ✅ **用 Wine 跑 Windows 版** |
| Loomy `loomy` | — | — | — | 用户说跳过 |

> 灵犀的 `lingxi-ai-bin` 容易误认：它的描述写着「WPS Office AI Agent 插件（文小舟，
> 原灵犀AI）」，装完是 `/opt/lingxi-ai/plugin/`（WPS 加载项）＋ 一个 **Windows PE**
> 的 `lingxi-launcher.exe`。而反代要的是 `app_server_link/service/lingxi.exe`
> 这个 Go app-server。两者不是一回事，装了也不能让 `lingxi` provider 工作。

### WPS 灵犀 / 有道龙虾：Wine 跑 Windows 版（实测可行）

两家都没有 Linux 包，但都能在 Wine 里跑起来。关键是**只把 Wine 用在必要的地方**：

```
桌面端 GUI（Wine，只为登录一次）→ 写 cookie/aqlite 到 Wine prefix
                                        ↓
反代（原生 Node，常驻）→ 读 prefix 里的凭证 → 在 Wine 里 headless 拉起 app-server
```

GUI 只在**登录那一次**需要（卡顿可以忍）；日常是 headless 的 app-server 在跑，
没有界面就没有渲染开销。

#### 1. 装 Wine（yay，需要 sudo）

```bash
yay -S --needed wine-staging wine-gecko wine-mono
```

用 `wine-staging` 而不是 flatpak：flatpak 沙箱会隔离宿主路径和环境变量，
反代要 spawn prefix 里的 exe、又要读宿主侧的文件，隔一层很难受。

#### 2. 准备 prefix、字体、DXVK

```bash
bash scripts/wine-setup.sh                 # 建 prefix + 灌字体 + 修 FontLink + 自检
```

这一步解决三个实测踩到的问题：

| 问题 | 真因 | 修法 |
|---|---|---|
| 中文全是方框 | Windows Server 默认不装中文字体 | 从 Windows 分区的 `Windows/Fonts` 复制 250+ 个字体进来 |
| 部分字符方框/断链 | Wine 预置 FontLink 引用了 `Meiryo` / `MS Mincho` / `Batang`（Server 版没有） | 改指向 `Noto Sans/Serif CJK`，脚本里做 |
| **字体割裂**（一行里混几种字形） | 应用 CSS 写死 `font-family: PingFang SC`（**无回退栈**），Linux 没这个族 → Chromium 逐字回退 | `scripts/font-alias.mjs` 造同名族（`PingFang SC` / `MiSans`），Chromium 直接命中原族名 |

装 DXVK（D3D→Vulkan，显著改善卡顿；**Intel 核显 + `lib32-vulkan-intel` 即可**）：

```bash
# 不用 root：解包到 prefix 的 system32/syswow64，再设 DLL override
curl -L -o dxvk.tar.gz https://github.com/doitsujin/dxvk/releases/download/v3.1.1/dxvk-3.1.1.tar.gz
tar -xzf dxvk.tar.gz
cp dxvk/x64/*.dll "$WINEPREFIX/drive_c/windows/system32/"
cp dxvk/x32/*.dll "$WINEPREFIX/drive_c/windows/syswow64/"
for d in d3d8 d3d9 d3d10core d3d11 dxgi; do
  wine reg add 'HKCU\Software\Wine\DllOverrides' /v $d /d native /f
done
```

#### 3. 启动桌面端登录

```bash
bash scripts/wine-run-lingxi.sh
```

脚本里固定了这几项，每一项都对应一个实测的坑：

- `WINEDEBUG=-all` —— Electron 会打几万行 fixme，字符串格式化本身就有开销
- **NTSync**（不设 `WINEESYNC`/`WINEFSYNC`）—— 见下面「按社区最佳实践调优」
- `--disable-direct-composition` —— **不加会直接崩**：Chromium 用 DirectComposition
  建交换链，而 DXVK 没实现 `CreateSwapChainForComposition`，
  日志里是 `DxgiFactory::CreateSwapChainForComposition: Not implemented`
- `FREETYPE_PROPERTIES=truetype:interpreter-version=35` —— 字更锐利（ArchWiki）
- `DXVK_CONFIG_FILE` 指向调优过的 `dxvk.conf`

### 按社区最佳实践调优（`scripts/wine-tune.sh`）

依据：ArchWiki/Wine（NTSync、CSMT、DXVK、字体平滑）、DXVK 仓库的 `dxvk.conf` 与
`wiki/Configuration`。每条都不是凭感觉加的：

| 项 | 设置 | 为什么 |
|---|---|---|
| **同步原语** | **用 NTSync，不设 `WINEESYNC`/`WINEFSYNC`** | ArchWiki 明确写 ESync/FSync 是 NTSync 之前的变通方案，Wine 官方不打算保留；Wine 10.16+ 默认启用 NTSync，内核 6.14+ 提供 `/dev/ntsync`。三者**互斥**，同时设只会把 NTSync 关掉。验证：`ls -l /proc/<pid>/fd \| grep ntsync` |
| CSMT | `1`（默认） | Wine 3.2 起默认开，把 GL 调用放独立线程；仅 wined3d 回退路径用得到 |
| ClearType | `FontSmoothing=2 / Type=2 / Orientation=1 / Gamma=1400` | ArchWiki「Enable font smoothing」：Wine 默认关平滑，字会发虚发灰 |
| DPI | `LogPixels=96` | 面板 1920x1200 @ scale 1，写死免得被自动探测带偏 |
| 崩溃弹窗 | `WineDbg\ShowCrashDialog=0` | Wine 自带 Win32 崩溃窗会盖掉应用自己的错误页 |
| winemenubuilder | 禁用 | 每次 wineboot 都会跑，往宿主菜单写 `.desktop`；无 X 场景还会报错拖慢启动 |
| `dxvk.enableGraphicsPipelineLibrary` | `Auto` | 把 D3D11 管线编译拆成可缓存阶段（Intel ANV 支持），降低首次打开界面的卡顿 |
| `d3d11.relaxedBarriers` | `True` | Intel 上省同步开销；UI 场景不会出现游戏里的渲染错误 |
| `dxgi.syncInterval=1` / `dxvk.tearFree=True` | — | 桌面 UI 有撕裂很显眼 |
| `dxvk.enableMemoryDefrag` | `False` | UI 分配模式稳定，关掉省 CPU |

`scripts/wine-tune.sh` 会自动判断有没有 `/dev/ntsync`：有就走 NTSync，没有才退回
`WINEFSYNC=1`。启动脚本同样如此，保证「只启用一种同步实现」。

> 实测确认 DXVK 真的接管（不是只把 DLL 拷进去）：
> ```
> info:  DXVK: v3.1.1
> info:  Found config file: .../wineprefixes/lingxi/dxvk.conf
> info:  Found device: Intel(R) Graphics (RPL-P) (Intel open-source Mesa driver 26.2.6)
> ```
> 注意 `DXVK_HUD` 只用于确认接管——它会强制持续重绘，**日常别开**。

#### 页面「糊屏/白屏」但按钮能点（最容易误判的一个坑）

症状：窗口出来了，背景（模糊壁纸）也在，但正文/卡片不绘制；鼠标移上去**按钮仍有
hover 和点击响应**。

命中测试走的是渲染树（layout tree），它已经建好了，所以「能点」不代表「画出来了」。
真正卡住的是**最终呈现**这一步。

关键证据：GPU 合成模式下用 CDP 抓渲染器截图（`Page.captureScreenshot`）能拿到**完整
正确的 UI**，但窗口本身是灰/黑（`niri screenshot-window`）。说明：

- 渲染器、光栅、合成帧都是对的；
- 坏在最后一步——SwapChain 把合成帧呈现到 Wine 窗口。

修法（灵犀）：加 `--disable-gpu-compositing`，把显示合成退回软件路径。

> 已排除的路径（全部实测失败，避免以后重复踩）：
> - DXVK vs wined3d（`WINEDLLOVERRIDES=d3d11,dxgi=b`）→ 都灰屏
> - `--use-angle=vulkan`、`--use-angle=gl` → 前者灰屏，后者窗口建不出来
> - CPU 光栅（`--disable-gpu-rasterization`）→ 灰屏且合成器几乎停摆
> - 窗口样式：`titleBarStyle:"hidden"` / 透明 `titleBarOverlay` / `roundedCorners`
>   → 改了还是灰屏（已还原 asar）
> - `--disable-gpu-memory-buffer-compositor-resources` → 灰屏
> - Wine Wayland 驱动（`--wayland`）→ Electron 直接崩（exit 3）
>
> 所以灵犀最终用 `--disable-direct-composition --disable-gpu-compositing`。

#### 帧率：两家必须用不同的合成路径

用 CDP 注入「全屏模糊层逐帧移动」做压力测试（比真实 UI 更重），实测：

| 配置 | 灵犀 | 龙虾 |
|---|---|---|
| GPU 合成 | 灰屏（不可用） | **≈55fps** |
| 软件合成 | **≈50fps** | ≈13fps |

所以默认值按 app 分开：

- **龙虾**：`--disable-direct-composition`，保留 GPU 合成 → 从 13fps 提到 55fps
- **灵犀**：再加 `--disable-gpu-compositing` → 唯一能正常显示的路径，50-60fps

`scripts/wine-run-app.sh` 里用 `if [ "$APP" = "lingxi" ]` 区分；`--gpu-compositing-on/off`
留作诊断开关。不要为了「统一参数」把龙虾也降到软件合成。

> 补充：灵犀软件合成下把光栅线程提到 8（`--num-raster-threads=8`）反而略差
> （46fps），默认 4 就好；强制 `--enable-gpu-rasterization` 也无变化。

登录后 cookie 落在
`$WINEPREFIX/drive_c/users/<user>/AppData/Roaming/WPS 灵犀/Partitions/*/Network/Cookies`。

#### 4. 反代侧怎么读这份凭证

`Local State` 里的 cookie 主密钥是 **DPAPI 加密**的，而 Wine 自带的 `powershell.exe`
是个空壳（`fixme:powershell:wmain stub`），原来那套 `ProtectedData.Unprotect` 用不了。

解法是仓库里带了一个交叉编译的小 PE（`integrations/lingxi2api/tools/windows-dpapi.exe`，
源码在同目录 `.go`）：在**同一个 prefix** 里跑 `wine windows-dpapi.exe "<Local State>"`
→ `CryptUnprotectData` → 拿到 32 字节主密钥 → 反代用 AES-GCM 解 cookie。

```
反代启动
  ├─ appDataRoot() 自动识别 Wine prefix 里的 AppData\Roaming\WPS 灵犀
  ├─ windowsMasterKey() 在 Linux 上改走 wine + windows-dpapi.exe
  ├─ locateAppServer() 认 app_server_link/ 与 app_server_<版本>/ 两种布局
  └─ spawn: wine <lingxi.exe> --stdin --auth-storage=runtime --data-dir <Windows 路径>
```

> 为什么 `locateAppServer()` 要看两种布局：Windows 上桌面端建的是符号链接
> `app_server_link → app_server_6.1.0`；Wine 里符号链接常建不成，只留下一个空的
> `app_server_link` 和真实的 `app_server_6.1.0` 目录。只认前者会报「找不到 app-server」。

实测结果（CachyOS + Intel 核显）：

```
GET  /v1/models            → 13 个模型（pro / max / deepseek-v4.1-flash / GLM-5.3 …）
POST /v1/chat/completions  → {"model":"deepseek-v4.1-flash"} → "通了"
GET  /v1/quota             → 智点余额
```

#### 有道龙虾

同理，但比灵犀简单：它**不需要 spawn 任何 exe**，反代只读两样东西——

- `$WINEPREFIX/drive_c/users/<user>/AppData/Roaming/LobsterAI/lobsterai.sqlite`（登录态）
- 同目录的 `openclaw/loopback-state.json`（桌面端 tokenProxy 的端口与 token）

Wine 和宿主共享网络命名空间，所以 tokenProxy 的 `127.0.0.1:<port>` 直接可用。
`integrations/wine-paths.js` 会自动把这两条路径喂给反代。

##### 安装时的一个坑：`win-resources.tar` 解不开

龙虾的安装器最后一步要解 `resources/win-resources.tar`（36630 个条目），
它先找系统 `tar`，找不到就退回内置提取器；Wine 里两者都不成：

```
phase=system-tool-resolved tool=tar status=helper-not-found
phase=tar-extract-error reason=runtime-entry-missing-after-extract
phase=tar-extract-failed-archive-preserved action=abort-install
```

安装器退出码 3，但**文件其实都装好了**。直接在 Linux 侧补解一次即可：

```bash
cd "$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/LobsterAI/resources"
tar -xf win-resources.tar
```

##### 启动时的一个坑：Wine 的 chmod 对 SQLite `-shm` 必返回 EBUSY

症状是主界面能出来，但弹「AI 引擎网关启动失败」：

```
Config health-state write failed: EBUSY: resource busy or locked,
  chmod 'C:\...\openclaw\state\state\openclaw.sqlite-shm'
[openclaw] Could not start the CLI.
[openclaw] Reason: EBUSY: ...
```

**这是 Wine 的通用缺陷，不是龙虾的 bug**，而且能精确复现（用 Wine 里的
Windows 版 node 打开 WAL 模式的库，再 chmod `-shm`，必报 EBUSY）：

```
chmod -shm FAIL: EBUSY      ← 不加载 shim
chmod -shm ok               ← 加载 scripts/wine-node-shim.js
```

成因链：Node 的 `fs.chmod` → `SetFileAttributes` → Wine → `chmod(2)`；
`-shm` 是 SQLite 的共享内存文件，已被 mmap，Wine 这里返回 EBUSY。
而 openclaw 在「打开数据库 → 收紧权限 0600」这步直接把异常抛上去，导致启动失败。

修法有两层，缺一不可：

**第一层：吞掉 EBUSY**（`scripts/wine-node-shim.js`）。把**只针对 EBUSY** 的
chmod 降级为无操作。可以安全忽略，因为 Wine 下权限位本来就不生效（实测 chmod
0600 之后仍是 0666），而且只吞 EBUSY，别的错误照常抛。

**第二层：在「链接之前」打补丁**。这一步才是真正的难点，两个坑：

1. `NODE_OPTIONS` 对龙虾**无效**。它用 Electron 的 `ELECTRON_RUN_AS_NODE`
   模式跑网关，而 Electron 会忽略 `NODE_OPTIONS`（实测 `process.execArgv`
   里根本没有 `--require`）。
2. 等应用起来再 `fs.chmod = ...` 也无效。ESM 的具名导入
   （`import { chmodSync } from 'node:fs'`）在模块链接时就固定了函数引用，
   运行时改写模块对象不会影响已链接的绑定（实测无效）。

所以用 `scripts/wine-patch-openclaw.mjs` 做「wrapper 入口 + 动态 import」：

```
gateway-bundle.mjs       ← 1.2K wrapper：先打 chmod 补丁
gateway-bundle.impl.mjs  ← 原 31M bundle（改名保留）
```

wrapper 先补丁、再 `await import()` 原 bundle。动态 import 发生在补丁**之后**，
新模块链接时拿到的就是打过补丁的函数（实测有效）。

还有一个隐蔽的坑：launcher 在 import 前会把 `process.argv[1]` 设成
`gateway-bundle.mjs`，而原 bundle 是**靠 `argv[1]` 与 `import.meta.url` 比对
来判断「自己是不是主入口」**的。如果 wrapper 只是简单 `import('./impl.mjs')`，
模块会加载成功、但 CLI 主体不启动——日志停在 `import ok` 后再无输出、端口也不监听。
所以 wrapper 必须先把 `argv[1]` 指回 impl：

```js
const impl = new URL('./gateway-bundle.impl.mjs', import.meta.url);
process.argv[1] = fileURLToPath(impl);
await import(impl.href);
```

两个健康信号：

```
bundle size=0.0MB        ← wrapper 生效（原 bundle 是 30.4MB）
[gateway] ready          ← 网关真正启动（此后 18789 端口监听）
```

重装龙虾会覆盖补丁，重跑 `node scripts/wine-patch-openclaw.mjs --force` 即可。

### 商汤小浣熊（有原生 .deb）

官方直链（`platform` 只认 `linux-x64` / `linux-arm64`）：

```bash
curl -L -o raccoon.deb \
  "https://www.xiaohuanxiong.com/download/catalog?platform=linux-x64"

# 系统级（需要 sudo）
sudo pacman -U ./raccoon.deb      # 里面就是个 Electron 树，postinst 建 /usr/bin/raccoon-ai

# 用户级（没有 sudo 时，实测可行）
ar x raccoon.deb && tar -xJf data.tar.xz
cp -a "opt/商汤小浣熊" ~/.local/opt/raccoon-ai
ln -sf ~/.local/opt/raccoon-ai/raccoon-ai ~/.local/bin/raccoon-ai
# 再写 ~/.local/share/applications/raccoon-ai.desktop（Exec 指向上面的路径）
```

装完启动一次、在窗口里登录，**token 就会落到**
`~/.config/office-raccoon/agent/config/auth.json`。反代读的是这个文件，登录后
`restart raccoon` 即可生效（不需要一直开着桌面端——实测关掉 GUI 后
`/v1/quota` 仍返回真实余额）。

`debtap` / `alien` 本机都没装，`yay -S debtap` 要 sudo 密码；上面「解包 + 放
`~/.local/opt`」这条路不需要 root，效果一样。

### Wine 相关的目录与脚本

| 路径 | 用途 |
|---|---|
| `~/.local/share/wineprefixes/lingxi` | 专用 prefix（字体、DXVK、两家桌面端与登录态都在这里） |
| `scripts/wine-setup.sh` | 一键建 prefix + 灌字体 + 修 FontLink + 自检 |
| `scripts/wine-tune.sh` | 按社区最佳实践调优 prefix（NTSync/字体平滑/DXVK 配置） |
| `scripts/wine-run-app.sh` | 通用启动器：`lingxi` / `lobster`，含性能与渲染参数 |
| `scripts/wine-install-menu.sh` | 把两家写进应用菜单（.desktop + hicolor 图标，可重复执行） |
| `scripts/patch-asar.mjs` | 在 Electron `app.asar` 里做**等长原地替换**（诊断用；必须按字节偏移） |
| `scripts/wine-run-lingxi.sh` | 兼容入口，等价于 `wine-run-app.sh lingxi` |
| `scripts/wine-patch-openclaw.mjs` | 给龙虾的 openclaw 网关打 chmod-EBUSY 补丁 |
| `scripts/wine-node-shim.js` | Wine 下 Node 的 chmod 补丁（EBUSY → 无操作） |
| `scripts/font-alias.mjs` | 造 `PingFang SC` / `MiSans` 同名族，修字体割裂 |
| `scripts/fonts-register.mjs` / `fontlink-fix.mjs` / `fontlink-check.mjs` / `fonts-verify.mjs` | 字体注册、回退链修补、校验 |
| `integrations/wine-paths.js` | 反代/router/health 共用：在 prefix 里找各家的 AppData |
| `integrations/lingxi2api/tools/windows-dpapi.exe` | Wine 里解 DPAPI（+ 同名 `.go` 源码） |

官方直链（`platform` 只认 `linux-x64` / `linux-arm64`）：

```bash
curl -L -o raccoon.deb \
  "https://www.xiaohuanxiong.com/download/catalog?platform=linux-x64"

# 系统级（需要 sudo）
sudo pacman -U ./raccoon.deb      # 里面就是个 Electron 树，postinst 建 /usr/bin/raccoon-ai

# 用户级（没有 sudo 时，实测可行）
ar x raccoon.deb && tar -xJf data.tar.xz
cp -a "opt/商汤小浣熊" ~/.local/opt/raccoon-ai
ln -sf ~/.local/opt/raccoon-ai/raccoon-ai ~/.local/bin/raccoon-ai
# 再写 ~/.local/share/applications/raccoon-ai.desktop（Exec 指向上面的路径）
```

装完启动一次、在窗口里登录，**token 就会落到**
`~/.config/office-raccoon/agent/config/auth.json`。反代读的是这个文件，登录后
`restart raccoon` 即可生效（不需要一直开着桌面端——实测关掉 GUI 后
`/v1/quota` 仍返回真实余额）。

`debtap` / `alien` 本机都没装，`yay -S debtap` 要 sudo 密码；上面「解包 + 放
`~/.local/opt`」这条路不需要 root，效果一样。

### 另外两家为什么装不了

- **有道龙虾**：官网版本历史（`api-overmind.youdao.com/.../lobsterai/prod/client-version-history`）
  89 条记录里，平台字段只有 `windowsX64` / `macIntel` / `macArm`，没有任何 Linux 包；
  页面文案里的「Linux」只出现在「Alpine Linux 沙箱」和更新日志的「Linux 端打包优化」。
- **WPS 灵犀**：下载页的 URL 模板写死在 JS 里，只有
  `win/...-setup.exe`、`mac/...-arm64.dmg`、`mac/...-x64.dmg` 三种；
  试过 `linux/...deb`、`...AppImage` 全是 404。反代又必须 spawn 那个 Go app-server，
  所以本机无解。

## 升级反代 wheel 的完整流程

wheel 版本影响服务端能否接受请求（见 `02-pitfalls.md` P1），升级步骤固定三步：

```bash
# 1. 放进 integrations 的 vendor 目录（旧版本删掉，避免服务选错）
cp workbuddy2api-X.Y.Z-py3-none-any.whl integrations/qodbuddy2pi/assets/vendor/
rm -f integrations/qodbuddy2pi/assets/vendor/workbuddy2api-<旧版>.whl

# 2. 重启反代：router 每次启动都会重新扫描 integrations 里最新的 wheel
node router.mjs restart workbuddy workbuddy-global

# 3. 验证「进程加载的是新版本」，而不是「磁盘上是新版本」
node router.mjs logs workbuddy 40
node scripts/health.mjs
```

> 旧流程里的 `workbuddy2pi install-service` 会生成一个 `.cmd` 计划任务。router 直管后
> 不需要它；如果旧任务还在，router 启动前会先 `/End`，避免抢端口。

## 开机自启：默认没有

router 默认**不注册任何开机自启**。要它随登录启动只能显式装：

```bash
node router.mjs service install [id...]     # 生成 router-<id> 计划任务
node router.mjs service                      # 看有没有注册（未注册=不会开机启动）
node router.mjs service uninstall [id...]    # 停止并移除
```

三个容易混淆的入口，别混用：

| 命令 | 会不会开机自启 |
|---|---|
| `router.mjs up` / `all` / `restart` | ❌ 只改当前进程 |
| `qoder2pi opencode install` | ❌ 只临时拉起代理（2026-11-06 起） |
| `qoder2pi proxy install-service` | ✅ 显式注册 ONLOGON 计划任务 |
| `workbuddy2pi install-service` | ✅ 同上（router 直管后不需要） |

`qoder2pi opencode install` 以前会走 `startProxy()`，在没注册服务时顺手把
登录自启装上——刷新一次模型列表就多两个开机任务。现在它改用 `spawnProxy()`，
只拉起进程、不碰计划任务。

## 端口冲突怎么办

先让 router 按端口收尸：

```bash
node router.mjs down workbuddy-global
node router.mjs up workbuddy-global
```

还不行再手工：

```bash
netstat -ano | findstr :8788           # 找 LISTENING 的 PID
taskkill /PID <pid> /T /F              # 连同子进程一起杀
```

Windows 上 `schtasks /End` **只结束 cmd.exe 包装进程**，`node`/`python` 子进程会活着
继续占端口（见 P7）。router 的 `downSpawn()` 会先杀记录的 PID 树，再按端口清理，
所以通常不需要手工介入。

## 凭证过期

| 表现 | 处理 |
|---|---|
| Qoder 401 TOKEN_INVALID/EXPIRE | 代理会自动续期；失败则重新登录 |
| Qoder 续期失败（refresh 无效） | `qoder2pi login <region> pt-xxx` 或重跑浏览器授权 |
| WorkBuddy access 快到期 | `workbuddy2pi account renew` |
| WorkBuddy 整个失效 | `workbuddy2pi account add` 重新登录 |
| Trae 失效 | `node router.mjs login trae-local`（浏览器登录） |
| CodeArts 失效 | `node router.mjs login codearts`（浏览器 OAuth），或确保 IDE 登录态有效 |

## 日志在哪

| 组件 | 路径 |
|---|---|
| Qoder 代理 | `~/.qoder2pi/proxy/{cn,global}.log` |
| WorkBuddy 反代 | `~/.workbuddy2api/proxy.log`、`global/proxy.log` |
| WorkBuddy 结构化 | `~/.workbuddy2api/codebuddy-proxy.jsonl` |
| WorkBuddy 启动输出 | `~/.workbuddy2api/proxy-stdout.log`、`global/proxy-stdout.log` |
| Trae | `integrations\traework2api\{tw2api,img-proxy}.log` 与 `.err.log` |
| CodeArts | `integrations\codearts2api\run.log` |
| Qoder 授权流程 | `~/.qoder2pi/login/qoder-global.log` |

统一入口：`node router.mjs logs <id> [行数]`。

## 配置文件位置

| 文件 | 内容 |
|---|---|
| `~/.pi/agent/auth.json` | Qoder 凭证（pi 与 opencode 共用） |
| `~/.pi/agent/models.json` | pi 的 provider 与模型：本机十三家 + `router-gateway` + 免费供应商（`scripts/pi-models.mjs`，或 `gateway install` / `providers install` / `router pi sync` 同步写入） |
| `~/.pi/agent/models.backups/` | 上面每次改写前的备份 |
| `~/.pi/agent/extensions/qodbuddy2pi/` | 积分/签到扩展：`index.ts`（`/credits`、`credits` 工具、状态栏）与 `quota.js`（取数层） |
| `~/.pi/agent/extensions/token-limits/` | 上下文/输出限额扩展（`/limits`、自动压缩、输出兜底）；默认 300k / 32k |
| `~/.pi/agent/token-limits.json` | `/limits` 的默认值与逐模型覆盖（`node router.mjs pi install --limits` 部署扩展） |
| `~/.pi/agent/extensions/workbuddy.ts` | WorkBuddy 的 pi 扩展（模型表来自桌面端产品配置） |
| `~/.pi/agent/auth.json` 的 `qoder` / `workbuddy*` | Qoder 的 OAuth 凭据、WorkBuddy 的占位 key |
| `~/.config/opencode/opencode.json` | 本项目写的 provider |
| `~/.config/opencode/opencode.jsonc` | Trae 的 provider（历史位置） |
| `~/.config/opencode/cli.json` | opencode 客户端设置：`plugins` 名单、标签页、权限 |
| `~/.config/opencode/plugins/{provider-credits,token-limits}/` | opencode 插件：积分看板、上下文/输出限额与自动压缩 |
| `~/.local/share/opencode/opencode.db` 的 `kv` 表 | opencode 运行时状态，含 `token-limits/overrides`（`/limits` 的覆盖值） |
| `~/.qoder2pi/config.json` | 扩展副本路径 |
| `~/.codebuddy-session.json` / `-global` | WorkBuddy 生效凭证 |
| `<repo>\router.json` | 用户开关（enabled） |
| `<repo>\.run\processes.json` | router 拉起的 PID / 端口 / 日志 |
| `integrations\codearts2api\codearts2api-data.json` | CodeArts 状态文件（不入库） |

> ⚠️ 动 opencode 配置前先确认 provider 在哪个文件里：
> `grep -l <provider> ~/.config/opencode/*.json*`

---

← [文档索引](README.md) ｜ 上一篇：[新供应商接入排查清单](04-checklist.md) ｜ 下一篇：[怎么把这套经验套到新供应商](06-reuse.md)
