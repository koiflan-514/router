# 日常运维

## 一眼看状态

```bash
node E:/router/router.mjs list                 # 开关 / 进程 / PID / opencode / 端口
node E:/router/router.mjs account              # 账号池 / 当前生效账号
node E:/router/router.mjs doctor               # 命令、文件、端口、opencode 自检
node E:/router/scripts/health.mjs              # 端口 + 凭证 + 端到端试打
node E:/router/scripts/health.mjs --no-probe   # 只看端口与凭证（省额度）
bash E:/router/scripts/verify-all.sh           # pi + opencode 全量
bash E:/router/scripts/verify-all.sh tools     # 工具调用（最慢，最有用）
```

## 启停反代

八个反代统一走 router，不再分别调各家的 `start` / `stop`：

```bash
node E:/router/router.mjs up                   # 按开关启动（开关为空时什么都不启动）
node E:/router/router.mjs up --all              # 先全开再启动，等价于 router.mjs all
node E:/router/router.mjs up trae-local         # 只启动一家（不改开关）
node E:/router/router.mjs restart workbuddy     # 重启
node E:/router/router.mjs down                 # 停止全部
node E:/router/router.mjs down --keep-oc        # 只停进程，保留 opencode provider
node E:/router/router.mjs logs codearts 80      # 日志尾部
```

生命周期、PID 与端口清理细节见 [09-lifecycle.md](09-lifecycle.md)。

## 双系统共享账号

双系统共用 `E:\router` 时，用共享库把两边的登录态、账号池和 opencode/pi 配置对齐：

```bash
node E:/router/router.mjs sync-homes                 # 立即同步
node E:/router/router.mjs sync-homes --status        # 只读查看
node E:/router/router.mjs sync-homes --homes "C:\Users\Administrator;D:\Users\demo"
```

共享库固定在 `E:\router\.shared-home`，每次 `router.mjs` 启动/退出也会自动跑一次。
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
node E:/router/router.mjs login                 # 当前开启的供应商逐个检查
node E:/router/router.mjs login qoder           # 只登录国际版
node E:/router/router.mjs login trae-local       # 会临时启动 tw2api，登录后恢复原状态
node E:/router/router.mjs login --force          # 已登录也重新走一遍
```

交互式 `up` / `all` / `on` / `reload` 默认会自动打开浏览器；脚本、计划任务或管道里
只打印提示。`up --login` 可强制尝试，`--no-login` 可关闭自动登录。

> router 调用的是 `integrations/qodbuddy2pi/assets` 里的源码。想在 shell 里直接敲
> `qoder2pi` / `workbuddy2pi`，可以加别名：
> `alias qoder2pi='node E:/router/integrations/qodbuddy2pi/assets/qoder2pi'`。

## 切换账号

`router account` 统一了各家不同的换号方式，不用再记 `workbuddy2pi account`、
CodeArts 控制台或 Trae 的 state 文件：

```bash
node E:/router/router.mjs account                    # 所有账号 + 当前生效
node E:/router/router.mjs account workbuddy          # 只看一家
node E:/router/router.mjs account workbuddy b        # 切到 slot b（运行中会自动重启）
node E:/router/router.mjs account codearts GT-demo   # 只启用这个账号
node E:/router/router.mjs account trae-local --all      # 恢复整池参与调度
node E:/router/router.mjs account codearts 2 --dry-run  # 预览，不写文件不重启
node E:/router/router.mjs account add workbuddy         # 浏览器登录，往池里加一个账号
```

添加账号统一用 `account add <id>`（等价写法 `account <id> --add`）。它会走该家
原有的浏览器登录流程：WorkBuddy 新 uid 写新 slot、已有 uid 只更新；CodeArts
登录成功即入库；Trae 按登录的 uid 落一个 `auths/trae-<uid>.json`。同一个账号
不会重复添加。Qoder 是单账号，不能往池里加，换号用 `login <id> --force`。

## 增删账号与账号体检

```bash
node E:/router/router.mjs account check                 # 只列出需要处理的账号
node E:/router/router.mjs account remove workbuddy c    # 删除 slot c
node E:/router/router.mjs account remove trae-local 3 --force   # 有故障的账号要 --force
node E:/router/router.mjs account restore workbuddy     # 从归档恢复
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
node E:/router/router.mjs models            # 也可只刷某几家：models zcode loomy raccoon qwenwork
```

按来源走的分支：Qoder / Trae / CodeArts / ZCode / Loomy 直接拉 `/v1/models`；
WorkBuddy 走 `workbuddy2pi opencode install`（模型表只能来自 pi 扩展）。

**`router.mjs sync` 不刷新模型**：它只在 provider 不存在时写入，已存在就跳过。
ZCode 的 opencode 侧长期只有 1 个模型、Qoder 国内版还留着上游已停用的模型，
都是这个行为造成的。

需要分来源手工刷新时：

```bash
node E:/router/integrations/qodbuddy2pi/assets/qoder2pi opencode install
node E:/router/integrations/qodbuddy2pi/assets/workbuddy2pi opencode install
node E:/router/integrations/qodbuddy2pi/assets/workbuddy2pi global opencode install
node E:/router/scripts/pi-models.mjs          # pi 的 Trae / CodeArts / ZCode / Loomy
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
- 刷新后跑 `node E:/router/router.mjs list` 与 `node E:/router/scripts/health.mjs --no-probe`
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

