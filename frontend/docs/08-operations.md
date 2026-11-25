# 08 运行与部署

状态：设计基线（文档阶段，尚未实现）
适用范围：`frontend/` 网页面板的本地运行、四种模式、端口校验、升级回滚与排障
对应需求：NFR-101（本机运行、可诊断）/ NFR-104（安全边界不因部署方式退化）/ NFR-110（可运维、可回退）

本文只规定**运行方式**，不重复页面交互（见 [03 界面设计](03-ui-design.md)）与桥接端点细节
（见 [05 后端契约](05-backend-contract.md)）。面板不改动根目录 `router.mjs`、`gateway/`、`tui/`
的任何行为：它只是又一个消费者，与 CLI / TUI 并列。

## 0. 命令标注约定

**现有命令**：当前仓库可直接执行（`node router.mjs *`、`node gateway/*.mjs`、`node scripts/health.mjs`）。
**计划命令**：实现阶段落地，**当前执行会失败**，仅作为验收目标 —— 本文所有 `npm run *` 与
`node frontend/server/*` 都属于这一类。

## 1. 运行前置

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **建议 ≥ 20**；本机实测 `v26.13.0` | 桥接与 Vite 都是 Node 程序；`router.mjs` 本身也要求 Node |
| 仓库根 | 含 `router.mjs` 的目录（本机示例 `D:\router`） | 桥接据此 spawn CLI、读 `router.json`；不写死绝对路径 |
| 浏览器 | Chromium / Firefox / Safari 最新稳定 | 普通单页应用，不要求扩展或特殊权限 |
| 13 家反代 / 统一网关 / OpenCode CLI | **均可选** | 只影响服务、网关、用量页的数据来源；缺失时显示"未运行/不可用"，不升级为全局失败 |

- 首次安装（计划命令）：`cd D:/router/frontend && npm install`（依赖不入库，见 §5）。
- 前置自检（现有命令）：

```bash
node router.mjs doctor             # 命令、工作目录、凭证、端口、opencode
node router.mjs gateway doctor     # 网关自检 + 与 PROVIDERS 的端口交叉校验
node scripts/health.mjs --no-probe # 无试打的十三家体检（只读）
```

缺 Node 时不能用真实后端；此时仍可用 §3 的**演示模式**验证界面，但演示模式不代表任何真实状态。

## 2. 端口与进程

### 2.1 端口一览

| 用途 | 地址 | 状态 |
|---|---|---|
| 桥接 + 静态站点（生产） | `127.0.0.1:8792` | 计划 |
| Vite dev server | `127.0.0.1:5173` | 计划（Vite 默认） |
| 统一网关 | `127.0.0.1:8785` | 现有 |
| `qoder-cn` | `127.0.0.1:8789` | 现有 |
| `qoder` | `127.0.0.1:8790` | 现有 |
| `trae-local` | `127.0.0.1:7863`（内部 `tw2api` `:7864`） | 现有 |
| `workbuddy` | `127.0.0.1:8787` | 现有 |
| `workbuddy-global` | `127.0.0.1:8788` | 现有 |
| `codearts` | `127.0.0.1:10087` | 现有 |
| `zcode` | `127.0.0.1:20131` | 现有 |
| `loomy` | `127.0.0.1:8791` | 现有 |

面板选取 `8792` / `5173` 的依据：8792 落在网关与两家 Qoder（8789/8790）**之外**的空档，
5173 是 Vite 默认且与全部反代不重叠。两者都只绑定回环。

### 2.2 无冲突校验（复用 `gateway doctor` 思路）

`node router.mjs gateway doctor` 的做法值得照搬：**拿"进程实际会用的端口"与"配置表里写的端口"
逐条比对**，而不是靠人记。面板侧校验 = 取 `list --json` 的 `providers[].port`，加上固定端口
`8785`（网关），再断言 `8792`、`5173` **不在**该集合内；命中则启动前拒绝并打印冲突来源。

