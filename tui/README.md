# Router TUI 控制仪表盘

> **适合**：想在终端里统一查看、启停、切号、看额度与日志。  
> **前置**：Rust 1.88+；真实后端还需要 Node.js 与本仓库的 `router.mjs`。  
> **相关**：[文档索引](../docs/README.md) · [TUI 文档](docs/README.md) · [根 README](../README.md)

> 状态：**MVP 已实现，Windows/Linux 均已运行验证**  
> 版本：0.1.0  
> 目标平台：Windows、Linux 终端  
> 边界：TUI 的终端界面跨平台；具体 provider 能力仍取决于本机 Node router 与第三方反代

`router-tui` 是统一的 Rust 终端控制仪表盘。它不替代根目录的 [`router.mjs`](../router.mjs)，而是通过受控子进程复用现有服务生命周期、账号、配置同步、额度、日志和自检逻辑。

## 已实现

- **总览**：全部 provider（十三家反代 + 统一网关叠加层）的开关、进程、认证、客户端、端口、模型数和额度摘要。
- **服务**：启动、停止、停止但保留客户端、重启、仅启用、关闭、全部启用/关闭和同步。
- **用量分析**：OpenCode 真实会话/步骤 KPI、Token 构成、每日活动、工具成功率和模型/Provider 聚合，支持 24h/7d/30d/全部历史。
- **额度**：按 provider/账号展示余额、总量、单位、重置日、可领取状态和数据时间；不跨厂商汇总。
- **账号**：账号池、当前生效、轮询状态、dry-run、切换、恢复整池、添加账号和登录。
- **日志**：选择 provider、过滤、暂停/跟随、调整尾部行数、清屏和操作输出。
- **诊断**：环境、`doctor`、无试打健康检查和经确认的真实试打。
- **安全**：写操作确认、默认取消、写任务互斥、只读模式、命令参数白名单、日志控制序列清理和凭据脱敏。
- **演示**：`--demo` 使用匿名内存数据，不需要 Node、凭证、网络或本机服务。
- **测试**：55 个默认测试（54 个单元测试 + 1 个 demo PTY）通过，4 个真实只读测试 default-ignored；包含真实 PTY 启动/退出、真实后端只读 UI 和真实用量页测试。Windows 与 WSL Ubuntu 均完成构建和测试；Linux 原生 PTY、真实只读 UI 和 release 构建已通过；双平台 CI 已配置。

## 运行

要求 Rust 1.88+。真实后端还需要 Node.js 和本仓库的 `router.mjs`。

### 匿名演示

```bash
cd tui
cargo run -- --demo
```

### 连接真实本机 router

在仓库根目录：

```bash
cargo run --manifest-path tui/Cargo.toml -- --router-root .
```

或安装后运行：

```bash
cargo install --path tui
router-tui --router-root /path/to/router
```

root 也可以从当前目录、父目录或 `ROUTER_ROOT` 自动发现。

### 常用参数

| 参数 | 作用 |
|---|---|
| `--demo` | 匿名演示数据，不启动 Node |
| `--read-only` | 禁用写操作、签到和真实试打 |
| `--router-root <PATH>` | 指定 router 仓库根目录 |
| `--node <PROGRAM>` | 指定 Node 可执行文件 |
| `--ascii` | 使用 ASCII 状态标记 |
| `--no-color` | 关闭颜色；也尊重 `NO_COLOR` |
| `--appearance dark\|light` | 选择配色倾向 |
| `--refresh-secs <N>` | provider 状态刷新间隔 |

## 键位

全局：`1`–`7` 切页，`↑↓/jk` 选择或滚动，`r` 刷新当前页，`O` 查看最近操作输出，`?` 帮助，`q` 或 `Ctrl+C` 退出。`7` 打开用量分析，`t` 切换统计时间范围。

