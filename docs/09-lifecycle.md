# 反代进程生命周期（router 直管）

`router.mjs` 从 2026-11 起不再只是「改开关 + 探端口」，而是真正持有六家反代
（Trae 两段式，共七个子进程）：

| 供应商 | 端口 | 实际命令行 | 日志 |
|---|---|---|---|
| Qoder 国内版 | 8789 | `node integrations/qodbuddy2pi/assets/qoder-proxy.js --region cn --port 8789` | `~/.qoder2pi/proxy/cn.log` |
| Qoder 国际版 | 8790 | 同上 `--region global --port 8790` | `~/.qoder2pi/proxy/global.log` |
| Trae | 7863 | `tw2api.exe` (:7864) → `node img-proxy.js` (:7863) | `E:\router\integrations\traework2api\*.log` |
| CodeArts Agent | 10087 | `codearts2api.exe -data ... -port 10087` | `E:\router\integrations\codearts2api\run.log` |
| WorkBuddy 国内版 | 8787 | `uv run --with ... python -m codebuddy_proxy --port 8787` | `~/.workbuddy2api/proxy.log`、`proxy-stdout.log` |
| WorkBuddy 国际版 | 8788 | 同上 `--global --endpoint https://www.codebuddy.ai` | `~/.workbuddy2api/global/proxy.log`、`global/proxy-stdout.log` |

`router.mjs list` 里的 **PID** 是监听端口的那个进程。WorkBuddy 的 `uv` 会再拉起
Python，外层 uv 与内层 cpython 的 PID 不同，停止时按「记录过的 PID 树 + 监听端口」
一起收。

## 登录生命周期

登录不是反代启动的前置条件，但缺凭证时反代只会 401。router 在启动后会读凭证文件：
Qoder 读 `~/.pi/agent/auth.json`，Trae 读 `auths/*.json`，CodeArts 读
`codearts2api-data.json` 的账号池，WorkBuddy 读 `~/.codebuddy*-session.json`。
缺凭证时：

- 交互式终端里的 `up` / `all` / `on` / `reload` 直接打开浏览器；
- 管道、计划任务里只打印 `node router.mjs login <id>`；
- `login` 命令可单独补齐，`--force` 强制重登；
- Trae/CodeArts 的登录需要本地网关，router 会临时启动它，登录后按原状态停掉或重启；
- Qoder 国内版只支持 PAT，会打开 PAT 页面并在交互终端里提示粘贴；国际版走设备授权。

成功后 router 会自动重启正在运行的对应反代，让新凭证生效。细节见
[05-operations.md](05-operations.md#浏览器登录)。

## 为什么不用计划任务/安装脚本拉起

`qoder2pi` 与 `workbuddy2pi` 在 Windows 上用「登录时的计划任务 + `.cmd` keep-alive」
常驻。这套机制在交互式桌面会话里通常没问题，但在非交互式会话（自动化、远程执行、
某些沙箱）里会看到任务状态一直是 `Queued`，端口却始终不监听；另外 `.cmd` 的
`:loop` 在停止时容易留下子进程。

反代本体其实只依赖「命令行 + 环境变量 + 端口」。router 直接 spawn 更可控：

- 启动后立刻记录 PID 与命令行，PID 复用时可校验映像名再杀
- stdout/stderr 直接落到各家的日志文件，不需要再包一层 `.cmd`
- 停止时先杀 PID 树，再按端口找监听者，循环到端口真空
- 不需要计划任务就能在 `router.mjs up` 时真正拉起

`qoder2pi` / `workbuddy2pi` 仍然有用：登录、切账号、续期、查积分，以及 WorkBuddy
写 opencode 时读取 pi 的模型清单。**启动/停止不再经过它们。**

## 命令

```bash
cd E:/router
node router.mjs list                 # 状态总表
node router.mjs up                   # 按开关启动全部
node router.mjs up trae-local         # 只启动一家（不改开关）
node router.mjs restart workbuddy     # 重启
node router.mjs down                 # 停止全部
node router.mjs down --keep-oc        # 只停进程，保留 opencode provider
node router.mjs logs trae-local 80    # 日志尾部
node router.mjs doctor               # 自检
```

`up` / `down` / `restart` 不带 id 时按 `router.json` 的开关来（`down` 例外：默认停
全部，避免「以为关了其实还在跑」）。带 id 时只动指定的供应商，不改变开关。

## 状态文件

| 文件 | 作用 |
|---|---|
| `router.json` | 用户选择：哪些供应商开启 |
| `.run/processes.json` | router 自己拉起的 PID、端口、命令行、日志路径 |

`.run/processes.json` 只是加速定位，**不是唯一依据**。停止时即使这个文件丢了，
也会按端口找到监听进程并清理。

## 停止算法（Windows）

1. 读 `.run/processes.json`，对每个记录过的 PID：
   - 先校验映像名（`node.exe` / `tw2api.exe` / `uv.exe` / `codearts2api.exe`），
     防止 PID 复用后误杀别的进程
   - `taskkill /PID <pid> /T`（先礼），不死再 `/F`
2. 对每个进程的端口，用 `netstat -ano` 找 `LISTENING` 的 PID，`taskkill /T /F`
3. 等 600ms 再查一次端口，最多 4 轮
4. 仍然占用就报错，并打印手动命令

Trae 是两段式，停止顺序是 `img-proxy`(:7863) → `tw2api`(:7864)，反过来会让
img-proxy 在 upstream 已经消失时短暂报错。

WorkBuddy 的 `uv` 是三层链（`uv.exe` → 缓存里的 builds python → cpython）。只杀监听
端口的 cpython，外层 uv 会把它重新拉起来；所以必须按 PID 树杀，再按端口兜底。

## 登录自启

```bash
node router.mjs service install              # 六家都注册
node router.mjs service install trae-local    # 只注册一家
node router.mjs service status
node router.mjs service uninstall trae-local  # 停止并移除
```

router 会生成 `E:\router\.run\autostart-<id>.cmd`，并注册名为 `router-<id>` 的
Windows 计划任务（`ONLOGON`）。脚本内容只有一行：调用
`router.mjs _autostart <id>`，由 router 拉起真正的反代后退出。

旧的 `qoder2pi-proxy` / `workbuddy2pi` 计划任务如果还在，router 在启动对应供应商
前会先 `schtasks /End` 掉它，避免两个实例抢同一个端口。是否删除旧任务由你决定；
保留不影响 `router.mjs up`。

## 故障排查

| 症状 | 先看 |
|---|---|
| `up` 报「找不到可执行文件」 | `node router.mjs doctor`，看具体路径 |
| 启动了但端口没起来 | `node router.mjs logs <id> 80` |
| 停不下来 | `netstat -ano \| findstr :<port>`，再 `taskkill /PID <pid> /T /F` |
| PID 对不上 | `list` 显示的是端口所有者；WorkBuddy 外层 uv 的 PID 在 `.run/processes.json` |
| 改了源码没生效 | 确认 router 找的是哪份脚本：`doctor` 里的路径 |

## 加第七家

在 `router.mjs` 的 `PROVIDERS` 里加一项：

- `port`：对外端口
- `processes`：一个或多个进程（按启动顺序）
- 每个进程给 `command` / `args` / `cwd` / `env` / `log` / `errLog` / `waitMs`
- `ocProvider`：写进 opencode 的 provider id

然后在 `scripts/health.mjs` 的 `SOURCES` 里加一行，`router.mjs` 会自动获得
`list` / `up` / `down` / `restart` / `logs` / `doctor` / `service`。