```bash
node router.mjs list --json           # 现有：十三家与网关的实际端口
node router.mjs gateway status --json # 现有：网关调度与端口
npm run ports:check                   # 计划：8792/5173 不在上述集合内才通过
```

若无法运行脚本，用系统工具确认端口未被占：`netstat -ano | findstr :8792`（Windows）、
`ss -ltnp | grep 8792`（Linux）。

### 2.3 进程模型

- **桥接**是唯一的常驻进程，自己只监听一个端口（生产 8792）。
- 桥接**不托管** 13 家反代与网关：这些进程仍由 `router.mjs` 管（`up/down/restart/…`），
  关掉面板不影响任何反代，停掉反代也不影响面板显示"进程未运行"。
- 关闭标签页**不会**停止桥接：需要 `Ctrl+C`（前台）或显式停进程（见 §10）。

## 3. 运行模式

| 模式 | 命令（计划） | 访问地址 | spawn CLI | 读真实文件 | 允许写 |
|---|---|---|---|---|---|
| 开发 | `npm run dev`（+ 桥接） | `http://127.0.0.1:5173` | 是 | 是 | 是 |
| 生产 | `npm run build` + `npm run start` | `http://127.0.0.1:8792` | 是 | 是 | 是 |
| 演示 | `npm run start -- --demo` | `http://127.0.0.1:8792` | **否** | **否** | 模拟 |
| 只读 | `npm run start -- --read-only` | `http://127.0.0.1:8792` | 是 | 是 | **拦截** |

### 3.1 开发模式

Vite dev server 提供热更新与源码映射；`/api` 经 **Vite proxy** 转发到桥接（同源，避免 CORS
与 token 头跨源问题）。Vite 只跑前端，**桥接要另外起**（计划命令）：

```bash
npm run bridge                 # 终端 A：node server/index.mjs --router-root . --port 8792
npm run dev                    # 终端 B：http://127.0.0.1:5173
npm run dev:all                # 一条命令并发起上面两个
```

- 只跑 `npm run dev` 而不起桥接时页面能打开但 `/api` 全部失败（见 §7）；proxy 目标固定
  `http://127.0.0.1:8792`，改桥接端口必须同时改 `vite.config.ts` 与 `ROUTER_PANEL_PORT`，
  两者不一致是"白屏 + 控制台一堆 502"的常见原因。

### 3.2 生产模式

```bash
npm run build                  # 计划：产物 -> frontend/dist/
npm run start                  # 计划：同源托管 dist/ 与 /api -> http://127.0.0.1:8792
```

- 生产模式**同源**：静态站点与 `/api` 都由桥接提供，因此 `x-panel-token` 与 `SameSite=Strict`
  cookie 天然同源，不需要 CORS。
- 桥接必须先 `npm run build` 才能托管静态资源；没有 `dist/` 时桥接只提供 `/api`，页面打开是空的。

### 3.3 演示模式（`--demo`）

计划命令：`npm run start -- --demo`（开发时 `npm run dev -- --demo`）。

- **不 spawn 任何进程、不访问真实文件**：不读 `router.json`、`gateway/data/*`、账号池与凭证。
- 全部数据来自匿名 fixtures，页面常驻 `DEMO` 标记；示例 provider、账号、额度均为虚构值。
- 演示模式的写操作只改内存中的模拟状态，文案**不得**暗示真实服务已改变。
- 演示模式可与 `--read-only` 叠加，仍不触碰真实后端。

### 3.4 只读模式（`--read-only`）

计划命令：`npm run start -- --read-only`。

- 在**桥接层**拦截写：`POST /api/actions` 与网关写端点直接返回错误，不依赖前端隐藏按钮。
- 只读模式下"服务/账号/额度/网关密钥"页仍可看；所有写按钮置灰并说明退出只读的方式。
- 只读不改变 CLI 能力：同一台机器上 `router.mjs up/down/account` 照常可用（那是 CLI 的自由）。

## 4. 配置

### 4.1 命令行参数（计划）

