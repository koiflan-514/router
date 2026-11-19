# 08 跨平台设计

状态：设计基线  
目标：同一 Rust TUI 在 Windows 和 Linux 可构建、可操作、可测试、可恢复

## 1. 支持边界

跨平台承诺分两层：

1. **TUI 终端层**：Windows/Linux 使用同一套代码、键位、状态语义、文档和测试。
2. **后端能力层**：真实控制依赖 Node.js、现有 router、本机命令和第三方反代在当前平台的支持。

因此，TUI 能在 Linux 运行不等于 Trae、CodeArts 或其他第三方组件一定提供 Linux 版本。不可用时必须显示具体原因，不能伪装成功或让整页崩溃。

## 2. 目标矩阵

### 2.1 一级构建目标

| 目标 | Rust target | 预期用途 |
|---|---|---|
| Windows x86_64 | `x86_64-pc-windows-msvc` | Windows Terminal、PowerShell、CMD |
| Linux x86_64 | `x86_64-unknown-linux-gnu` | 常见发行版、SSH、tmux |

后续可以在有原生 CI 和实测后增加 ARM64、macOS 或 musl 静态版本，不在 MVP 中未测先承诺。

### 2.2 终端与场景

| 场景 | MVP 要求 |
|---|---|
| Windows Terminal + PowerShell | 完整人工验收 |
| Windows Terminal + CMD | 启动、键位、退出和编码验收 |
| Windows ConHost | 基础显示、无色/ASCII 和恢复；不承诺所有现代字体效果 |
| Linux 常见终端 | 完整人工验收 |
| SSH 到 Linux | 键位、窄屏、断连后子任务行为验收 |
| tmux | 事件、颜色和 alternate screen 验收 |
| WSL | 作为 Linux 环境单独验证，不假设可透明控制 Windows 进程 |
| 非 TTY stdin/stdout | 清楚报错或提供非交互命令，不输出全屏控制序列 |

WSL 与 Windows 的 Node、home、配置、PID 和监听端口属于不同运行边界。使用 `/mnt/c` 或 `/mnt/d` 打开仓库不代表可以安全管理 Windows 侧反代；MVP 应建议在与目标后端一致的系统环境中运行 TUI。

## 3. D-05 跨平台 TUI 不等于所有反代跨平台

当前 router 已包含部分 POSIX 支持，例如进程组、`ps`、`lsof`/`ss` 兜底；但仍存在平台专属能力：

- 登录自启目前主要是 Windows 计划任务。
- Trae 的部分登录流程依赖 PowerShell。
- `.exe` 与 POSIX 二进制选择不同。
- 本地第三方网关和 Python/uv 环境可能在 Linux 缺失。
- Windows 与 Linux 的 opencode/pi 配置路径和进程权限不同。

TUI 应根据后端能力和实际错误显示操作，不仅根据 `cfg!(windows)` 猜测。平台判断可用于提示已知限制，但最终结果以 Node 后端为准。

## 4. 运行时依赖

| 依赖 | 真实后端 | demo/CI |
|---|---|---|
| Rust 运行时 | 编译后无需工具链 | 同 |
| Node.js | 必须，在 PATH 或由 `--node` 指定 | 不需要 |
| router root | 必须，由参数/env/发现确定 | 不需要 |
| provider 二进制和运行环境 | 按 provider 需要 | 不需要 |
| `lsof` 或 `ss` | Linux 进程/端口检测至少一种可用 | 不需要 |
| 浏览器/PAT | 仅用户显式登录时 | 不需要 |
| OpenCode CLI | 仅“7 用量”分析需要；不存在时其他功能可用 | 不需要 |

Windows 用量后端优先使用 `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`，与 `opencode.cmd` 指向的官方原生程序一致，不通过 `.cmd` 启动。其他系统使用 PATH 中的 `opencode`，也可用 `ROUTER_OPENCODE` 覆盖。OpenCode CLI 负责服务发现和认证上下文，TUI 不读取数据库。

Node 缺失时，真实模式显示安装/参数建议并安全退出或停留在明确错误页；demo 仍可运行。不得把 Node 缺失显示成八家 provider 全部离线。

## 5. Root 与可执行文件发现

优先级：

1. `--router-root`、`--node`；
2. `ROUTER_ROOT` 等公开环境变量；
3. 当前工作目录中的 `router.mjs`；
4. 当前工作目录父目录中的 `router.mjs`。

规则：

- 路径通过 `Path/PathBuf` 处理，不用字符串替换斜杠。
- Windows 支持盘符、空格、中文和长路径，由参数数组原样传递。
- Linux 支持空格、非 ASCII 和符号链接后的正常路径，但不要求全盘搜索。
- 不使用编译期 `C:\...`、`E:\...` 或 `/home/...` 绝对路径。
- Node 通过 PATH 查找时由操作系统处理 `.exe` 和 PATHEXT，不自行拼接 Shell 命令。
- root 不存在或缺少预期脚本时，在发起任何写操作前失败。

## 6. 终端初始化与恢复

使用 Crossterm 统一实现：

- raw mode；
- alternate screen；
- cursor 隐藏/显示；
- keyboard/resize 事件；
- 颜色和终端尺寸。

以下路径都必须恢复：

