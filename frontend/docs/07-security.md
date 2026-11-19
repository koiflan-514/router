# 07 安全与隐私

状态：设计基线（文档阶段，尚未实现）
对应需求：NFR-105/106/110
适用范围：`frontend/` 桥接服务（`frontend/server/`）、浏览器控制台、日志与任务输出、构建与依赖、只读与演示模式
上位依据：[00 设计基线](00-design-baseline.md) §11/§12、[`tui/docs/07-security.md`](../../tui/docs/07-security.md)、
[`gateway/README.md`](../../gateway/README.md)

本文把 `tui/docs/07-security.md` 的威胁模型、脱敏要求与"秘密不回流"原则**原样继承**，并针对网页面板
新增的攻击面（HTTP 监听、浏览器渲染、npm 供应链、CSRF/XSS）给出防线。本文与 [00 设计基线](00-design-baseline.md) §12
不冲突，只把每条不变量展开为可实现、可测试的规则。

## 1. 安全目标

1. 不因引入网页面板而新增**凭证泄露渠道**：本机凭证、网关 key、上游 key 都不进入浏览器、
   JSON、日志或仓库。
2. 不允许界面输入演变成**任意命令执行**：Action 是固定白名单，provider/账号参数必须命中白名单。
3. 不因日志内容触发**浏览器脚本、样式或误导性显示**（XSS、控制序列注入、伪造状态）。
4. 不允许**本机其他程序或外部网页**借桥接的监听端口驱动本机控制能力（DNS rebinding、CSRF）。
5. 不因刷新、轮询、SSE 或重试产生**未确认的副作用**；只读与演示模式在桥接层强制。
6. 第三方依赖数量与许可证**有预算、可审计**，且 `node_modules`、构建产物不入库。

## 2. 威胁模型

### 2.1 资产

| 资产 | 位置 | 泄露或失控的后果 |
|---|---|---|
| 本机各反代账号凭证 | `~/.pi/agent/auth.json`、`~/.codebuddy-session*.json`、`integrations/*/data/` | 订阅额度被顶替使用、账号被封 |
| 网关调用密钥 `keys.json` | `gateway/data/keys.json`（仅 SHA-256） | 他人可调用本网关，消耗本机额度 |
| 上游供应商 key `providers.json` | `gateway/data/providers.json`（AES，`.vault-key` 同目录） | 上游 key 被拿走，直接计费损失 |
| 上游额度与配额 | 各厂商账号、网关额度快照 | 额度被偷跑 |
| **进程控制权** | 能 spawn `node router.mjs …` 的桥接 | 起停/切换本机服务，是最高危能力 |

> `keys.json` 与 `providers.json` 是**两个方向**的凭据（"谁能调用本网关" / "本网关如何调用上游"）；面板只允许**元数据与掩码**出现在 UI，明文一律不经过浏览器。

### 2.2 信任边界

```text
浏览器（不可信渲染层：输入、URL、日志文本、第三方依赖注入面）
   ↓  同源 fetch + x-panel-token；写请求再校验 Origin/Referer
桥接服务（受信控制层，仅 127.0.0.1，做脱敏/清理/白名单/只读拦截）
   ↓  参数数组 spawn（固定 argv 模板）
CLI / 网关（既有受信控制层：router.mjs、gateway/）
   ↓
本机配置、凭证、反代进程、厂商接口
进程日志 / 网关错误 / 用量文本（不可信文本）
   ↓  控制序列剥离 + 密钥脱敏 + 长度上限
浏览器纯文本渲染（React 默认转义，无 HTML 注入）
```

- 浏览器永远视为**不完全可信**：同源政策与 CSP 是最后一道墙，不是唯一一道墙。
- CLI 与网关沿用它现有的安全语义，本面板**不改写**它们的信任假设（见 00 §2 非目标）；
  本机用户本身已有相当权限，面板不追求成为 OS 沙箱，但必须避免**扩大**影响面。

### 2.3 攻击者与威胁／缓解