| 参数 | 默认 | 作用 |
|---|---|---|
| `--router-root <PATH>` | 自动发现 | router 仓库根目录（含 `router.mjs`） |
| `--node <PATH>` | `node`（PATH） | 指定 Node 可执行文件，便于多版本环境 |
| `--port <N>` | `8792` | 桥接监听端口 |
| `--host <ADDR>` | `127.0.0.1` | 只允许回环；传非回环地址应**启动失败** |
| `--demo` | 关 | 匿名 fixtures，不 spawn、不读真实文件 |
| `--read-only` | 关 | 桥接层拦截全部写操作 |

### 4.2 环境变量（计划）

| 变量 | 对应 | 说明 |
|---|---|---|
| `ROUTER_ROOT` | `--router-root` | 仓库根；与 TUI 同名同义 |
| `ROUTER_OPENCODE` | — | OpenCode CLI 路径覆盖（Windows 优先官方 `opencode.exe`） |
| `ROUTER_PANEL_PORT` | `--port` | 桥接端口 |
| `ROUTER_PANEL_DATA` | — | 桥接数据目录，默认 `frontend/.panel-data/` |

### 4.3 发现优先级（与 TUI 对齐）

```
1. 显式命令行参数（--router-root、--node、--port、--host）
2. 文档化环境变量（ROUTER_ROOT、ROUTER_PANEL_PORT …）
3. 当前目录若包含 router.mjs
4. 当前目录的父目录若包含 router.mjs
```

- 与 `tui/docs/04-architecture.md §14` 一致；面板不发明第二套发现规则，也不依赖打包机上的
  绝对路径 —— 从任意目录启动都应正确解析 root。
- 找不到 root 时明确报错（"找不到 router.mjs，请传 --router-root 或设置 ROUTER_ROOT"），
  **不得**回退成"十三家全部离线"这种误导性状态。
- MVP 不引入额外用户配置文件：刷新间隔等由设置页存到浏览器本地存储（见 [04 §10](04-architecture.md)），
  不改桥接参数，避免多套配置来源。

## 5. 构建产物与不入库清单

```text
frontend/
├── dist/              # 计划：npm run build 产物（站点静态资源）
├── .panel-data/       # 计划：桥接数据目录（日志、缓存、任务输出）
├── node_modules/      # 依赖
└── server/            # 桥接源码（入库）
```
| 路径 | 入库 | 处理 |
|---|---|---|
| `node_modules/`、`dist/` | ❌ | 分别由 `npm install` / `npm run build` 重建 |
| `.panel-data/`（含 `logs/*.log`） | ❌ | 运行时生成；含日志与缓存，可能含本机路径 |
| `*.local`、`.env*` | ❌ | 本机覆盖 |
| `vite.config.ts`、`src/`、`server/`、`package.json`、`package-lock.json` | ✅ | 源码与锁文件 |

**绝不入库**：`x-panel-token`、任何凭证/账号池、`router.json` / `opencode.json` 快照、日志中的
本机绝对路径。提交前用 `git status` 与 `git diff --cached --stat` 复核（与根目录
[README §Git](../../README.md) 同一惯例）。

## 6. 升级与回滚

### 6.1 依赖升级

1. 在 `frontend/` 内升级（`npm update <pkg>` / 改 `package.json`），**不动根目录**。
2. 跑 `npm run build` + `npm run start -- --read-only`，确认只读数据全部可用。
3. 跑测试与类型检查（见 [09 测试策略](09-testing.md)）。
4. 检查安全预算是否被突破（见 [07 安全与隐私](07-security.md)）。
5. 需要回退时 `git checkout package-lock.json && npm ci`。

### 6.2 契约变更

- 后端新增**可选**字段：桥接忽略即可，不必同步升级。
- 字段改义 / 删除 / 顶层结构不兼容：升 `schemaVersion`，同步 fixtures 与契约测试。
- 遇到不支持的更高 major：桥接**明确提示升级**，不猜测解析、不用正则兜底。
- 面板升级只允许改 `frontend/`；升级面板不需要 `router.mjs all/none/restart/account/login`。