1. 正常 `q` 退出；
2. Ctrl+C 请求退出；
3. 后端初始化失败；
4. JSON 解析失败；
5. 渲染错误；
6. panic；
7. 登录/添加账号挂起后返回；
8. 终端过小到恢复尺寸。

恢复函数必须幂等，避免错误处理中二次 panic。远程 SSH 断连无法保证客户端显示立即复原，但进程收到退出信号时应尽力停止任务，不把本地日志写入远程终端。

## 7. 键盘与输入

- 使用 Crossterm KeyEvent，不直接解析平台扫描码。
- 同时支持方向键和文档化字母键。
- 区分 `r/R`、`a/A` 等大小写。
- Windows 与 Linux 的 Enter、Esc、Backspace、PgUp/PgDn、Home/End 均纳入测试。
- 只响应文档规定的 key kind，避免 key repeat/release 在不同终端造成双次动作。
- 文本输入不依赖完整输入法编辑器；中文过滤可作为后续增强，MVP 不得因此阻塞全局键位。
- 写操作必须有弹窗确认，单个 keydown 不直接产生危险副作用。

## 8. 颜色、Unicode 与宽度

- 尊重 `NO_COLOR`，提供 `--ascii`。
- 颜色能力按环境降级：真彩色 → 256 色 → 16 色 → 无色。
- 不依赖 Nerd Font 私有区图标。
- 中文、英文、数字混排通过 Ratatui/Unicode 宽度处理，不用 `String.len()` 计算显示宽度。
- 缺字终端使用 ASCII 模式仍能理解全部状态。
- 亮暗主题只是配色，不改变字段含义。
- Windows 旧终端颜色或 Unicode 不完整时，优先保证文字和布局。

## 9. 编码与换行

- JSON 按 UTF-8 解析。
- Node 文本输出优先按 UTF-8；legacy 输出中的少量非法序列采用有记录的安全替换，不直接 panic。
- Windows CRLF 与 Linux LF 都按行处理。
- 日志清理同时处理 `\r\n`、`\n` 和末尾不完整行。
- 文件名与 provider ID 分离；显示名称可以是中文，命令 ID 保持 ASCII。
- 不把本地系统语言相关文本作为结构化解析依据。

## 10. 进程与权限差异

### Windows

- 进程树和端口清理由现有 router 的 `tasklist/taskkill/netstat` 等逻辑负责。
- TUI 不自行调用 `taskkill`。
- 后台写操作使用 `--no-login`，避免不可见浏览器/交互。
- 对需要管理员权限的操作，保留后端拒绝信息，不自动提权。

### Linux

- 进程组、SIGTERM/SIGKILL 和 `lsof`/`ss` 由现有 router 负责。
- TUI 不假设拥有 root 权限，不自动使用 sudo。
- 如果 `lsof` 和 `ss` 都缺失，应显示 doctor/后端诊断，而不是全部判为停止。
- 自启动等未实现能力禁用并说明，不生成未经验证的 systemd unit。

## 11. 响应式与远程终端

人工测试至少覆盖：

- 120×30、100×28、80×24；
- 60×20 的降级布局；
- 小于最小尺寸的提示界面；
- 运行中反复 resize；
- SSH 高延迟下慢日志和慢状态请求；
- tmux 中切窗、 detach/reattach 后的可读性。

resize 只重排，不触发写操作、真实试打或新的签到。

## 12. CI 与发布矩阵

当前开发状态：Windows 已完成构建、测试和真实只读运行；WSL Ubuntu 已原生完成构建、全部测试、demo/真实只读 PTY 和 release 构建。Linux 上的第三方 provider 实际启停/登录仍需按部署环境逐家验收。

GitHub Actions 计划：

| runner | 检查 |
|---|---|
| `windows-latest` | fmt、clippy、test、release build、CLI help、匿名 fixtures |
| `ubuntu-latest` | fmt、clippy、test、release build、CLI help、匿名 fixtures |

真实八家 API 实测不进入公共 CI，因为它需要本机凭证、消耗额度并改变用户环境。真实后端人工验收单独记录。

发布包按 OS/arch 分开，包含 binary、README、必要许可与校验值，不包含本机配置和日志。

## 13. 平台验收清单

### Windows

- [ ] PowerShell/CMD 可启动和退出。
- [ ] 中文路径、空格路径下能找到 root 和 Node。
- [ ] 键位大小写、确认框和 resize 正常。
- [ ] 登录挂起后终端恢复。
- [ ] 无颜色/ASCII 模式可用。
- [ ] 真实后端异常不误触发提权或 Shell。

### Linux

- [ ] 常见终端和 tmux 可启动和退出。
- [ ] 无 root 权限时错误清晰。
- [ ] `lsof`/`ss` 缺失可诊断。
- [ ] 不支持的自启/登录操作明确禁用。
- [ ] SSH/慢请求下界面不阻塞。
- [ ] demo 和匿名测试不依赖 Node。

## 14. 文档表述要求

发布说明只能声称已经构建和测试的目标。不得使用“全平台”“所有终端”“Linux 功能与 Windows 完全一致”等无法证明的表述。正确说法是：

> router-tui 的终端界面支持 Windows 和 Linux；实际 provider 与登录、自启能力由本机 Node router 和第三方反代支持情况决定。