| 资产 | 威胁 | 缓解 |
|---|---|---|
| 进程控制权 | 同机**低权限进程**直接 `POST /api/actions` 起停服务 | 一次性随机 token（§4）；写端点强制 Origin/Referer；写任务全局串行 + 高危确认；审计每次写操作的来源 |
| 网关/上游 key | **恶意网页**经浏览器向 `127.0.0.1:8792` 发跨站请求（CSRF） | Cookie `SameSite=Strict`；写端点只接受同源 + 自定义头（预检拦截简单请求）；`connect-src 'self'` |
| 一切本机能力 | **DNS rebinding**：攻击者域名解析到 `127.0.0.1` 绕过同源 | 严格校验 `Host` 头必须为 `127.0.0.1:8792`/`localhost:8792`；校验 `Origin`；`Host` 不匹配一律 421/403 |
| 浏览器会话 | **XSS** 经日志/账号文本注入脚本 | 日志/账号文本走纯文本渲染，禁 `dangerouslySetInnerHTML`；严格 CSP（§7）；控制序列剥离（§6） |
| 本机凭证/额度 | **恶意 npm 依赖**（`postinstall`、供应链投毒）窃取文件或外联 | 依赖预算 + 锁版本 + `--ignore-scripts` 审慎评估 + `npm audit`/provenance（§9）；桥接不把秘密交给前端 |
| 展示可信度 | **被注入的日志文本**伪造成功/掩盖失败 | 清理后的文本只作纯文本；状态一律来自结构化字段，不由文本解析（00 §13） |
| 上游 key / 账号隐私 | 桥接代理错误地把 `Authorization` 回显给浏览器；UI/JSON 出现真实邮箱、UID、凭证绝对路径 | 网关代理**逐字段白名单**转发；响应剥离 `set-cookie`/上游密钥头（§8.2）；数据最小化禁含清单（§8.1） |
| 上游额度 | 演示或只读模式下仍触发真实写/真实文件访问 | `--read-only`/`--demo` 在**桥接层**短路，写与真实 IO 一律拒绝（§8） |
| 交互登录秘密 | `login`/`account add` 的 stdin 秘密被桥接读取或回传 | 秘密只在用户原生终端输入，桥接不读 stdin（§10） |

## 3. 桥接监听与来源控制

- **只监听 `127.0.0.1:8792`**（dev 时 Vite `127.0.0.1:5173` 代理到桥接）。禁止 `0.0.0.0`、`::`、
  以及任何"监听全部网卡"的等价写法。
- 无 **"开放到局域网"/"仅 WLAN 调试"** 开关。任何"临时放开"的诉求都走另行提案，不进入 MVP。
- 进入请求的统一前置校验：

  | 校验 | 规则 | 失败 |
  |---|---|---|
  | `Host` | 必须匹配 `127.0.0.1:8792` / `localhost:8792`（dev 为 5173） | `421 Misdirected Request` |
  | 远端地址 | 必须是回环（`127.0.0.1`/`::1`） | `403` |
  | `Origin` / `Referer`（有则校验） | 同源或 `null`（同源导航）；写请求必须**同源** | `403` |
  | 方法与体积 | 写端点只允许预期方法；请求体 ≤ 约定上限 | `405` / `413` |

- `Host` 校验是**防 DNS rebinding 的关键**：攻击者页面即使解析到 `127.0.0.1`，也会因 `Host`
  为攻击者域名而被拒；响应统一带 `Cache-Control: no-store`。

## 4. 认证与 CSRF

- 桥接**启动时生成一次性随机 token**（≥128 bit，`crypto.randomBytes`），仅存于进程内存。
- token 经**同源页面注入**：写入 `index.html` 的 `<meta name="panel-token">`（见 05 §8）；前端读入内存后
  不落 `localStorage`/`sessionStorage`/IndexedDB，刷新后由桥接重新注入。
- 所有 `/api/*` 请求携带请求头 `x-panel-token`，值必须与内存 token 常量时间比较相等；**写请求**在
  token 之外**额外**要求同源 `Origin` 匹配，二者缺一即 `403`（对齐 05 §8）。自定义头 + 同源
  `Origin` 构成双重 CSRF 防线：跨站"简单请求"无法带自定义头，带自定义头会先触发 CORS 预检，
  而桥接**不返回**放行跨站的 CORS 头。
- Cookie（若用于 token 传递）一律 `SameSite=Strict; HttpOnly; Path=/`；MVP 以 `x-panel-token` 请求头为主。
- 读端点同样校验 token（05 §8）；非回环来源或 `Host` 不匹配时在读校验之前即拒绝。

**token 的三条禁令**：**不落盘**（不写文件、不写 `keys.json`/`config.json`、不进 SQLite）；
**不写日志**（请求日志只记 `x-panel-token: <redacted>` 或省略该头）；**不进 URL**
（不放入 query string/path，避免落进浏览器历史与上游日志）。

