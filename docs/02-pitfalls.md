# 踩坑记录

按「代价从高到低」排。每条都给出 **症状 / 真因 / 判断依据 / 修法**，重点是**判断依据**——
症状会变，判断方法不会。

---

## P1. `code 11128 request illegal` —— 报错文字把你引向错误方向

**症状**

WorkBuddy 国际版任何一次对话都 400：

```json
{"code":11128,"msg":"request illegal",
 "displayMsg":{"zh":"请求被拦截，请重新发送"},
 "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}
```

`workbuddy2pi global status` 一切正常：服务在跑、凭证有效、模型能列出来。国内版用同一个
反代、同一个客户端，完全正常。

**真因（两个，串在一起）**

1. **反代版本旧。** 2026-10-16 起国际站对 `/v2/chat/completions` 强制校验
   `X-Conversation-*` 头族，并要求 messages 首条是 system prompt。2.0.6 没有这段逻辑。
2. **端点字符串不匹配。** 2.0.7 注入这些头的条件是 `if ("codebuddy.ai" in url)`。
   本项目早期为贴合账号 domain 把端点覆盖成 `www.workbuddy.ai`，这个字符串不含
   `codebuddy.ai`，所以**即使升级到 2.0.7 也不注入**，报错一模一样。

**判断依据（关键）**

`displayTips` 说的「不是官方客户端发出」是**误导**。真正的定位办法是：绕开反代，手工
构造请求逐个消条件——

```js
// 1) 先只加 X-Conversation-* 三件套
//    → 报错从 "request illegal" 变成 "first message is not system prompt"
//    这一步证明「头生效了」，闸门在往里一层
// 2) 再补 system prompt
//    → 200
```

**这个「错误逐步收窄」的手法比读源码更快**：每消掉一个校验，报错会具体化成下一个。
如果两个条件一起补齐，你只会看到「还是 400」，无法判断哪个没生效。

同时确认：国内站（`copilot.tencent.com`）**没有**这道校验。所以「国内正常 / 国际异常」
不是账号问题，是两个站点的策略不同。

**修法**

```bash
# 1. 升级到 >= 2.0.7（vendored wheel）
# 2. 端点必须是 www.codebuddy.ai
# 3. 重装服务，让服务定义指向新 wheel
workbuddy2pi global install-service
workbuddy2pi global restart
```

---

## P2. 升级了 wheel，服务还在跑旧代码

**症状**

`assets/vendor/` 里明明是 2.0.7，`restart` 之后 `11128` 照旧，日志里也看不到新逻辑
的痕迹。

**真因**

服务定义（Windows 的 `serve.cmd` / macOS 的 plist / Linux 的 unit）里写的是 wheel 的
**绝对路径**，在 `install-service` 那一刻固化：

```bat
"C:\...\uv.exe" run --with "C:\Users\...\vendor\workbuddy2api-2.0.6-py3-none-any.whl" ...
                                                                    ^^^^^ 还是旧的
```

`restart` 只是重启进程，不会重写定义。

**判断依据**

```bash
# 看进程实际加载的包，而不是看磁盘上放了什么
grep -o "workbuddy2api-[0-9.]*" ~/.workbuddy2api/serve-global.cmd
# 或
wmic process where "name='python.exe'" get commandline
```

现在 `workbuddy2pi status` 会自动比「服务定义引用的 wheel」vs「当前应使用的 wheel」，
不一致就警告（`staleServiceWheel()`）。

**修法**

```bash
workbuddy2pi global install-service   # 重写服务定义
workbuddy2pi global restart
```

> 2026-11 起 `router.mjs` 直接 spawn WorkBuddy，每次启动都重新扫描
> `~/.workbuddy2api/vendor/` 里最新的 `workbuddy2api-*.whl`，不再把路径固化在
> `serve.cmd` 里。走 router 时升级后只需 `node E:/router/router.mjs restart workbuddy`。
> 旧计划任务仍然适用本条。

**一般化**：任何「服务定义写死路径」的场景（systemd unit、launchd plist、计划任务
包装脚本），升级二进制后都要重装服务，`restart` 不够。

---

## P3. 反代的模型表与服务端真实可用集对不上

**症状**

`curl :8788/v1/models` 返回 17 个模型，但用其中 `claude-4.0` / `gemini-2.5-flash`
报 `400`（甚至 `11102 model service info not found`）；而真正能用的
`deepseek-v4.1-flash` **不在表里**，写它就变成 `Model unavailable`。

**真因**

反代自带的是包作者按公开资料猜的静态清单（`models_config.global.json`）。真实可用集
在桌面端落盘的产品配置里：

```
~/.workbuddy/cache/acc-product-config-v*.json          （国内版）
~/.workbuddy-ai/cache/acc-product-config-v*.json       （国际版客户端）
```

**判断依据**

拿几个 id 直接打 `/v1/chat/completions`，看哪些 200、哪些报什么码：

- `11102 model service info not found` → 表里有、服务端没有
- `Model unavailable` → 反代直接拦了，表里没有

两边都试一遍就能确认「表不可靠」。

**修法**

`opencode install` 优先采用 **pi 里该 provider 可见的模型清单**（pi 扩展读产品配置），
pi 不可用才退回反代的表。2026-11-04 又按上游 `/v3/config` + 逐模型实测校准了一次：
国内版 31 个、国际版 10 个。国际版原来列出的 GPT / Grok / Gemini 等在本账号下会返回
`11158 model is not allowed for user type [personal_free_user]`，所以先从静态表里移除；
升级套餐后重新校准即可。

**一般化**：**反代/网关自带的能力清单永远是二手信息，以「客户端落盘配置」或
「实测能通的 id」为准。**

---

## P4. COSY 签名必须签「实际发出去的字节」

**症状**

Qoder 网关返回 `403 Request discarded`（不是 401，很容易误判成权限问题）。

**真因**

`Authorization: Bearer COSY.<payload>.<sig>` 里的签名把 **body 的 md5** 混进去了。
如果按明文 JSON 算签名，却发出「三段轮转 + 换字母表」编码后的字节，签名就对不上。