| 页面 | 键位 |
|---|---|
| 总览 | `Enter` 详情，`h/l` 切换 provider，`2/5` 跳转 |
| 服务 | `u` 启动，`d` 停止，`K` 停止并保留客户端，`R` 重启，`o` 仅启用此家，`x` 关闭，`s` 同步，`A` 全部启用，`N` 全部关闭，`L` 日志 |
| 用量 | `7` 打开，`t` 切换 24h/7d/30d/全部，`Enter` 模型 Token 与成本详情 |
| 额度 | `Enter` 详情，`4` 跳到账号页；`c` 仅说明签到能力 |
| 账号 | `v` 预览，`c` 正式切换，`a` 恢复整池，`A` 添加账号，`L` 登录，`3` 额度 |
| 日志 | `p` 暂停/跟随，`f` 过滤，`n`/`N` 跳到下/上一个命中，`+/-` 调整行数，`c` 清屏，`End` 底部，`Home` 顶部 |
| 诊断 | `d` 自检，`h` 无试打健康检查，`P` 真实试打，`5` 日志 |

`o` 在服务页始终表示**仅启用此家**，会关闭其他已启用的 provider；确认框会列出影响。操作输出使用大写 `O`。

## 安全语义

- TUI 启动和定时刷新不会自动启停、登录、签到或真实试打。
- 关闭、停止、仅启用和同步分别对应不同 CLI 行为，界面不会把它们合并成含糊的开关。
- 写任务执行期间不能退出，避免中断配置写入。
- 账号切换先要求 dry-run；登录时暂时交还终端给现有 Node 工具。
- 日志在显示前清除终端控制序列并脱敏常见凭据。
- 账号切换和签到能力以现有 Node 后端为准，不在 Rust 中直接改凭证。

## 开发与验证