## Qoder

```bash
qoder2pi status                 # pi、扩展、两个区域、opencode 代理
qoder2pi login cn pt-xxxxxx     # 国内版（PAT）
node E:/router/router.mjs login qoder   # 国际版：浏览器 OAuth（推荐）
qoder2pi logout cn              # 退出（auth.json 先备份）
qoder2pi models                 # 两个区域各自在 pi 里可见的模型

# 代理启停统一用 router（qoder2pi proxy 仍可用于看状态/兼容旧习惯）
node E:/router/router.mjs up qoder-cn
node E:/router/router.mjs restart qoder
node E:/router/router.mjs down qoder-cn
node E:/router/router.mjs logs qoder-cn 50

qoder2pi opencode status
qoder2pi opencode uninstall     # 兼容旧命令；日常用 router sync

qoder2pi credits                # 余额与签到
qoder2pi credits checkin
```

国内版**不支持**设备授权（只支持 PAT）；国际版两者都支持。router 的 `login qoder`
直接实现了国际版的 PKCE + deviceToken 轮询，成功后写回 `~/.pi/agent/auth.json`。

## WorkBuddy

```bash
workbuddy2pi status             # 服务、端点、凭证、账号
workbuddy2pi logs 100           # 反代自己的日志尾部（router logs 也行）
node E:/router/router.mjs login workbuddy          # 浏览器登录并建档
node E:/router/router.mjs login workbuddy-global   # 国际版
workbuddy2pi account renew      # 续期当前账号
workbuddy2pi opencode install   # 只写 opencode 配置，不会重启反代

# 查/切账号统一用 router（会直接重启反代，不依赖计划任务）
node E:/router/router.mjs account workbuddy
node E:/router/router.mjs account workbuddy <key>

# 启停统一用 router
node E:/router/router.mjs up workbuddy
node E:/router/router.mjs restart workbuddy
node E:/router/router.mjs down workbuddy

workbuddy2pi global <命令>       # 同上，作用于国际版
```

> `workbuddy2pi account <key>` 仍可用，但它的重启依赖计划任务；router 的
> `account` 会先保存当前凭证再复制 slot，然后直接走 `doRestart`，更可控。

## 升级反代 wheel 的完整流程

wheel 版本影响服务端能否接受请求（见 `02-pitfalls.md` P1），升级步骤固定三步：