```js
// 错：用明文算签名，发编码后的
const sig = sign(JSON.stringify(reqBody));
fetch(url, { body: encode(reqBody) });

// 对：先编码，再用编码后的字节算签名与 bodyhash
const encoded = encodeQoderBody(Buffer.from(JSON.stringify(reqBody)));
const headers = buildAuthHeaders(encoded, url, creds);
fetch(url, { body: encoded, headers });
```

**判断依据**

`403` + `"errorMessage":"Request discarded"` + `"errorCode":"Forbidden"` 是 WAF 层的
拒绝。Qoder 的 `401` 才是 token 问题（`TOKEN_INVALID` / `TOKEN_EXPIRE`）。
**403 = 你发的东西格式不对；401 = 你的凭证不对。** 区分这个省大量时间。

**修法**：见 `assets/qoder-proxy.js` 的 `buildAuthHeaders(encoded, …)` 调用处——签名与
bodyhash 都吃编码后的 Buffer。

---

## P5. body 编码少一步 → `500 Internal Server Error`

**症状**

Qoder 网关返回 `{"success":false,"msgCode":500,"msgInfo":"Internal Server Error"}`。
改 model、改 header 都没用。

**真因**

Qoder 的 body 不是明文 JSON，是三步：

1. `JSON.stringify` → `Buffer`
2. 标准 base64
3. **三段轮转**：把 base64 串按 `1/3` 切开，顺序变成 `[后1/3][中间1/3][前1/3]`
4. **换字母表**：标准 base64 字母表 → 自定义表，`=` 换成 `$`

漏掉 3 或 4，服务端解出乱码 → 500。

**判断依据**

- `500` + 常规 JSON 明文 → 编码没做
- `200` 但事件流内容为空/乱码 → 编码做了但顺序错

**修法**

```js
const QODER_CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// 轮转时注意长度 < 3 的边界：a = floor(n/3) 可能为 0
```

---

## P6. SSE 是双层信封，直接透传会得到空回复

**症状**

客户端收到一堆 `data:` 但解析不出内容；或代理转发的流里 `choices` 是空的。

**真因**

Qoder 的流是「信封套信封」：

```
data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{...}}]}","statusCodeValue":200}
                  ^^^^^^ 内层是字符串，需要再 JSON.parse 一次
```

**判断依据**：看一眼原始字节就知道，`body` 的值带引号转义。

**修法**

```js
const envelope = JSON.parse(payload);
if (envelope.statusCodeValue !== 200) throw new Error(envelope.body);  // 别当成功
if (envelope.body === '[DONE]') return { done: true };
const inner = JSON.parse(envelope.body);   // 第二次 parse
```

注意 **`[DONE]` 在内外两层都会出现**，两层都要认。

---

## P7. Windows 上停服务不带走子进程

**症状**

`workbuddy2pi global stop` 报成功，但端口仍被占用，`status` 显示还在跑。

**真因**

计划任务的 `schtasks /End` 只结束 `cmd.exe` 包装进程。`.cmd` 里用 `:loop` 做 keep-alive
拉起的 `node.exe` / `python.exe` 是独立进程，会继续活着占端口。

**判断依据**

```bash
netstat -ano | findstr :8788      # 看 LISTENING 的 PID
tasklist /FI "PID eq <pid>"       # 确认那是子进程而不是包装进程
```

**修法**

按端口找进程再杀：

```js
const pid = portPid(port);          // netstat -ano，末列是 PID（与系统语言无关）
killPid(pid);                       // taskkill /PID <pid> /T /F
```

---

## P8. 改了配置，别的 provider 消失了

**症状**

接入 WorkBuddy 之后，opencode 里 Trae 的模型全没了。

**真因（两个层次）**

1. 测试时把 `opencode.jsonc` 挪到 `/tmp` 忘了挪回 → Trae 的 provider 只存在那个文件里
2. 更深层：如果「写配置」是整份覆盖而不是合并，也会撞掉别人的 provider

**判断依据**

```bash
opencode debug config    # 列出实际加载了哪些配置文件、合并后是什么
```

**修法**

- 合并写入，只碰自己那个键，写前备份（`assets/opencode-config.js`）
- 动配置文件前先 `grep -l <provider> ~/.config/opencode/*` 搞清楚它在哪个文件里

---

## P9. `Get-FileHash` 在某些 PowerShell 环境里不存在

**症状**

`install.ps1` 在「装 WorkBuddy 扩展」这一步抛 `CommandNotFoundException` 中断。

**真因**

`Get-FileHash` 是 PowerShell 4.0+ 的 cmdlet，但受限环境（Constrained Language Mode、
精简版 PS、某些 CI 容器）里不可用。

**修法**

装的是同一个文件时逐字节比较代价极低，不依赖任何 cmdlet：

```powershell
function Test-SameFile($a, $b) {
  $fa = Get-Item -LiteralPath $a; $fb = Get-Item -LiteralPath $b
  if ($fa.Length -ne $fb.Length) { return $false }
  $ba = [System.IO.File]::ReadAllBytes($fa.FullName)
  $bb = [System.IO.File]::ReadAllBytes($fb.FullName)
  for ($i = 0; $i -lt $ba.Length; $i++) { if ($ba[$i] -ne $bb[$i]) { return $false } }
  return $true
}
```

**一般化**：安装脚本要能在「最小可用 PowerShell」上跑，优先用 .NET 方法而不是 cmdlet。

---

## P10. 额度为 0 ≠ 模型不可用

**症状**

Qoder 国际版 `/api/v2/quota/usage` 返回 `userQuota.total = 0` 且
`isQuotaExceeded: true`，但 `Qwen3.8-Flash` 实际能调通。

**真因**

免费账号的套餐额度是 0，但**部分模型的 `enable` 是 true**，这些模型有独立的免额通道。
额度与可用性是两件事。

**判断依据**

拉一次 `algo/api/v2/model/list?Encode=1`，看哪些 `enable: true`：