```bash
cd tui
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

真实只读冒烟测试（不执行写操作）：

```bash
ROUTER_TUI_TEST_ROOT=/path/to/router cargo test local_readonly_smoke -- --ignored --nocapture
ROUTER_TUI_TEST_ROOT=/path/to/router cargo test --test pty_smoke live_readonly_starts_in_a_pty_and_reads_providers -- --ignored --nocapture
```

Windows PowerShell：

```powershell
$env:ROUTER_TUI_TEST_ROOT = "<repo>"
cargo test local_readonly_smoke -- --ignored --nocapture
cargo test --test pty_smoke live_readonly_starts_in_a_pty_and_reads_providers -- --ignored --nocapture
```

CI 在 `.github/workflows/tui.yml` 中覆盖 `ubuntu-latest` 和 `windows-latest`。

如果本机 Windows 构建报 `link: extra operand ...`，说明 PATH 里的 `link.exe` 是 MSYS2 的 GNU `link`，抢在了 MSVC 链接器前面。临时绕过：

```powershell
$env:RUSTFLAGS = "-Clinker=rust-lld.exe"
cargo build
```

## 当前限制

- WorkBuddy 没有 credits 余额接口；额度页显示的是 access/refresh token 的有效天数，详情包含 UTC 绝对到期时间。国际版两个日期相同是上游 session 的真实值。
- 额度采集器把 Trae 的 provider 写成 `trae`，而 provider 表用 `trae-local`；TUI 在解析时统一成 `trae-local`，所以额度列、`4` 跳转和详情都能对上。
- 签到尚无统一的 Node 命令；界面会显示可领取状态，但不会执行真实领取。已停用账号即使未签到也不计入顶部「可领取」，避免给出领了也不会被调度的数字。
- 健康检查目前展示既有 `health.mjs` 的清理后文本，结构化健康 JSON 尚未接入。
- `--ascii` 当前主要替换状态符号；边框仍由 Ratatui 绘制。
- Windows 与 WSL Ubuntu 已通过真实 PTY 和真实只读 UI；Linux 第三方 provider 的实际启停/登录能力未在本机逐家验收。
- 真实写操作与交互登录挂起后的恢复仍需人工验收。
- 日志过滤与 `n`/`N` 命中跳转已实现（只标出当前落点，不做整行高亮）。
- 写任务没有强制中断按钮；后台 Node 长时间不返回时需等待或使用外部排查。

用量数据来源、指标口径和视觉规范见 [用量分析与视觉设计](docs/14-usage-analytics.md)。实现进度与剩余差距见 [实现状态](docs/13-implementation-status.md)。

## provider

| provider ID | 显示名称 | 默认端口 | 主要数据 |
|---|---|---:|---|
| `qoder-cn` | Qoder 国内版 | 8789 | 服务、单账号、凭证、积分、模型 |
| `qoder` | Qoder 国际版 | 8790 | 服务、单账号、凭证、积分、模型 |
| `trae-local` | Trae | 7863 | 服务、账号池、积分、模型 |
| `codearts` | CodeArts Agent | 10087 | 服务、账号池、积分、模型 |
| `workbuddy` | WorkBuddy 国内版 | 8787 | 服务、账号槽位、凭证有效期、模型 |
| `workbuddy-global` | WorkBuddy 国际版 | 8788 | 服务、账号槽位、凭证有效期、模型 |
| `zcode` | ZCode（Z.ai） | 20131 | 服务、固定凭据/桌面端凭据、套餐额度（M tok）、模型 |
| `loomy` | Loomy（讯飞） | 8791 | 服务、单账号、登录态、积分（credits）、模型倍率 |
| `raccoon` | 商汤小浣熊 | 8793 | 服务、单账号、登录态、积分（credits）、模型倍率 |
| `gateway` | 统一网关（叠加层） | 8785 | 服务、进程、模型并集；不参与 on/off |

`gateway` 是叠加层，不是第十四家反代：`router.mjs list` 把它的「开关」直接取进程状态，TUI 因此显示为**叠加**，不计入「启用 x/y」，也不会报配置漂移。启停用它自己的命令：

```bash
node router.mjs gateway up
node router.mjs gateway down
```

在服务页对网关按 `o`/`x` 会被拒绝并给出这条提示，避免 `on gateway` 顺手把其它十三家的 opencode provider 全删掉。

运行时数量和能力以真实后端返回为准。

## 文档

设计基线见 [文档索引](docs/README.md)。实现进度、已知差距和后续优先级见 [实现状态](docs/13-implementation-status.md)。

核心文档：

- [调研](docs/01-research.md)
- [需求](docs/02-requirements.md)
- [界面设计](docs/03-ui-design.md)
- [技术架构](docs/04-architecture.md)
- [后端契约](docs/05-backend-contract.md)
- [操作手册](docs/06-operations.md)
- [安全与隐私](docs/07-security.md)
- [跨平台](docs/08-cross-platform.md)
- [测试策略](docs/09-testing.md)
- [实施计划](docs/10-implementation-plan.md)
- [发布与运维](docs/11-release.md)
- [术语表](docs/12-glossary.md)
- [实现状态](docs/13-implementation-status.md)
- [用量分析与视觉设计](docs/14-usage-analytics.md)

## 目录结构

```text
tui/
├── Cargo.toml / Cargo.lock
├── README.md
├── docs/
├── src/
│   ├── main.rs          事件循环、任务调度、终端生命周期
│   ├── app.rs           页面、资源状态、确认和写任务状态机
│   ├── domain.rs        provider/账号/额度契约与 Action 映射
│   ├── backend/         Node 后端与匿名 Fixture 后端
│   ├── redact.rs        ANSI/控制字符清理与凭据脱敏
│   ├── terminal.rs      初始化、挂起、恢复与 panic hook
│   └── ui.rs            六页、弹窗、主题与 TestBackend 测试
└── .github 根工作流（位于仓库级 .github/workflows/tui.yml）
```

---

← 返回 [文档索引](../docs/README.md) ｜ [TUI 文档](docs/README.md)