### 6.3 数据目录迁移与备份点

| 时机 | 动作 |
|---|---|
| 升级前 / 变更 `ROUTER_PANEL_DATA` | 备份或复制 `.panel-data/`；旧目录留作回退；也可直接删除让其重建 |
| 契约变更 | 桥接应容忍旧缓存并重建，不做破坏性删除 |
| 回滚 | 切回旧版本代码 + 旧数据目录；**不回滚** `router.json` / `opencode.json` |

回滚原语始终是 CLI：

```bash
node router.mjs list
node router.mjs account
node router.mjs logs <provider> 80
```

不要用"重装面板 / 清 `router.json` / `none`"来当作回滚手段。

## 7. 排障（症状 → 真因 → 修法）

| 症状 | 真因 | 修法 |
|---|---|---|
| 页面白屏、控制台报 CSP / 资源被拒 | 生产模式下桥接没托管 `dist/`，或 CSP 头与内联资源冲突 | 先 `npm run build`；确认访问的是 8792 而不是文件系统路径；对照 [07 安全](07-security.md) 的 CSP 白名单 |
| `/api/*` 全部 404 | dev 下 Vite proxy 指向了错误的端口；或桥接未启动 | 起桥接（`npm run bridge`）；核对 `vite.config.ts` proxy 目标与 `--port`/`ROUTER_PANEL_PORT` 一致 |
| 桥接返回 401 | 页面 token 与桥接启动时签发的一次性 token 不匹配（常见于刷新后旧标签页） | 重新打开面板（重新注入 token）；确认没在别处转发不带 `x-panel-token` 的请求 |
| 网关页 502 | 桥接活着但网关 `127.0.0.1:8785` 未运行 | `node router.mjs gateway up`；`node router.mjs gateway status` 复核 |
| 日志乱码 / 出现 `\u001b[` 之类转义 | 上游日志含 ANSI/OSC 控制序列或双重转义 | 桥接应剥离控制序列后再返回；对照 `router.mjs logs <id> 80` 是否同样乱码，区分"上游乱码"与"面板转义" |
| SSE 断流 / 日志不再跟随 | 页面不可见被暂停；或代理缓冲了流；或桥接重启 | 回到页面应立即补一次；确认 proxy 未缓冲 SSE；查看桥接是否重启过 |
| 端口被占，启动失败 | 8792/5173 被别的进程占用 | `netstat -ano \| findstr :8792`（Linux `ss -ltnp`）；改 `--port` 或释放进程；`npm run ports:check` 定位 |
| "动作成功但状态未确认" | CLI 退出码 0，但随后刷新失败（反代还没起来 / 契约读取失败） | 看任务输出与退出码；手动刷新服务与总览页；**不要**重复提交同一写命令碰运气 |
| `account check` 退出码 1 | "有需要处理的账号"是**正常结果**，退出码 1 只是信号，不是崩溃 | 把退出码 1 与错误码 1 区分开：面板据 `--json` 的 `health.level` 渲染，不把非零码当失败 |
| 演示模式里"操作成功"但真实服务没变 | 演示模式只改匿名 fixtures | 这是预期行为；顶部 `DEMO` 标记必须可见，文案不得暗示真实变化 |

排障顺序（与 TUI 相同）：先确认**面板自身**（构建、端口、token），再确认**桥接**，
最后才怀疑**单家 provider / 网关**。不要一上来就重启十三家服务。

## 8. 与 TUI / CLI 共存

| 事实 | 结论 |
|---|---|
| 面板、TUI、CLI 都是"消费者" | 可**同时运行**，互不阻塞 |
| 面板不修改 `router.json` / `opencode.json` | 这两个文件只由 CLI（`router.mjs on/off/up/down/sync/account`）负责 |
| 面板写操作 = spawn 同一批 CLI | 副作用与 TUI 完全一致；不新增私有写路径 |
| 写任务全局串行**只在面板进程内** | 面板与 TUI 同时驱动同一 provider 时**没有跨进程互斥**；建议同一时刻只用一个前端做写操作 |
| 交互式动作（`login` / `account add`） | 面板只发起并等待，终端留给用户在原生终端完成；TUI/CLI 行为不变 |
| 面板读操作 | 纯只读（`list/account/logs --json`、网关 HTTP、OpenCode 统计），不改变任何状态 |