```bash
# 国际版当时只有 1 个
qfmodel | Qwen3.8-Flash | enable true
其余 13 个全是 enable false
```

**修法**：显示层把「额度用尽」与「查不到」分开；别因为额度 0 就说账号废了。

---

## P11. 签到「没接口」≠「活动没开」

**症状**

Qoder 国内版签到显示「当前没有每日签到活动」；国际版直接 404。

**真因**

- 国内版：接口存在（`/sash/api/v1/me/daily-check-in/status` 200），但 `status: DISABLED`
- 国际版：接口本身 **404**，活动只挂在网页上，没有可调用的领取接口

**修法**：分成三种状态显示——

| 情况 | 显示 |
|---|---|
| 接口 404 | 该区域没有签到接口（活动只在网页里） |
| `status: DISABLED` | 该区域当前没有每日签到活动 |
| 可领 / 已领 | 今日可领 N / 今日已签到 |

**一般化**：**HTTP 404 与业务状态为「关闭」是不同的事实，混在一起会误导。**

---

## P12. 设备授权流程的链接是一次性的

**症状**

给了授权链接，用户过一会儿才点，流程已超时（10 分钟），只能重新发起。

**修法**

- 授权轮询设 10 分钟上限，超时明确报错而不是静默退出
- 重新发起时生成**新的** nonce/challenge（旧链接不会复活）
- 把链接写入日志文件，用户可以事后查看（`~/.qoder2pi/login/qoder-global.log`）

---

## 附：错误码速查

| 码 | 含义 | 先查什么 |
|---|---|---|
| Qoder `401 TOKEN_INVALID/EXPIRE` | 凭证问题 | 重新登录 / 续期逻辑 |
| Qoder `403 Request discarded` | WAF 拒绝，请求格式不对 | COSY 签名是否对「编码后的字节」算 |
| Qoder `500 Internal Server Error` | body 编码错 | 三段轮转 + 字母表替换 |
| WorkBuddy `11101` | 非流式不支持 | 加 `stream: true` |
| WorkBuddy `11102` | 模型不存在 | 模型表是否过时（P3） |
| WorkBuddy `11128` | 渠道校验失败 | 反代版本 + 端点字符串（P1） |
| WorkBuddy `11158` | 套餐不允许该模型 | 不是 bug，权限问题 |
| Qoder `403 10605 isQueued` | 排队限流，非权限问题 | 等 retryAfterSeconds 重试（P16） |
| 端口仍在但服务「已停」 | 进程链没杀干净 | uv 三层链 + keep-alive（P13） |
| 改完脚本行为没变 | 跑的是旧的安装副本 | `cmp` integrations 与 `~/.local/bin`（P14） |
| 华为云 `APIG.0301` | 签名格式不对，不是凭证 | 尾斜杠 + 多空行（P17） |
| `Message role cannot empty` | 客户端发了 `developer` 角色 | `supportsDeveloperRole:false`（P18） |
| 某个 provider 从配置里消失 | 被重写挪到了另一个文件 | `grep -l` 找出它现在在哪（P15） |

---

## P13. 停了服务但进程还在：uv 是三层链

**症状**

`workbuddy2pi stop` 报「服务已停止」，但端口仍在监听；`restart` 之后连的还是旧进程。

**真因（两层）**

1. **uv 是三层链**：`uv.exe` → `uv 缓存里的 builds python` → 真正的 `cpython`。
   只有最内层监听端口，但**外层 uv 会在子进程死掉后把它重新拉起来**。
   所以从里往外杀（按端口找 cpython 再 taskkill）是白费力气。
2. **`.cmd` 的 keep-alive**：计划任务用 `:loop` + `timeout /t 15` 保活，
   `schtasks /End` 之后那个 `timeout` 结束还会 `goto loop` 再拉起一次。

**判断依据**

```bash
# 看整条链，而不只是监听端口的那个
wmic process get processid,commandline | grep "codebuddy_proxy --host"
# 会看到 uv.exe / builds python / cpython 三层，PID 各不相同
```

**修法**

按命令行特征找出**整条链**（含 uv）一起收，并循环到端口真空：

```js
function proxyChainPids(port) {
  // 特征：命令行含 codebuddy_proxy 且含本区域端口
  // 不能用「所有 python」，否则会误杀另一个区域
}
function killProxyChain(port, timeoutMs = 20000) {
  while (Date.now() < deadline) {
    const targets = new Set([...proxyChainPids(port), ...portPids(port)]);
    if (!targets.size) return true;
    for (const pid of targets) killPid(pid);
    sleepMs(600);
  }
}
```

> 2026-11 起 `router.mjs` 直接 spawn WorkBuddy，`downSpawn()` 先按记录的外层 uv
> PID 杀整棵树，再按端口找监听者兜底；日常不需要再调 `workbuddy2pi stop`。

---

## P14. 改了运维命令却没生效：调用的是安装副本

**症状**

在源码里改好 `workbuddy2pi`，直接跑它一切正常；但通过 `router.mjs` 调用
就还是旧行为。表现为「明明修好了还是不行」，且无法解释。

**真因**

历史上 router 优先找 `~/.local/bin/workbuddy2pi`，那是**安装时的副本**，不是
仓库源码。改了源码不复制过去，调用的仍是旧代码。

**判断依据**

```bash
# integrations 里的源码与 ~/.local/bin 的副本是否一致
cmp -s E:/router/integrations/qodbuddy2pi/assets/workbuddy2pi ~/.local/bin/workbuddy2pi && echo same || echo DIFFER
rg -c "killProxyChain" E:/router/integrations/qodbuddy2pi/assets/workbuddy2pi
```

**修法**

2026-11 起 router 的启动、停止、`ocAdd` 和浏览器登录都优先使用
`E:/router/integrations/qodbuddy2pi/assets/` 里的源码，不再需要复制到
`~/.local/bin`。只有你手工在 shell 里敲 `workbuddy2pi` 时，才会用到旧副本：