## 5. 命令注入防线

- **一律参数数组 spawn**：`spawn(process.execPath, [scriptPath, ...argv], { shell: false })`，显式
  `shell: false`；**禁止** `sh -c`、`cmd /c`、`powershell -Command`、`exec`/`execSync` 字符串重载，
  以及任何 `"cmd " + userInput` 形式的拼接。
- 可执行文件与脚本路径**写死在代码里**（`router.mjs`、`gateway/cli.mjs`、既有的
  `scripts/health.mjs`），不从 UI 或后端字符串构造路径。
- **Action 是固定白名单**，不接受任意命令、任意参数；映射表形如：

  ```js
  // argv 为固定模板；参数只能来自白名单校验后的 providerId / accountKey 与受限数值
  const ACTIONS = {
    Start:             (id) => ['up', id, '--no-login'],
    Stop:              (id) => ['down', id],
    StopKeepOpenCode:  (id) => ['down', id, '--keep-oc'],
    Restart:           (id) => ['restart', id, '--no-login'],
    OnlyEnable:        (ids) => ['on', ...ids, '--no-login'],
    Disable:           (ids) => ['off', ...ids],
    EnableAll:         ()   => ['all', '--no-login'],
    DisableAll:        ()   => ['none'],
    Sync:              ()   => ['sync'],
    SwitchAccountPreview: (id, key) => ['account', id, key, '--dry-run', '--json'],
    SwitchAccount:     (id, key) => ['account', id, key, '--json'],
    EnableAllAccounts: (id) => ['account', id, '--all', '--json'],
    // Probe 走 scripts/health.mjs，**从不**自动触发（见 00 §8）
    Probe:             (ids) => [healthScriptPath, ...ids],
    // Login / AddAccount 见 §10：不由桥接代执行
  };
  ```

- **provider id 白名单**：必须是 00 §4 登记的 9 家（`qoder-cn, qoder, trae-local, codearts,
  zcode, workbuddy, workbuddy-global, loomy, raccoon`）或 `gateway`；其余一律拒绝。未知 id 默认只读。
- **account key 白名单**：只能取自最近一次 `account <id> --json` 返回的 `accounts[].key`，
  不接受自由文本。
- **数值范围限制**：`lines ∈ [1, 2000]`、`days ∈ [1, 90]`、`range ∈ {24h,7d,30d,all}`，
  在桥接侧用整数解析 + 区间校验，不直接透传。
- 后台执行 `up/on/all/restart` 时**必须**带 `--no-login`，禁止自动打开浏览器（00 §3 约定），
  与 05 §4.4 的动作表逐条对齐；进程清理由现有 router 负责，桥接不使用模糊进程名/端口去杀进程。

## 6. 输出与展示安全

### 6.1 控制序列剥离

日志、任务 stdout/stderr、网关错误文本在**返回浏览器之前**必须：

- 剥离 ANSI：CSI（`\x1b[…m` 等）、OSC（`\x1b]…BEL/ST`）、DCS/SOS/PM/APC 等控制序列；移除除 `\n`
  与必要 `\t` 外的 C0/C1 控制字符；不允许日志改写页面标题、剪贴板、焦点或触发外部协议；
  超长行做可见截断；
- **有界**：默认 ≤2000 行、单行 ≤ 约定的字符上限、总量 ≤ 约定的字节上限，截断处显式标注"已截断"。

"看原始字节"不是 MVP 功能；需要完整原始日志时，提示用户使用既有 CLI/文件。

### 6.2 密钥脱敏（示例，匿名）

脱敏是**纵深防御**，不替代"后端不输出秘密"，采用字段级 + 模式级组合，避免单条万能正则：

| 模式 | 目标 | 替换 |
|---|---|---|
| `Bearer <token>` | Authorization 头 | `Bearer ***` |
| `sk-…` / `zsk_…` / `pt-…` / `ghp_…` 等前缀密钥 | 常见供应商 key | 保留前 3–4 字符 + `***` |
| `"access_token":"…"` 等 JSON 字段 | 结构化秘密字段 | 值替换为 `***` |
| `?token=…&key=…&signature=…` | URL query 秘密 | 值替换为 `***` |
| 已知 CodeArts/Qoder/Trae/WorkBuddy 令牌形态 | 平台特有令牌 | 整体掩码 |

