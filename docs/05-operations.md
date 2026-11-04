# 日常运维

## 一眼看状态

```bash
node E:/router/router.mjs list                 # 开关 / 进程 / PID / opencode / 端口
node E:/router/router.mjs doctor               # 命令、文件、端口、opencode 自检
node E:/router/scripts/health.mjs              # 端口 + 凭证 + 端到端试打
node E:/router/scripts/health.mjs --no-probe   # 只看端口与凭证（省额度）
bash E:/router/scripts/verify-all.sh           # pi + opencode 全量
bash E:/router/scripts/verify-all.sh tools     # 工具调用（最慢，最有用）
```

## 启停反代

六个反代统一走 router，不再分别调各家的 `start` / `stop`：

```bash
node E:/router/router.mjs up                   # 按开关启动全部
node E:/router/router.mjs up trae-local         # 只启动一家
node E:/router/router.mjs restart workbuddy     # 重启
node E:/router/router.mjs down                 # 停止全部
node E:/router/router.mjs down --keep-oc        # 只停进程，保留 opencode provider
node E:/router/router.mjs logs codearts 80      # 日志尾部
```

生命周期、PID 与端口清理细节见 [09-lifecycle.md](09-lifecycle.md)。

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
workbuddy2pi account            # 列出账号 slot
workbuddy2pi account <key>      # 切换（会尝试重启服务）
node E:/router/router.mjs login workbuddy          # 浏览器登录并建档
node E:/router/router.mjs login workbuddy-global   # 国际版
workbuddy2pi account renew      # 续期当前账号
workbuddy2pi opencode install   # 只写 opencode 配置，不会重启反代

# 启停统一用 router
node E:/router/router.mjs up workbuddy
node E:/router/router.mjs restart workbuddy
node E:/router/router.mjs down workbuddy

workbuddy2pi global <命令>       # 同上，作用于国际版
```

> `workbuddy2pi account <key>` 切换账号时，它自己的重启逻辑依赖计划任务；如果计划任务
> 起不来，切完账号再跑一次 `node E:/router/router.mjs restart workbuddy` 即可。

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
| `~/.pi/agent/models.json` | pi 的 provider 与模型（含 Trae） |
| `~/.config/opencode/opencode.json` | 本项目写的 provider |
| `~/.config/opencode/opencode.jsonc` | Trae 的 provider（历史位置） |
| `~/.qoder2pi/config.json` | 扩展副本路径 |
| `~/.codebuddy-session.json` / `-global` | WorkBuddy 生效凭证 |
| `E:\router\router.json` | 用户开关（enabled） |
| `E:\router\.run\processes.json` | router 拉起的 PID / 端口 / 日志 |
| `E:\router\integrations\codearts2api\codearts2api-data.json` | CodeArts 状态文件（不入库） |

> ⚠️ 动 opencode 配置前先确认 provider 在哪个文件里：
> `grep -l <provider> ~/.config/opencode/*.json*`