```bash
cp E:/router/integrations/qodbuddy2pi/assets/{workbuddy2pi,qoder2pi,quota.js,opencode-config.js,tui.js} ~/.local/bin/
```

> 判断「当前实际跑的是哪份」：看 `node router.mjs list` 的进程 PID，再用
> `Get-CimInstance Win32_Process` 看它的 CommandLine；不要只看磁盘上改没改。

**一般化**：**任何「装到别处再调用」的脚本，改完都要确认调用方实际拿到的是哪份。**
调试时优先怀疑「跑的是不是我以为的那份代码」。

---

## P15. 重写用户的 JSONC 会吃掉注释、挪走配置

**症状**

接入 WorkBuddy 之后，Trae 的 provider 从 opencode 里消失了；用户的
`opencode.jsonc` 里的注释也没了。

**真因**

早期实现把 `opencode.jsonc` 也当成可写目标：读出来、改、用 `JSON.stringify` 写回。
后果三个：

1. 注释全丢（JSON 不支持注释）
2. 用户的字段顺序/格式被重排
3. provider 被「挪」到了另一个文件，看起来就像消失

**判断依据**

```bash
# provider 到底在哪个文件里
grep -l trae-local ~/.config/opencode/*.json*
opencode debug config | grep -A3 trae-local
```

**修法**

明确「写哪个、读哪些、删哪个」：

| 操作 | 范围 |
|---|---|
| 写 | 只写 `opencode.json` |
| 读 | `.json` 与 `.jsonc` 都读（否则会误判「没配」而重复添加） |
| 删 | 只删 `.json`；在 `.jsonc` 里的报给调用方，让用户自己处理 |

**一般化**：**用户手写的配置文件只读不写；要写就写自己那份。**

---

## P16. `code 10605 isQueued` —— 并发排队，不是配置坏了

**症状**

Qoder 国际版请求返回：

```json
{"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,
 \\\"modelKey\\\":\\\"qfmodel\\\",\\\"queueCount\\\":0, ...}"}
```

看起来像权限被拒（403），但 `status` 一切正常、凭证有效、模型列表也对。

**真因**

**免费账号的并发上限**。`isQueued: true` + `queueCount: 0` 是「已进入排队但前面没人」的
状态——服务端在排队里挑一个时机给资源。隔十几秒再发同一个请求就能成功。

**判断依据（关键）**

三个特征能把它和真故障区分开：

1. 错误码是 `10605` 而不是 `11128`/`11102`（后者才是配置/权限问题）
2. body 里有 `isQueued` 与 `queueCount` 字段
3. **重试会成功**（间隔 10~20 秒）

如果重试永远失败、且 `queueCount` 一直不为 0，那才可能是真的被限流到不可用。

**但真正的问题是：这个错误根本传不到客户端。**

排队错误藏在 **SSE 信封里**（HTTP 状态是 200，信封的 `statusCodeValue` 才是 403）。
只检查 `response.ok` 是发现不了的。更糟的是：

| 路径 | 早期行为 |
|---|---|
| 流式 | 立刻断连，客户端只看到「上游 403」 |
| 非流式 | 等整条流读完才判断；排队时上游不吐字节 → 客户端 60 秒后静默超时（curl 返回 `000`，连接被重置） |

用户看到的是「什么都没发生」，完全无法判断是配置坏了还是网络断了。

**修法（代理侧，三层都要改）**

1. **识别**：`upstreamError()` 把 10605/isQueued 映射成 `429 + retryable + retryAfter`
2. **信封**：`parseQoderSseLine()` 对信封内的非 200 也走同一套识别
3. **非流式别等整条流**：`collectChat()` 改成逐行读，信封一出现错误就立刻抛，
   并把 `Retry-After` 写进响应头（OpenAI SDK 会照它决定重试间隔）

改完之后，同一个排队错误从「60 秒后静默断连」变成「433ms 返回
`429 Retry-After: 30` + 一句人话」。

**一般化**：

- **403 不一定是「没权限」，也可能是「排队中」。看 body 里的业务码，不要只看 HTTP 状态码。**
- **错误藏在响应体里时，别等整个响应读完再判断**——流式场景下上游可能永远不吐完。
- **代理不该把上游的错误变成「静默超时」**，那是把可诊断的问题变成不可诊断的。

---

## P17. 华为云 `SDK-HMAC-SHA256` 有两处与文档不一致的实现细节

**症状**

自己按华为云官方文档实现签名，一律返回：

```json
{"error_msg":"Incorrect IAM authentication information: Unauthorized","error_code":"APIG.0301"}
```

**真因（两处，必须一起复刻）**

参考 `@huaweicloud/huaweicloud-sdk-core` 的 JS 实现（它被打包在
`extensions/vscode-codebot/out/extension.js` 里）：

1. **CanonicalURI 每段单独 urlEncode 后强制补尾斜杠**
   `/api/v2/chat/completions` → `/api/v2/chat/completions/`

2. **CanonicalHeaders 自带尾 `
`，拼 CanonicalRequest 时又补一个 `
`**
   于是 `SignedHeaders` 前面多了一个空行：

```
POST
/api/v2/chat/completions/

host:xxx
x-sdk-date:xxx
                 ← 多出来的空行
host;x-sdk-date
<payloadHash>
```

另外：**非 PUT/PATCH/POST 的请求，body 要按 `nil` 参与签名**。

**判断依据**

`APIG.0301` 是「签名不对」，不是「凭证不对」。凭证问题会报 `APIG.0201` 或
`Incorrect IAM authentication information: token is not active`。
**先怀疑签名格式，再怀疑 AK/SK。**

**修法**

```js
const ch = names.map(k => `${k}:${h[k].trim()}
`).join('');  // 自带尾 

const cr = [method, canonUri, canonQuery, ch, signed, payloadHash].join('
');
//                                                    ^ ch 已带 
，这里再补一个
```

**一般化**：**大厂 SDK 的签名实现经常和它自己的文档不一致。** 要复刻就用它真正
发布的 SDK 代码，不要照文档写。

