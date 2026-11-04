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
pi 不可用才退回反代的表。国际版因此从 17 个变成 26 个可用。

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

opencode 没有扩展机制，六家全部走反代配置（`router sync`），但 WorkBuddy 的
模型清单要用 `workbuddy2pi [global] opencode install` 从 pi 里抄——它内部就是
`pi --list-models` 取交集，抄的正是扩展那份目录。

**一般化**：**客户端说「模型不存在」时，先分清是「连不上」还是「目录不对」。
目录不对的典型特征是：清单里有、一用就 11102 / service info not found。
这时候权威来源是官方客户端的落盘配置，不是网关的 `/v1/models`。**