```bash
# 1. 放进 integrations 的 vendor 目录（旧版本删掉，避免服务选错）
cp workbuddy2api-X.Y.Z-py3-none-any.whl E:/router/integrations/qodbuddy2pi/assets/vendor/
rm -f E:/router/integrations/qodbuddy2pi/assets/vendor/workbuddy2api-<旧版>.whl

# 2. 重启反代：router 每次启动都会重新扫描 integrations 里最新的 wheel
node E:/router/router.mjs restart workbuddy workbuddy-global

# 3. 验证「进程加载的是新版本」，而不是「磁盘上是新版本」
node E:/router/router.mjs logs workbuddy 40
node E:/router/scripts/health.mjs
```

> 旧流程里的 `workbuddy2pi install-service` 会生成一个 `.cmd` 计划任务。router 直管后
> 不需要它；如果旧任务还在，router 启动前会先 `/End`，避免抢端口。

## 开机自启：默认没有

router 默认**不注册任何开机自启**。要它随登录启动只能显式装：

```bash
node E:/router/router.mjs service install [id...]     # 生成 router-<id> 计划任务
node E:/router/router.mjs service                      # 看有没有注册（未注册=不会开机启动）
node E:/router/router.mjs service uninstall [id...]    # 停止并移除
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
node E:/router/router.mjs down workbuddy-global
node E:/router/router.mjs up workbuddy-global
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
| Trae 失效 | `node E:/router/router.mjs login trae-local`（浏览器登录） |
| CodeArts 失效 | `node E:/router/router.mjs login codearts`（浏览器 OAuth），或确保 IDE 登录态有效 |

## 日志在哪

| 组件 | 路径 |
|---|---|
| Qoder 代理 | `~/.qoder2pi/proxy/{cn,global}.log` |
| WorkBuddy 反代 | `~/.workbuddy2api/proxy.log`、`global/proxy.log` |
| WorkBuddy 结构化 | `~/.workbuddy2api/codebuddy-proxy.jsonl` |
| WorkBuddy 启动输出 | `~/.workbuddy2api/proxy-stdout.log`、`global/proxy-stdout.log` |
| Trae | `E:\router\integrations\traework2api\{tw2api,img-proxy}.log` 与 `.err.log` |
| CodeArts | `E:\router\integrations\codearts2api\run.log` |
| Qoder 授权流程 | `~/.qoder2pi/login/qoder-global.log` |

统一入口：`node E:/router/router.mjs logs <id> [行数]`。

## 配置文件位置

| 文件 | 内容 |
|---|---|
| `~/.pi/agent/auth.json` | Qoder 凭证（pi 与 opencode 共用） |
| `~/.pi/agent/models.json` | pi 的 provider 与模型：本机六家 + `router-gateway` + 免费供应商（`scripts/pi-models.mjs`，或 `gateway install` / `providers install` 同步写入） |
| `~/.pi/agent/models.backups/` | 上面每次改写前的备份 |
| `~/.pi/agent/extensions/workbuddy.ts` | WorkBuddy 的 pi 扩展（模型表来自桌面端产品配置） |
| `~/.pi/agent/auth.json` 的 `qoder` / `workbuddy*` | Qoder 的 OAuth 凭据、WorkBuddy 的占位 key |
| `~/.config/opencode/opencode.json` | 本项目写的 provider |
| `~/.config/opencode/opencode.jsonc` | Trae 的 provider（历史位置） |
| `~/.qoder2pi/config.json` | 扩展副本路径 |
| `~/.codebuddy-session.json` / `-global` | WorkBuddy 生效凭证 |
| `E:\router\router.json` | 用户开关（enabled） |
| `E:\router\.run\processes.json` | router 拉起的 PID / 端口 / 日志 |
| `E:\router\integrations\codearts2api\codearts2api-data.json` | CodeArts 状态文件（不入库） |

> ⚠️ 动 opencode 配置前先确认 provider 在哪个文件里：
> `grep -l <provider> ~/.config/opencode/*.json*`