```js
// 示例实现（示意，非最终代码）；在桥接层对每个文本块执行一次
const MASK = '***';
const RULES = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],                    // Authorization
  [/\b(?:sk|zsk|pt|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,}/gi,       // 常见密钥前缀
    (m) => `${m.slice(0, 3)}${MASK}`],
  // JSON/表单字段：token、api_key、secret、session、cookie、signature、hmac、password
  [/((?:"?(?:access_token|refresh_token|api[_-]?key|token|password|secret|session|cookie|signature|hmac)"?\s*[:=]\s*"?))[^",\s}]{4,}/gi,
    `$1${MASK}`],
  [/([?&](?:token|key|api[_-]?key|access_token|signature|sig|code)=)[^&\s#]+/gi,
    `$1${MASK}`],                                                            // URL query
];
function scrub(text) {
  let out = stripControlSequences(text);           // §6.1
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return clip(out);                                // 长度上限 + "已截断" 标记
}
```

- 可能误伤普通文本时**优先安全**，并在实现说明中记录，不追求"精确还原"；日志缓冲、任务缓冲、
  SSE 回放缓冲都必须**有界**（行数 + 字节双上限），防止内存耗尽。

### 6.3 React 渲染

- 依赖 React 的默认转义渲染所有来自 `data` 的字符串；**禁止**对日志/账号/路径/任务输出使用
  `dangerouslySetInnerHTML`、`innerHTML`、`insertAdjacentHTML`；需要富文本时先做白名单清洗
  并单独评审，MVP 不提供富文本日志。
- URL 即状态（00 §5）：search params 是不可信输入，仅作查询键与筛选值，不拼进 HTML；
  任何由数据生成的链接先校验协议（仅允许 `http:`/`https:`，拒绝 `javascript:`/`data:`）；
  前端**不假定**桥接已脱敏，渲染层仍按不可信文本处理（纵深防御）。

## 7. CSP 与其他响应头

桥接（生产站点）与 Vite preview 对 HTML 文档统一下发：

```text
Content-Security-Policy:
  default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; worker-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=()
Cache-Control: no-store
```

要点：

- `default-src 'self'` + `script-src 'self'`：**禁内联脚本**、禁 `eval`、禁第三方 CDN；
  样式与脚本一律外置为同源文件，沿用
  [`codearts2api/docs/adr/0002-console-strict-csp.md`](../../integrations/codearts2api/docs/adr/0002-console-strict-csp.md)
  采纳的"去掉 `unsafe-inline`、拆为外置文件、加回归守卫"做法。
- `connect-src 'self'`：所有 fetch/EventSource 只打同源 `/api`，浏览器**不直连**网关
  （网关无 CORS，见 00 §3.2）；`img-src 'self' data:` 仅允许同源图片与内联小图标，
  不加载远程图片（避免外联泄露与像素追踪）；`frame-ancestors 'none'` + `X-Frame-Options: DENY`
  防止被其它页面 iframe 包裹后诱导点击。
- **已知取舍**：若 Radix/shadcn 组件把内联 `style` 属性写进 HTML 标记，`style-src 'self'` 会拦截；
  届时优先改为类名（同 ADR 0002），必要时才放宽为 `style-src-attr 'unsafe-inline'` 并**在本文
  记录原因**；`script-src` 的 `'unsafe-inline'` 在任何情况下都不放宽。开发模式（Vite dev，HMR）
  允许更宽的来源，但**仅绑定 `127.0.0.1:5173`**，且不得把开发配置带入生产构建；生产校验必须
  断言 CSP 不含 `unsafe-*`（回归测试项，见 09 测试策略）。

## 8. 数据最小化

### 8.1 JSON 与日志禁含清单

桥接返回给浏览器的任何 JSON、SSE 事件、错误消息与 agent 日志**禁止**包含：

- access/refresh token、PAT、API Key、`Authorization` 头；完整 session/cookie；签名与 HMAC 输入
  （含"待签字节"）；解密材料（`data/.vault-key`、KDF 中间值、明文上游 key）；提示词与响应正文；
- **真实邮箱与 UID**：`Account.uid` 字段名保留（与 00 §6 不冲突），但**值必须脱敏**为掩码或等价的
  不可逆占位（示例：`uid: null` 或 `u-****-1f`）；`name`/`detail` 若夹带邮箱同样掩码；