---

## P18. `Message role cannot empty` —— pi 默认用 developer 角色

**症状**

CodeArts 网关接进 pi 之后，每次请求都失败：

```
400: {"code":400,"message":"上游 HTTP 400: Message role cannot empty"}
```

但用 curl 直接打同一个模型（`messages: [{role:"system"}, {role:"user"}]`）完全正常。

**真因**

pi 默认把系统提示发成 **`role: "developer"`**（OpenAI 的新写法）。CodeArts 上游只认
`system`/`user`/`assistant`/`tool`，遇到 `developer` 就当成「role 为空」。

**判断依据**

抓一次实际请求体就知道（不用猜）：

```bash
# 用 node 起一个 15 行的转发层把 body 记下来
# → 会看到第一条消息是 {"role":"developer","content":"You are an expert coding assistant..."}
```

**修法**

pi 的 provider 配置里有开关：

```jsonc
{
  "providers": {
    "codearts": {
      "compat": { "supportsDeveloperRole": false }   // ← 改用 system 角色
    }
  }
}
```

opencode 走的是 `@ai-sdk/openai-compatible`，它发 `system`，所以不需要改。

**一般化**：**同一份配置在 pi 上坏、在 opencode 上好的时候，去看两者发的消息格式差异。**
`developer` 角色是 OpenAI 较新的写法，很多国内网关不认。

## P19. pi 的 provider 不是「写进 models.json 就行」——四家归扩展，两家归配置

**症状一**

把 Qoder 反代写进 `~/.pi/agent/models.json`（`baseUrl: http://127.0.0.1:8790/v1`，
`apiKey: qoder-local`），pi 直接报：

```
No API key found for qoder.
```

加 `--api-key qoder-local` 就能用；换成别的 provider 名字也能用。

**真因**

`auth.json` 里已经有同名条目 `qoder`，但它是 **OAuth 凭据**（`type: "oauth"` +
`refresh`/`access`）。pi 的凭据优先级是「`--api-key` → auth.json → models.json 的
apiKey」，auth.json 命中就不会再看 models.json；而这份 OAuth 凭据又没有 provider
扩展来消费，于是报「没有 API key」。**同名 ≠ 冲突报错，是静默地抢走。**
Qoder 的正解是装扩展 `pi-provider-qoder`（`pi install
integrations/qodbuddy2pi/assets/vendor/pi-provider-qoder`），由扩展直连，不进反代。

**症状二**

WorkBuddy 按同一条路写进 models.json 后，模型能列出来，选中一半报：

```
{"code":11102,"msg":"model [auto-chat] service info not found"}
```

**真因**

