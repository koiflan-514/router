# opencode 接入

把 Qoder 的额度也用在 [opencode](https://opencode.ai) 上。与 pi 共用同一份登录态、
同一份额度，不需要第二次登录。

## 为什么需要一层代理

pi 能直接用 Qoder，是因为扩展 `pi-provider-qoder` 实现了 Qoder 的私有协议：COSY
签名、自定义 body 编码、SSE 信封。opencode 只会说 OpenAI 的
`/v1/chat/completions`，两边协议对不上。

所以中间放一个本机代理 `qoder-proxy.js`：

```
opencode（provider qoder-cn / qoder）
  ↓  OpenAI /v1/chat/completions
qoder-proxy（127.0.0.1:8789 国内版 / 8790 国际版）
  ↓  翻译成 Qoder 的 agent_chat_generation（COSY 签名 + 自定义编码）
gateway.qoder.com.cn / api3.qoder.sh
```

代理复用 pi 的 `~/.pi/agent/auth.json` 凭证，凭证过期时会自动续期并写回，所以
**pi 与 opencode 永远是同一份登录态**。这也意味着：在 pi 里登录一次，两边都能用。

代理本身零依赖（只用 Node 内建模块），不需要 `npm install`，也不会被上游版本带走。

## 接入

```bash
qoder2pi opencode install          # Qoder：两个区域里登录过的那些
qoder2pi opencode install cn       # 只接国内版

workbuddy2pi opencode install      # WorkBuddy：国内版（端口 8787）
workbuddy2pi global opencode install   # WorkBuddy 国际版（端口 8788）

# Trae 走它自己的本机反代（trae2api），provider 直接写在 opencode.jsonc 里，
# 本项目不改动它，只保证 Qoder 与 WorkBuddy 的写入不会碰掉它
```

三家的 provider 都写进同一份 `~/.config/opencode/opencode.json`，合并逻辑收在
`assets/opencode-config.js` 一处：只改 `provider` 里自己那个键，别的 provider 与
顶层设置（`model` / `plugin` / `agent` …）原样保留，改写前先备份。

它会做三件事：

1. 部署代理脚本到 `~/.qoder2pi/vendor/qoder-proxy.js`
2. 注册常驻服务（macOS launchd / Linux systemd --user / Windows 计划任务）
3. 把 provider 写进 `~/.config/opencode/opencode.json`

写入时只碰 `provider` 里 `qoder-cn` 与 `qoder` 这两个键，别的 provider（`trae-local`、
`siliconflow` 之类）与顶层的 `model` / `plugin` 原样保留。已有的 `opencode.json`
会先备份成 `opencode.json.bak-<时间戳>`。

安装器（`install.sh` / `install.ps1`）在装了 Qoder 且检测到 `opencode` 命令时也会
自动跑这一步。

## 使用

```bash
opencode                                   # 然后 /models 选 qoder-cn/Qwen3.8-Flash
opencode run -m qoder-cn/Qwen3.8-Flash "解释这个仓库"
opencode run -m qoder/DeepSeek-V4-Flash "..."      # 国际版
```

模型 id 就是 Qoder 目录里的 `display_name`（去空白），与 pi 里的写法一致。

## 状态与运维

```bash
qoder2pi opencode status        # opencode、配置文件、代理脚本、两个区域
qoder2pi proxy status           # 代理在不在、服务注没注册
qoder2pi proxy restart cn       # 重启国内版代理
qoder2pi proxy logs cn 50       # 代理日志尾部
qoder2pi opencode uninstall     # 从配置里移除并停掉代理
```

总控界面里也有对应菜单项（Qoder 页的「接入 opencode」/「取消 opencode 接入」）。

## 常驻服务

代理是常驻的，不是一次性的：opencode 随时可能发请求，代理不在就静默失败。

| | macOS | Linux | Windows |
|---|---|---|---|
| 机制 | launchd（KeepAlive） | systemd --user | 计划任务（登录触发） |
| 服务名（国内版） | `com.<user>.qoder2pi-proxy` | `qoder2pi-proxy` | `qoder2pi-proxy` |
| 服务名（国际版） | `com.<user>.qoder2pi-proxy-global` | `qoder2pi-proxy-global` | `qoder2pi-proxy-global` |

两个区域是两个独立实例：端口、服务名、日志各用各的，可以同时在线。

## 端点

代理暴露的端点（两个区域路径相同，只是端口不同）：

| 端点 | 作用 |
|---|---|
| `GET /health` | 健康检查，运维命令与 `qoder2pi` 靠它判断服务在不在 |
| `GET /v1/models` | 模型列表（Qoder 来自网关，缓存一小时） |
| `POST /v1/chat/completions` | 对话，支持流式与工具调用 |

三家的端点与端口：

| 来源 | 端点 | 谁提供 | provider id |
|---|---|---|---|
| Qoder 国内版 | `http://127.0.0.1:8789/v1` | 本项目 `qoder-proxy.js` | `qoder-cn` |
| Qoder 国际版 | `http://127.0.0.1:8790/v1` | 本项目 `qoder-proxy.js` | `qoder` |
| WorkBuddy 国内版 | `http://127.0.0.1:8787/v1` | WorkBuddy 反代（`workbuddy2api`） | `workbuddy` |
| WorkBuddy 国际版 | `http://127.0.0.1:8788/v1` | WorkBuddy 反代（`workbuddy2api`） | `workbuddy-global` |
| Trae | `http://127.0.0.1:7863/v1` | Trae 本机反代（第三方，不在本项目内） | `trae-local` |

### 模型清单取哪个来源

WorkBuddy 反代的 `/v1/models` 返回的是包作者按公开资料猜的静态表，与服务端真实可服务
的 id 对不上（表里有根本不能用的 `claude-4.0`/`gpt-5`，却没列真正能用的
`deepseek-v4.1-flash`）。所以 `workbuddy2pi <region> opencode install` 优先采用 **pi 里该
provider 可见的模型**——pi 扩展读的是客户端落盘的产品配置，那份才是准的；只有 pi 不可用
时才退回反代的表。

Qoder 侧反过来：代理自己向网关拉目录，直接就是可用的。

也可以拿它给别的 OpenAI 兼容客户端用（Cursor、Continue 之类），把 `baseURL` 指到
`http://127.0.0.1:8789/v1`、`apiKey` 随便填一个非空值即可（本地代理不校验）。

## 能力与限制

**支持的：**

- 流式输出（`stream: true`，opencode 走这条）
- 非流式（`stream: false`，代理自己聚合）
- 工具调用（`tools` + `tool_calls`，包括多轮的工具结果回填）
- 思考内容（`reasoning_content`，以及被 `<thinking>` 包起来的思考）
- 图片输入（Qoder 的 VL 模型）
- 思考强度（`reasoning_effort`，只在模型支持时下发）

**不支持的：**

- `n > 1`（Qoder 一次只给一条回复）
- `stop` 序列（网关不收这个参数）
- `/v1/completions`（老的补全接口；只做了 chat）

## 排错

**代理起不来。** 看日志：

```bash
qoder2pi proxy logs cn
```

常见原因：`~/.qoder2pi/vendor/qoder-proxy.js` 不存在（重新跑安装器），或端口被别的
程序占了（`qoder2pi proxy status` 会显示端口号）。

**opencode 里看不到模型。** 确认配置文件里真的有：

```bash
opencode debug config | grep -A3 qoder-cn
```

没有的话重跑 `qoder2pi opencode install`。

**请求 401。** 凭证过期且续期失败。检查 `qoder2pi status`，必要时重新登录：

```bash
qoder2pi login cn pt-xxxxxx
qoder2pi proxy restart cn
```

**Windows 上停了服务但端口还被占。** `schtasks /End` 只结束 cmd.exe 包装进程，
`.cmd` 循环拉起的 node 会继续活着。`qoder2pi proxy stop` 已经按端口把子进程收掉；
如果手工停过服务，用 `qoder2pi proxy stop cn` 收尾。