- **凭证绝对路径与网关密钥明文**：不返回 `C:\Users\…`、`/home/…` 这类个人路径，需要区分时用逻辑
  标识（如 `pi-auth`、`gateway-vault`）代替；`gateway key add` 返回的 secret 只在当次响应出现一次，
  **不落缓存、不进日志、不再回传**（05 §9.2）。禁止项还包括把上述内容写进 fixtures、测试快照、
  CI 日志或提交信息；匿名示例沿用 `example-user`、`slot-a`、全零加序号 UUID、示例端口与虚构时间。

本节清单与 [05 后端契约](05-backend-contract.md) §9.2「禁止进入契约的数据」互为补充。

### 8.2 网关代理白名单

代理 `gateway/` 时：**请求**只转发面板明确需要的端点与字段，**不转发**浏览器自带的 `Cookie`、
`Origin`、`Authorization`、`x-panel-token`；**响应**只回传面板需要的字段（调度快照、用量聚合、
额度、combo、local-answers、free），剥离 `set-cookie`、上游 `authorization`/密钥头与任何上游
凭据；错误消息先经 §6 清理。

### 8.3 只读与演示模式（桥接层强制）

- `--read-only`：桥接在路由层**短路**所有写端点，返回 `403 READ_ONLY`（错误码见 05 §7）；前端隐藏
  按钮只是 UI 辅助。
- `--demo`：桥接改用匿名 fixtures，**不 spawn 任何进程、不访问真实文件、不连真实网关**，
  与真实后端完全隔离，不能通过参数组合意外访问真实 root 或真实凭证；写端点返回
  `403 DEMO_FORBIDDEN`（05 §8）。
- SSE 在只读/演示下同样只推匿名/只读数据；轮询与 SSE 跟随**永不**触发写操作、登录、签到、
  重启或真实试打（对齐 00 §8）。

## 9. 依赖供应链

- **依赖预算**：直接运行依赖保持精简（目标：框架 + 路由 + 数据层 + UI 原语 + 图表/表格 + Zod）。
  新增直接依赖需说明用途、维护状态、平台支持与许可证影响，且不引入重复职责的库；构建期依赖与
  运行期依赖分开记账，与根目录"零依赖"核心明确区分（见 00 决策索引 W-09）。
- **锁定版本、审计与安装脚本**：提交 `package-lock.json`，CI 用 `npm ci` 而不是 `npm install`，
  不使用漂移的 `latest`/`^*` 区间作为唯一约束；CI 跑 `npm audit --omit=dev`（或等价）并在有高危项
  时失败；对关键依赖启用 provenance 校验（npm `--provenance` / Sigstore attestation）并记录结论；
  `npm ci` 默认执行 `postinstall`，属供应链风险面，新增带安装脚本的依赖必须单独评审，必要时用
  `--ignore-scripts` 并验证其产物。
- **许可审计**：新增依赖（含其传递依赖）的许可证必须与仓库兼容（MIT/Apache-2.0/BSD 等），
  并在根 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 同步登记（含来源、版本、
  许可证与必要声明）。**不入库**：`frontend/node_modules/`（已由根 `.gitignore` 覆盖）与
  `frontend/dist/` 构建产物一律不入库（需确认 `dist/` 被忽略）；桥接的未知密钥/配置不落盘，
  CI 不下载、不执行未知第三方脚本来"简化构建"。

## 10. 交互式登录的秘密不回流浏览器

- `login <id>`、`account add <id>` 是**交互式**动作，其 stdin（验证码、设备码、密码、PAT）
  **只能在用户自己的原生终端**输入与完成。
- 桥接**不**为这两个动作申请 PTY、**不**代理 stdin、**不**解析交互输出中的秘密；它只提供固定
  命令指引（"请在原生终端执行：`node router.mjs login <id>`"）与"等待外部完成"状态，并支持取消。
- 用户在原生终端输入的秘密不得经桥接回到浏览器：不显示、不缓存、不进日志、不进 SSE 事件；
  交互输出在被展示前仍须经 §6 清理与脱敏，退出码与结构化状态与输出文本分离。这与
  `tui/docs/07` §4 "登录输入由交互式 Node 子进程接收，前端不记录 stdin" 保持一致。

## 11. 与 00 设计基线 §12 的对应