反代的 `/v1/models` 是包作者按公开资料猜的静态表（见
[01-topology.md](01-topology.md#模型清单取哪个来源)）。WorkBuddy 的真实目录在
`~/.workbuddy/cache/acc-product-config-v*.json`（国际版在 `~/.workbuddy-ai/cache/`），
只有扩展 `workbuddy.ts` 读它。实测国际版静态表 17 个 id 里能用的是
`deepseek-v4.1-flash`、`glm-5.2` 这类**表里根本没有**的；`auto-chat` 表里有、服务端不认。

**修法（本机现状）**

| pi 侧 provider | 谁负责 | 为什么 |
|---|---|---|
| `qoder` / `qoder-cn` | 扩展 `pi-provider-qoder` | 私有协议 + OAuth，auth.json 同名条目抢优先级 |
| `workbuddy` / `workbuddy-global` | 扩展 `~/.pi/agent/extensions/workbuddy.ts` | 模型表必须读桌面端落盘的目录 |
| `trae-local` / `codearts` | `models.json`（`node scripts/pi-models.mjs`） | 没有扩展，反代 `/v1/models` 就是权威 |

扩展注册 provider 时**必须显式给 `apiKey`**（反代不校验，随便一个占位值即可）。
pi 判断「已配置 / not configured」看的是 `provider.auth.apiKey`，只往
`auth.json` 写条目不够：缺这一项时企业级登录选择器会把 provider 标成
`not configured`，模型也不会进入 `available` 列表。2026-11-04 修过一次
`workbuddy.ts` 就是这么漏的。

opencode 没有扩展机制，九家全部走反代配置（`router sync`），但 WorkBuddy 的
模型清单要用 `workbuddy2pi [global] opencode install` 从 pi 里抄——它内部就是
`pi --list-models` 取交集，抄的正是扩展那份目录。

**一般化**：**客户端说「模型不存在」时，先分清是「连不上」还是「目录不对」。
目录不对的典型特征是：清单里有、一用就 11102 / service info not found。
这时候权威来源是官方客户端的落盘配置，不是网关的 `/v1/models`。**

---

## P20. CodeArts 登录报 `DPoP proof has expired` —— 先看系统时钟

**症状**

浏览器 OAuth 走完，回调都拿到了，网关换取 STS 凭据时报：

```
✗ CodeArts 登录未完成：换取凭据失败: 换取凭据失败 HTTP 400:
  {"error_code":"STS5.1804","error_msg":"invalid DPoP proof: 'DPoP proof has expired'"}
```

`login` 普通模式还会先报「已登录」直接跳过，得加 `--force` 才真的重走 OAuth。

**真因**

DPoP proof 的 `iat` 取自**本机时钟**（见 [10-codearts-no-agent.md](10-codearts-no-agent.md)
第 151 行）。本机比华为 STS 慢 8 小时，proof 一出生就被判定过期。
Windows 这边 `w32time` 服务处于 **Stopped + 手动启动**，源是 `Local CMOS Clock`、
`Leap 指示符 3(未同步)`——双系统共用 RTC 时很容易落到这个状态。

**判断依据**

```
w32tm /query /status          # 源是 Local CMOS Clock / 未同步 → 没在跟踪 NTP
Get-Service w32time           # Status: Stopped
node -e "fetch('https://www.baidu.com',{method:'HEAD'}).then(r=>console.log(r.headers.get('date')))"
```

把服务器 `Date` 头和 `Date.now()` 一比，差 8 小时就是它。

**修法**

```powershell
Start-Service w32time
w32tm /resync /force
w32tm /query /status          # 应变成「层次 5 (次引用 - 与(S)NTP 同步)」，源 time.windows.com
```

然后 `node router.mjs login codearts --force`，一次就过。

**一般化**：**任何 OAuth / DPoP / JWT 类报错里出现 `expired`、`iat in the future`、
`invalid_grant`，先怀疑系统时钟，再怀疑代码。** 这类错误码把「时钟不一致」伪装成
「凭据无效」，而错误文案会引导你去重新授权——重新授权一百次也没用。

---

## P21. `login` 说「已登录」，实际 refresh_token 已过期

**症状**

```
$ node router.mjs login codearts
✓ CodeArts Agent 已登录（GT-demo）
```

但调用仍报 `账号 GT-demo 的登录态已失效：refresh_token 已过期`。

**真因**

`loginProvider()` 先查 `authStatus(p)`，只要本地还有一份未到 `expiresAt` 的凭据
就直接跳过（`before.ok && !force`）。**「本地文件没到期」≠「上游还认这份 refresh_token」**
——CodeArts 的 access token 有单独的有效期，refresh_token 可能更早被上游作废。

**修法**：`node router.mjs login <id> --force`。看到上面的业务报错就一律加 `--force`，
不要信 `login` 的跳过判断。

---

## P22. 删掉的账号自己回来了 —— 账号池是按 uid 求并集的

**症状**

```
$ node router.mjs account remove workbuddy c
✓ 已删除账号 c（恩）
... 账号池只剩 a、b
$ node router.mjs account workbuddy        # 换一条命令再看
  1  a   2  b   3  c          ← c 又回来了
```

**真因**

WorkBuddy 账号池不是「目录里有什么就是什么」。`scripts/sync-homes.mjs` 每次
router 运行的首尾都会把**所有 home + 共享库**的 slot 按 uid 求**并集**再写回，
`writeSlots()` 只归档「目标集合里没有的文件」。删掉本地 `c.json` 后，共享库
`.shared-home/workbuddy/sessions/c.json` 与另一套系统里那份仍然存在，下一轮
合并就把它加回目标集合——删除等于没删，只是晚一轮生效。

**修法（已实现）**

删除时登记墓碑，合并阶段先按墓碑剔除：

```jsonc
// .shared-home/tombstones.json
{ "workbuddy": ["<uid>"], "workbuddy-global": [] }
```

`account restore` 与「用同一 uid 重新登录」都会解除对应墓碑。手工恢复的办法也是
删掉墓碑里那一项。

**一般化**：**任何「按集合求并集」的同步机制，删除都不能只删本地那一份。**
要么删掉所有副本，要么显式记录「这是有意删除的」，否则下一次合并必然复活。
判断这类问题最快的办法是**隔一条命令再看一次**——删除后立刻查是看不出来的，
必须等一轮同步跑完。

---

## P23. `login` 成功了，账号却一直显示「需要重新登录」

**症状**

CodeArts 浏览器登录明明成功，`list` 仍提示某账号「需要重新登录」。

**真因**

网关的账号状态里 `<status: error, failures: 12>` 是**上次失败留下的**。重新登录
只换了凭证（`session`），没有清零 `failures` / `last_err`，于是账号一直停在
`status=error`。它不会让请求立刻失败（池里还有别的健康账号），但会让提示长期
失真，人也就不再看这条告警了。

**修法（已实现）**

`loginCodearts()` 在登录成功后调一次 `/admin/api/accounts` 的
`{"action":"clear-errors"}`。这个动作**只清状态、不碰凭证**，所以适合放在登录之后。
判断「是不是真坏了」优先看能否真实调用成功，而不是看这个历史状态字段。

---

## P24. 上游回 200 + `{code:1005}`，中间层翻译成「空回复」

**症状**

ZCode 反代（`zcode-bridge`）日志一切正常，客户端却收到：

```json
{"choices":[{"finish_reason":"stop","message":{"content":null,"role":"assistant"}}]}
```

HTTP 200、没有报错、`usage` 为 null，看起来像「模型不回话」，很容易先去怀疑模型或提示词。

**真因**

Z.ai 网关在「套餐额度用尽」时**仍然回 HTTP 200**，错误只写在响应体里：

```json
{"code":1005,"msg":"exceed quota limit","logid":"..."}
```

`zcode-bridge` 只在非 2xx 时走错误映射，2xx 则当作正常结果透传/翻译；
OpenAI 方言翻译一个没有 `content` 的 Anthropic 消息，就得到 `content: null`。

**修法**

在 `integrations/zcode-bridge/internal/server/server.go` 增加
`relayIfGatewayError()`：读到 2xx 响应体里 `code != 0` 的信封时，按码返回
429/402/400（1005 → 429），消息带 `zcode upstream 1005: exceed quota limit`。
`/v1/messages` 与 `/v1/chat/completions` 两条路径都调用它。
该文件属于 vendored 第三方便码（MIT），本地改动记录在
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

**判断依据**

```bash
curl -s http://127.0.0.1:20131/v1/quota | jq '.errors, .plans'
```

`plans: []` + `empty plan list` 说明这个账号**根本没有套餐**，
不是额度临时用尽。桌面端自己的日志也会写 `hasActiveStartPlan: false`。

**一般化**：**「HTTP 200」不等于「成功」。** 国内很多网关把业务错误放进
2xx 响应体（`{code,msg}`），只按状态码判断的中间层会把它们变成静默失败。
接入新供应商时，务必用一个「必然失败」的请求（额度耗尽、错误模型名）验证
错误路径，而不是只看成功路径。

---

## P25. 桌面端明明登录了，反代却说「没有凭据」——KDF 的平台/用户名不一致

**症状**

ZCode 桌面端正常工作、额度面板有套餐，但 `zcode-bridge` 的 `/health` 写着：

```json
{"accounts":[],"planJwt":{"present":false}}
```

`/v1/quota` 回 `no usable plan credential: run login`；一旦重新 `login`，拿到的是
另一个空账号（`plans: []`），照样不能调用。

**真因**

bridge 用这个 KDF 派生桌面凭据库的解密密钥：

```
sha256("zcode-credential-fallback:<platform>:<homedir>:<username>")
```

两个字符串跟桌面端（Electron）对不上：

| 项 | Electron | Go 实现 |
|---|---|---|
| platform | `process.platform` → `win32` | `runtime.GOOS` → `windows` |
| username | `os.userInfo().username` → `demo` | `user.Current().Username` → `DEMO-PC\demo` |

任一不同，AES-GCM 解密就失败，函数静默返回空串——表现为「没有凭据」。

**修法（已实现，见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）**

`runtimeOS()` 在 Windows 返回 `win32`；`desktopStoreKey()` 剥掉用户名里的
`DOMAIN\` 前缀。

**判断依据**

先用桌面端日志确认它自己认为有套餐：

```bash
grep -h "hasActiveStartPlan\|planCount" ~/.zcode/v2/logs/*.log | tail -3
# "hasActiveStartPlan": true / "planCount": 1  → 凭据是好的，问题在反代侧
```

再看凭据库里的键名：出现 `oauth:bigmodel:*` 说明桌面端登录的是**国内版
bigmodel**，不是 z.ai——这时 `z.ai` 上的空账号永远没有套餐。

**一般化**：**跨进程读加密存储时，「同一个密钥派生」比算法本身更容易出错。**
平台名、用户名形态（带不带域名）、home 路径的写法（`C:\Users\x` vs `C:/Users/x`）
任一处不同，解密就是静默失败。定位时先打印派生输入，别先怀疑密文。

---

## P26. 模型清单「刷新了」但客户端没变 —— sync 只在缺失时写入

**症状**

`node router.mjs sync` 说「配置已与当前开关一致，无需改动」，但 opencode 里某个
provider 的模型数长期不变：ZCode 一直是 1 个，Qoder 国内版还留着上游已停用的 10 个。

**真因**

`doSyncOpenCode` 的职责是「provider 的存在性与开关一致」，逻辑是：

```js
if (want === present) continue;   // 已存在就整段跳过，不碰 models
```

于是上游加/删模型后它什么都不做。**「provider 在不在」和「provider 里的模型对不对」
是两件事，sync 只保证前者。**

**修法**

`node router.mjs models [id...]`：拉各家 `/v1/models` 覆盖 `models`，provider 本体、
baseURL、apiKey 都不动。WorkBuddy 转调 `workbuddy2pi opencode install`（它的表只能
来自 pi 扩展）；用户自管的 `opencode.jsonc` 只提示不改。

**一般化**：**幂等写入的「跳过」条件要写清是跳过什么。** 用「已存在」当跳过条件时，
里面所有字段（模型、限额、鉴权）就永久冻结了。

---

## P27. 网关列出的模型点中就报错 —— 它抄了反代的静态表

**症状**

统一网关 `/v1/models` 里，`workbuddy/gpt-5`、`workbuddy-global/claude-4.0` 这类条目
能选，一调用就 `11102 service info not found` / `11158 not allowed for user type`；
反过来真正能用的 `workbuddy/deepseek-v4.1-flash` 却不在列表里。

**真因**

`gateway/providers.mjs` 的 `modelsOf()` 统一走反代的 `/v1/models`。WorkBuddy 两家
反代的清单是包作者猜的静态表（见 P3），与桌面端产品目录对不上。router 侧早已改成
「读桌面端 `acc-product-config-v*.json`」，但网关是后来加的，没跟上。

**修法（已实现）**

`modelsOf()` 对 `catalogFromDisk: true` 的供应商先读桌面端目录
（`workbuddyCatalogModels`，与 `workbuddy.ts` 同一份过滤规则和 unservable 名单），
读不到才用内置静态表，最后才退回反代清单。国际版没有桌面端目录，走内置静态表。

**判断依据**

```bash
curl -s http://127.0.0.1:8785/v1/models -H 'Authorization: Bearer router-local' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const by={};for(const m of j.data)by[m.owned_by]=(by[m.owned_by]||0)+1;console.log(by)})"
# workbuddy 应与 pi --list-models 里 workbuddy 的行数一致（2026-11 为 36）
```

**一般化**：**同一个「真实来源」的判定逻辑出现在两处时，后加的那处最容易漏。**
网关加进来时只复用了「端口表」，没复用「模型表从哪来」。

---

## P28. 小浣熊「模型 id 写错」不报错 —— 上游静默回落到默认模型

**症状**

在小浣熊（`raccoon`，:8793）上把模型名写成 `raccoon-xxxx`、甚至 `no-such-model`，
请求照样 `200`，回复也正常，但回包里的 `model` 是 `raccoon-090dd3`。看上去像
「路由没生效」，其实是上游接受了任意模型名并回落到桌面端默认模型。

**真因**

`POST /api/web/llm/v2/chat/completions` 不校验 `model` 是否存在于 `model_catalog`。
桌面端自己也只从目录里选，所以这个「宽松」从来没被暴露过。

**修法（已实现）**

`raccoon-proxy.js` 的 `/v1/models` 直接来自 `model_catalog`，客户端只能选到真实
存在的 9 个；`/v1/quota` 的 `multipliers` 也用同一份目录，名字对不上时不会有倍率。

**判断依据**

```bash
curl -s http://127.0.0.1:8793/v1/models \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).data.map(m=>m.id).join('\n')))"
# 再发一次 chat/completions，看回包里的 model 是否等于你请求的那个
```

**一般化**：**「请求成功」不等于「参数生效」。** 遇到「模型像是另一个」的反馈，
先比对回包里的 `model` 字段，而不是怀疑代理转发错了。

---

## P29. `visible: false` 的模型不是不能用

**症状**

`model_catalog` 里 `raccoon-090dd3` / `raccoon-19b265` / `raccoon-405a1c` 都是
`visible: false`，按「隐藏即不可用」的直觉会把它们从 `/v1/models` 剔掉。剔掉之后
桌面端默认模型反而调不了，而 `raccoon-*` 是这家唯一不额外计费的自家模型。

**真因**

`visible` 控制的是**桌面端模型选择器里是否展示**，不是服务端可用性。这三条正是
`category.default_model` 指向的默认模型。

**修法（已实现）**

`catalogToModels()` 保留全部 `type: chat` 的条目，只把 `visible` 原样透出；排序时
把 `default: true` 的放最前。

**一般化**：**目录里的展示标记（visible / hidden / deprecated）与「能不能调」是两件事。**
拿不准时打一发最小请求，而不是靠字段名推断。

---

## P30. 8792 已被前端桥接占用 —— 新反代端口要避开它

**症状**

小浣熊反代一开始选了 8792（网关与 Qoder 之后的空档），启动成功，但前端面板
（`frontend/server/`，桥接固定监听 `127.0.0.1:8792`）再也起不来；反过来先起面板时
反代会 bind 失败。

**真因**

`frontend/docs/00-design-baseline.md` 当初特意挑了 8792 作为「不与任何反代冲突」的
空档，但那份文档写的是「8 家占用 7863/7864/8787/8788/8789/8790/8791/10087/20131/8785」。
新增第九家时没有回头更新这行，于是 8792 从「空档」变成了「冲突点」。

**修法（已实现）**

小浣熊改用 **8793**；`frontend/docs/00-design-baseline.md` 的端口占用清单补上 8793。

**判断依据**

```bash
netstat -ano | findstr :8792    # 有 LISTENING 就不是空档
node router.mjs gateway doctor  # 端口交叉校验只比反代之间，不比前端桥接
```

**一般化**：**「空闲端口」是快照，不是事实。** 加新服务前重新 netstat 一次，并把
新的占用写回那份端口清单——否则下一个人会踩同一颗雷。

---

## P31. 本地限流「看起来生效了」，其实流式请求早就把并发位还了

**症状**

给反代加了并发上限 2，用非流式请求测，6 个并发被正确分成 3 批。但一旦换成
流式对话（`stream: true`），同时开 4 路全都能立刻连上——并发限制形同虚设。

**真因**

`pipeUpstream` 的实现是：

```js
stream.pipe(res);   // 立刻返回
```

`pipe()` 只是把管道接上，函数马上就返回了。调用方据此认为「这一路请求结束了」，
于是把限流执行位还回去——而流其实还在传输，可能持续几十秒。

同理，网关侧 `acc.inFlight` 也是在**响应头到达**时就减了。上游看到的仍然是
N 路并行，这正是「并发限制」要挡的东西。

**判断依据**

流式请求进行中查健康端点，`inFlight` 应该是 ≥ 1：

```bash
curl -s http://127.0.0.1:8793/health \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).limits))"
# 修之前：inFlight=0（流还在传，但计数已经归零）
# 修之后：inFlight=1~2
```

**修法（已实现）**

`pipeUpstream` 改成返回 Promise，在 `res` 的 `finish` / `close` 或 `stream` 的
`error` 时才 resolve。网关侧的 `finishAttempt()` 放进 `relay()` 的 `finally`。

**一般化**：**「函数返回了」不等于「这件事做完了」。** 所有基于「请求生命周期」
的记账（并发、连接池、配额占用），都要挂在真正的完成事件上，而不是启动事件上。
`pipe()` / `write()` / `flush()` 这类名字里带「开始」意味的 API 尤其容易骗人。

---

## P32. 限流把正常 agent 循环误伤成 429

**症状**

加了本机限流后，简单的单轮对话一切正常，但让 agent 做一次稍微复杂的任务就频繁
`429 本地限流`。上游额度明明充足，账号也正常。

**真因**

第一版把 `rpm`（每分钟请求数）压到 12、`minIntervalMs` 给到 4000ms，理由是
「人不会一秒发好几个请求」。但 **agent 循环不是人在打字**：模型回完最后一段，
客户端立刻发下一个工具调用，间隔只有几百毫秒。一轮复杂任务 30~50 步很常见，
按 12 rpm 算，第 13 步就会被自己挡住。

**判断依据**

```bash
node router.mjs gateway usage --days 1   # 看单轮任务的请求密度
```

一次任务几十次请求、每次间隔 300~800ms，就是典型的 agent 循环。

**修法（已实现）**

`rpm` 放宽到 20（safe）/ 40（balanced）/ 90（fast），`minIntervalMs` 降到
1500~3000ms。真正收紧的是**并发**——套流的特征是「同一账号 N 路并行」，
不是「连续发了 40 个请求」。

**一般化**：**限流的参数要按「真实使用形态」定，不是按「人的直觉」定。**
写限流前先量一遍正常使用的请求密度；否则第一个被限流挡住的就是自己。

---

## P33. 只给网关加限流，客户端直连反代就绕过去了

**症状**

网关里设了 `maxInFlight: 2`，经网关的请求确实被限住了。但 opencode 里配的是
`http://127.0.0.1:8793/v1`（直连反代），并行跑子代理时上游照样收到 10 路并发。

**真因**

网关是**可选叠加层**，不是必经之路。每家反代都有自己的端口，客户端可以直连。
限流只做在网关，等于只挡住了「愿意走网关的那部分流量」。

**判断依据**

```bash
node router.mjs list    # 看客户端实际配的是哪一层
grep -r "8793\|8785" ~/.config/opencode/opencode.json
```

**修法（已实现）**

三层都做：

1. 反代自身（`raccoon-proxy` / `loomy-proxy`）的 `LIMITER`
2. 网关的 `scheduler.limiterFor(id)`
3. 第三方反代内置限流（`router limits --apply`，目前只有 CodeArts）

**一般化**：**在「可以绕过」的架构里，防护必须放在最内层。** 只在外层做的限制，
等价于「建议」而不是「约束」。