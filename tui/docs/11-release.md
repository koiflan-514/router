# 11 发布与运维

状态：设计基线  
当前已有本机构建能力但尚未生成正式发布包；本文规定后续发布流程

## 1. 发布物

### 一级目标

| 平台 | 文件形式 | 目标 |
|---|---|---|
| Windows x86_64 | `.zip` | `x86_64-pc-windows-msvc` |
| Linux x86_64 | `.tar.gz` | `x86_64-unknown-linux-gnu` |

每个发布包应包含：

- `router-tui` 或 `router-tui.exe`；
- 安装与运行 README；
- 必要许可和第三方说明；
- `SHA256SUMS` 或等价校验文件。

不得包含：

- `.env`、auth/session、凭证和账号池；
- `.run`、PID、日志、jsonl 和 opencode/pi 用户配置；
- `target`、测试缓存和临时文件；
- 真实 fixtures、本机绝对路径和 CI 凭证；
- 未获授权的第三方反代二进制。

TUI 包不捆绑 Node.js 和各 provider 网关；运行时依赖必须在 README 明确说明。

## 2. 版本策略

### 2.1 TUI 版本

采用语义化版本：

- MAJOR：不兼容的 CLI、配置或后端 major 变更。
- MINOR：向后兼容的新页面、新数据源、新操作。
- PATCH：缺陷修复、文案、安全和兼容性修正。

首个公开 MVP 可以使用 `0.1.0`。`0.x` 阶段仍需明确变更，不把“尚未 1.0”当作随意破坏契约的理由。

### 2.2 后端契约版本

- `schemaVersion` 与 TUI package version 分开。
- 新增可选字段不强制升 TUI major。
- 字段移除、改义或顶层结构不兼容时升级契约，并提供迁移说明。
- 发布说明列出支持的最低/最高后端契约和测试过的仓库 revision。
- TUI 遇到更高不支持 major 时明确提示升级，不猜测解析。

## 3. 发布渠道

### 开发构建

- 用于本地验证，不上传为稳定版本。
- 允许显示 git revision 和 dirty 状态，但不包含本机凭证路径。

### 候选版本

- 完成自动化测试和核心人工矩阵。
- 检查升级、回滚、真实只读和代表性写操作。
- 标记预发布，收集问题后再转正式。

### 正式版本

- P4 全部验收完成。
- Windows/Linux 构建、测试、安装和恢复终端均有记录。
- 发布说明包含支持边界和已知问题。

## 4. 计划中的安装方式

以下是未来示例，当前不可执行：

### 从源码安装

```bash
cargo install --path tui
router-tui --router-root /path/to/router
```

### 直接运行开发构建

```bash
cargo run --manifest-path tui/Cargo.toml --release -- --router-root .
```

### Windows 二进制

将 `router-tui.exe` 放入用户选择的目录，然后在 PowerShell 或 CMD 中运行：

```powershell
router-tui.exe --router-root D:\path\to\router
```

### Linux 二进制

```bash
chmod +x router-tui
./router-tui --router-root /path/to/router
```

真实后端需要 Node.js。没有 Node 时可以运行 `--demo`，但不能管理真实服务。

## 5. 启动诊断

启动失败时按顺序提示：

1. 是否为交互 TTY；非 TTY 不应收到全屏控制序列。
2. root 是否存在且包含 `router.mjs`。
3. Node 是否可执行，版本是否能运行现有脚本。
4. 必要脚本和集成文件是否存在。
5. 当前平台是否支持请求的动作。
6. 单 provider 的二进制、端口、账号和凭证问题。

全局环境错误不能渲染成“八家全部离线”。真实后端不可用时仍可提示 `--demo` 作为界面验证方式。

## 6. 升级流程