| 00 §12 不变量 | 本文落点 |
|---|---|
| 1. JSON 禁含 token/PAT/Authorization/session/签名/解密材料/提示词/正文 | §8.1 禁含清单、§6.2 脱敏 |
| 2. 命令一律参数数组 spawn，禁 `sh -c`/`cmd /c`/PowerShell | §5 |
| 3. 只监听回环，非回环一律拒绝，无"仅 WLAN 调试"开关 | §3 |
| 4. 只读/演示在桥接层拦截，不靠前端隐藏 | §8.3 |
| 5. 不改写 `router.mjs`/`gateway/`/`tui/` 现有语义 | §5、§8.2（只包装与代理，不侵入） |

补充但**不冲突**的两条（NFR-105/106/110 推进）：§4 的 token/CSRF 细则与 §7 的 CSP 响应头；§8.1 对
`uid`/邮箱/绝对路径的掩码要求是在保持 00 §6 字段名不变的前提下约束**值**。桥接因此**只包装、只代理**，
不解释/重写 CLI/网关语义，不继承它们信任假设之外的新风险。

## 12. 安全检查清单（发布前逐项确认）

- [ ] git diff 中没有真实凭证、账号、UID、邮箱、日志或个人绝对路径。
- [ ] 桥接仅绑定 `127.0.0.1`；`Host`/`Origin`/回环校验均生效，无局域网开关；写端点要求
      `x-panel-token` + 同源 `Origin`，且 token 不落盘、不写日志、不进 URL。
- [ ] 所有命令为参数数组 spawn，`shell: false`；无 `sh -c`/`cmd /c`/PowerShell 拼接；Action 与
      provider/账号参数均经白名单校验，数值参数在桥接侧限幅。
- [ ] 日志/任务/错误输出经控制序列剥离与密钥脱敏，且有行数与字节上限；前端无
      `dangerouslySetInnerHTML` 用于日志/账号/路径文本，数据链接校验协议。
- [ ] HTML 文档下发严格 CSP（无 `unsafe-inline` 脚本）与 `nosniff`/`Referrer-Policy`/`frame-ancestors`。
- [ ] JSON/SSE/错误消息满足 §8.1 禁含清单；网关代理按白名单转发与回传。
- [ ] `--read-only` 与 `--demo` 在桥接层拦截，且不 spawn 进程、不读真实文件。
- [ ] `package-lock.json` 已提交，CI 用 `npm ci`；`npm audit` 与许可证检查通过，
      新依赖已登记进 `THIRD_PARTY_NOTICES.md`；`node_modules/` 与构建产物未入库。
- [ ] `login`/`account add` 的秘密只在原生终端输入，未回流浏览器或日志。

## 13. 禁止事项

- 禁止把桥接监听改成非回环，或以任何形式提供"开放到局域网/公网"的开关；禁止把 provider
  title、账号名称、日志文本当作可执行路径或文件名。
- 禁止以 `sh -c`/`cmd /c`/PowerShell 字符串拼接执行 UI 或后端传来的内容；禁止提供
  "任意命令/任意参数"的 Action 或"高级 Shell"页面。
- 禁止把 token/PAT/`Authorization`/session/cookie/签名/解密材料/提示词/响应正文
  放进 JSON、SSE、URL、日志或 fixtures。
- 禁止对日志/账号文本使用 `dangerouslySetInnerHTML` 或任何 HTML 注入路径；禁止在 CSP 中为
  `script-src` 添加 `'unsafe-inline'`/`'unsafe-eval'`，或引入第三方 CDN 脚本。
- 禁止让前端"直连"网关（绕过桥接）、让浏览器持有上游 key，或在演示/只读模式下触碰真实
  进程、真实文件或真实凭证。
- 禁止把 `frontend/node_modules/`、`frontend/dist/` 或任何含密钥的文件提交入库。

## 14. 相关文档

- 桥接端点与职责划分：[05 后端契约](05-backend-contract.md)、[04 技术架构](04-architecture.md)
- 运行/端口/部署与安全回归项：[08 运行与部署](08-operations.md)、[09 测试策略](09-testing.md)
- 术语与上位基线：[12 术语表](12-glossary.md)、[`tui/docs/07-security.md`](../../tui/docs/07-security.md)、[`gateway/README.md`](../../gateway/README.md)（密钥两方向与回环语义）、CSP 先例 [`ADR 0002`](../../integrations/codearts2api/docs/adr/0002-console-strict-csp.md)