面板的"只读 / 演示"是**自己进程**的模式，不影响 CLI 与 TUI 的权限；反之，TUI 的 `--read-only`
也不会限制面板。

## 9. 日志与观测

| 内容 | 位置 / 方式 | 状态 |
|---|---|---|
| 桥接自身日志 | `frontend/.panel-data/logs/bridge-<date>.log`（同时输出到终端 stdout） | 计划 |
| 桥接请求日志 | method / path / status / providerId / actionId / 耗时 | 计划 |
| 任务输出（动作 stdout+stderr） | 桥接内存中的 `Task.stdout/stderr`，页面经任务详情查看，有界（默认 ≤2000 行） | 计划 |
| provider 日志 | 仍由 CLI 提供：`node router.mjs logs <id> <lines>`；面板经 `GET /api/logs` 转发 | 现有 + 计划 |
| OpenCode 用量 | 官方只读统计，面板不经日志反推 Token / 费用 | 现有 |

**日志红线**：

- `x-panel-token` 与任何凭证**不落日志**；请求日志只记头部的存在性，不记值。
- 日志与任务输出写入前剥离 ANSI/OSC 控制序列，并脱敏常见密钥形态。
- 面板日志不复制 `router.json`、`opencode.json`、账号池的完整内容。
- 需要原始日志时，用 CLI 直接读文件，不在面板里放大展示。

## 10. Windows / Linux 差异

| 主题 | Windows | Linux |
|---|---|---|
| 路径 | 反斜杠 `D:\router`；Node API 两种都接受，配置文件优先 `/` | 正斜杠 `/opt/router` |
| 默认 Node 发现 | PATH 中的 `node.exe`，或官方 Node 安装目录 | PATH 中的 `node` |
| 停止 / 关闭浏览器 | 前台 `Ctrl+C` 或 `Get-Process node` + `Stop-Process`；关标签页不停止桥接 | 前台 `Ctrl+C` 或 `kill <pid>`；关标签页不停止桥接 |
| 端口查询 | `netstat -ano \| findstr :8792` | `ss -ltnp \| grep 8792` |
| SSE / 长连接 | 本地回环通常无缓冲中间层 | 同左；经 tmux/SSH 转发调试时才可能被缓冲 |
| 登录自启 | `node router.mjs service install` 是**现有**能力，但只注册反代，**不注册面板** | systemd user unit 等由用户自行决定 |

登录自启建议（**不强制**）：面板是可选工具，默认**不**注册自启；确需开机常驻时，用系统
计划任务 / systemd 用户服务运行 `npm run start`，并显式传 `--router-root`，避免依赖工作目录。
不要为了自启而修改 `router.mjs` 或 `gateway/`。

`shutdown` 一类的概念不适用于面板：没有终端 raw mode、没有 alternate screen；退出就是停掉
桥接进程，浏览器端刷新即可重新连接（重新签发 token）。

## 11. 运行检查清单

- [ ] `node --version` ≥ 20（本机实测 `v26.x`）。
- [ ] `--router-root` 或 `ROUTER_ROOT` 指向含 `router.mjs` 的目录。
- [ ] 8792 / 5173 未被占用（`npm run ports:check` 或 `netstat`）。
- [ ] 只读模式先跑通：`npm run start -- --read-only`，确认总览/服务/账号/额度/日志可见。
- [ ] 演示模式独立验证界面：`npm run start -- --demo`，`DEMO` 标记常驻。
- [ ] 生产模式先 `npm run build` 再 `npm run start`，同源 `/api` 可用。
- [ ] `git status` 中不含 `dist/`、`node_modules/`、`.panel-data/`、日志，日志内无 token / 凭证 / 本机绝对路径。