1. 阅读发布说明和契约兼容性。
2. 记录当前 provider 开关和账号状态；升级 TUI 本身不应改变它们。
3. 关闭正在运行的旧 TUI，不需要停止反代。
4. 替换 binary 或运行新版本源码安装。
5. 先执行 `--read-only`，确认 list/account/credits/logs。
6. 再按发布说明验证新增或变化的写操作。
7. 若后端 JSON 也需升级，先确认原 CLI 仍能独立使用。

TUI 升级不自动执行 `router.mjs all/none/restart/account/login`。

## 7. 回滚

- 保留上一个已验证 binary 和对应发布说明。
- 回滚只替换 TUI，不回滚或重写用户凭证。
- 若新版本曾要求后端不兼容变更，应同时确认旧 TUI 是否支持新 JSON；增量字段应保证旧消费者可忽略。
- 原生命令行始终作为故障回退：

```bash
node router.mjs list
node router.mjs account
node router.mjs logs <provider> 80
```

不要通过重装、清账号或 `none` 来“回滚 TUI”。

## 8. 发布检查

### 自动化

- [ ] `cargo fmt --check`。
- [ ] `cargo clippy --all-targets -- -D warnings`。
- [ ] Windows/Linux `cargo test --all-targets`。
- [ ] Windows/Linux release build。
- [ ] `--help` 和 demo 启动检查。
- [ ] 文档本地链接检查。
- [ ] fixtures、git diff 和发布包秘密扫描。
- [ ] Cargo.lock 和依赖许可检查。

### 人工

- [ ] Windows Terminal、PowerShell、CMD。
- [ ] Linux 终端、tmux、SSH。
- [ ] 80×24、窄屏和反复 resize。
- [ ] NO_COLOR、ASCII、暗色/亮色。
- [ ] 正常、错误、panic 和登录挂起后的终端恢复。
- [ ] 只读、普通写、高风险写和动作失败。
- [ ] Node/root 错误和平台不支持提示。
- [ ] 安装、升级和回滚。

真实签到与真实试打只在明确授权的发布测试中进行，不作为每个 patch 的默认步骤。

## 9. 发布说明模板

```markdown
# router-tui x.y.z

## 变更
- 新功能：
- 修复：
- 安全：

## 支持
- 已测试的 TUI 平台：
- 支持的后端 schemaVersion：
- 测试过的 router revision：
- 第三方 provider 的已知平台限制：

## 升级与兼容
- 是否要求同步修改 Node 后端：
- 是否影响现有 CLI：
- 是否改变账号、开关或配置：

## 已知问题
-

## 校验
- 见 SHA256SUMS。
```

发布说明不得把“未测试”写成“不支持”，也不得把“能编译”写成“全部功能已验证”。

## 10. 故障排查

### TUI 无法启动

- 检查 TTY、终端尺寸和 `--help`。
- 使用 `--demo` 区分终端 UI 与真实后端问题。
- 检查 Node 和 `--router-root`，不要先重启八家服务。

### 所有数据不可用

- 检查 Node spawn、root、JSON 契约和全局错误。
- 直接运行 `node router.mjs list --json` 对照。
- 不把所有失败解释为网络或账号过期。

### 单家不可用

- 查看该 provider 的 up/oc/auth/额度错误。
- 进入对应日志和无试打健康。
- 只有用户明确需要时才执行真实试打。

### 操作完成但状态未确认

- 查看任务退出码和输出。
- 手动刷新 list。
- 不重复提交同一写命令“碰运气”。

### 终端显示异常

- 退出后检查 raw mode/alternate screen 是否恢复。
- 尝试 NO_COLOR 和 `--ascii`。
- 报告终端、OS、尺寸和是否 tmux/SSH；不要提交含秘密的完整日志。

## 11. 支持信息收集

默认只收集：

- TUI 版本、OS、终端类型和尺寸；
- Node 版本、router revision、schemaVersion；
- 脱敏后的错误码和最小复现步骤。

不得默认收集 token、凭证文件、完整账号 JSON、个人路径、提示词、响应正文或完整日志。诊断报告若未来实现，必须预览、脱敏并由用户显式保存。
