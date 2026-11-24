# 13 实现状态

快照日期：2026-11-25  
版本：0.1.0  
状态：MVP 代码已落地，视觉重构完成；Windows 与 WSL Ubuntu 的构建、PTY 测试和真实只读冒烟均已通过；第三方 provider 在 Linux 上的逐家能力仍未验收。

## 1. 总体进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| 设计基线 | 完成 | 14 篇设计与状态文档 |
| P0 工程骨架 | 完成 | Crate、CLI、终端恢复、七页 UI、FixtureBackend |
| P1 真实只读 | 基本完成 | list/account/credits/logs/doctor/health 文本；health JSON 未接入 |
| P2 安全控制 | 已实现，待真实写操作人工验收 | 命令映射、确认、互斥、dry-run、登录挂起 |
| P3 诊断与体验 | 基本完成 | 日志过滤/跟随/`n`/`N` 跳转、脱敏、健康文本；签到待接入 |
| P4 测试与发布 | 基本完成 | Windows/Linux 原生构建与 PTY、真实只读 UI；正式发布包待做 |
| P5 用量分析与视觉升级 | 完成 | OpenCode 统计、KPI、活动图、模型聚合、分类色与圆角面板 |
| P6 UI 模块化与响应式重构 | 完成（2026-11-25） | `ui.rs` 拆分模块树、五行外壳、三档断点、语义色/ASCII、44 个新测试 |

## 2. 已交付能力

### 工程与界面

- Rust binary `router-tui`，Ratatui 0.30.2、Crossterm 0.29、Tokio。
- 七页键盘界面：总览、服务、额度、账号、日志、诊断、用量分析。
- 五行外壳（顶栏/页签/主内容/上下文摘要/键位）；三档断点（≥120 / 80–119 / <80）。
- 总览 KPI 卡、provider 紧凑矩阵、宽屏右栏（健康环/额度 Top/7 天 sparkline/待处理）。
- 用量 KPI、每日活动 Sparkline、Token 构成横条、工具成功率矩形环、模型行内占比与 `s` 排序。
- `ui.rs` 渲染根（449 行）+ 模块树：`theme.rs`(522)、`layout.rs`(194)、`widgets.rs`(449)、
  `common.rs`(715)、`modals.rs`(232)、`pages/*`(约 2190)、`tests.rs`(627)。
- Dark/Light 颜色倾向、NO_COLOR（BOLD/DIM/REVERSED）、状态符号与边框/进度/sparkline/环 ASCII 降级。
- 帮助、详情、确认、输入过滤和错误弹窗。
- 正常退出、Ctrl+C、初始化错误、panic 和登录挂起后的终端恢复路径。

### 真实只读后端

- `opencode api experimental.session.stats`：真实会话、步骤、Token、缓存、每日活动、工具统计和模型/Provider 聚合。
- `node router.mjs list --json`。
- `node router.mjs account --json`。
- `node qoder2pi credits json`。
- `node router.mjs logs <id> <lines>`。
- `node router.mjs doctor`。
- `node scripts/health.mjs --no-probe [id]`。
- 请求超时、输出大小上限、局部 provider/账号/额度行容错、stale 数据和请求代次丢弃。

账户显示修复：Trae 的秒级 `expiresAt` 已正确换算为毫秒；WorkBuddy 额度行改用凭证语义并显示 UTC 绝对到期时间；账号列表对停用项给出明确原因。

网关与额度一致性修复：

- `gateway` 识别为叠加层：开关列显示「叠加」、不计入「启用 x/y」、不报漂移；`o`/`x`/登录会被拒绝并提示用 `router gateway up/down`。
- 额度采集器的 `trae` 统一归一成 `trae-local`，额度列、`4` 跳转和详情不再对不上 provider。
- 额度状态列优先显示「额度已耗尽」，不再被签到说明覆盖；凭证桶不再回落到整行长句。
- 签到可领取改为「支持 + 未签 + 奖励>0」推断，停用账号不计入顶部「可领取」。
- 账号页接入后端 `health.level/notes`（如「积分为 0，选中会报额度不足」），error 级排到说明前面。
- `\\?\D:\...` 前缀不再出现在标题栏与诊断页。

真实只读冒烟结果（历史记录，当前 provider 数以 `node router.mjs list` 为准）：

```text
read-only smoke: 8 providers, 8 account groups, 8 quota rows, logs readable
```

该测试只读取本机状态和额度，不启动/停止 provider，不写配置，不签到，不真实试打。

### 安全控制

- Action 封闭映射与白名单 provider/account 标识。
- 参数数组启动，不经过 Shell。
- 启动/重启/仅启用/全部启用带 `--no-login`。
- 普通/高风险确认，默认焦点在取消。
- `on` 排他影响列表，`down` 与 `--keep-oc` 分开说明。
- 全局写任务串行；同 provider 不重复提交。
- 操作后用真实查询校正状态，不把退出码当作状态。
- `--read-only` 在调度层阻断写操作、签到和试打。
- 账号预览 dry-run 成功后才允许正式切换。
- 登录/添加账号暂时恢复终端给 Node 交互工具。
- 任务运行期间拒绝退出。

### 日志与隐私

- ANSI CSI/OSC、C0/C1、bidi 控制字符清理。
- 常见 Bearer、CLI token、JSON/query 秘密字段脱敏。
- 日志、任务输出和错误有行数/字节上限。
- 不读取凭证文件；Rust 只消费 Node 公开字段。
- 匿名 fixtures 不含真实账号或凭证。
- panic hook 不输出任务内容或环境秘密。

### 对现有 Node 后端的最小增量

- `list --json` 增加 `schemaVersion` 和 `generatedAt`。
- `account --json` 增加 `schemaVersion` 和 `generatedAt`。
- `auth` 增加结构化 `state` 和 `expiresAt`，保留原 `ok/label`。
- 人类 CLI 输出和写命令语义不变。

## 3. 自动化验证

已完成：

- `cargo fmt --check`：通过。
- `cargo clippy --all-targets -- -D warnings`：通过（0 warning）。
- `cargo test`：**98 unit + 1 demo PTY = 99 passed，0 failed**。
- unit 侧 4 ignored：2 个真实只读冒烟（`local_readonly_smoke` / `local_usage_smoke`）+ 2 个截图 dump（`dump_screens` / `dump_ascii_screens`）；PTY 侧另有 2 个 live ignored，共 6 个 ignored。
- `cargo test dump_screens -- --ignored --nocapture`：手工 dump 7 页 × 4 尺寸。
- `cargo build --release`：通过。
- TestBackend：七页渲染、KPI 卡、Sparkline、Token 横条、gauge、空数据/后端失败、
  `--ascii`/`--no-color`，120×40 / 100×30 / 80×24 / 60×20，99 列确认弹窗。
- 新增 44 个测试，覆盖尺寸矩阵、空数据、后端失败、ASCII 与无色模式。

测试覆盖：

- Auth、额度和空/未知区别。
- 网关叠加层语义：不计入开关、不报漂移、`o`/`x` 被拒绝；`none` 停进程但保留 gateway 的 opencode provider。
- 额度 provider id 归一（`trae` → `trae-local`）、额度耗尽优先于签到说明、签到可领取推断。
- 账号 `health.level/notes` 解析（未知 level 不炸整行）。
- 日志过滤的 `n`/`N` 命中跳转与回绕。
- 额度/账号页数字键联动选中 provider。
- JSON legacy、未知 enum、未来 schema、局部坏行。
- 命令安全参数、read-only、确认默认取消、写任务互斥。
- Fixture 启停、排他启用、账号预览不写入。
- 终端控制序列、动态字段脱敏和日志尾部上限。
- 真实 ConPTY 启动、raw mode、alternate screen 与退出恢复（demo 和真实只读后端）。
- 真实 Node 只读契约和真实 UI 只读冒烟（manual/ignored）。
- OpenCode 真实用量接口与真实用量页 PTY（manual/ignored）。

## 4. 已知差距

### 高优先级

1. **真实写操作尚未在本机自动验收。** 为避免改变用户服务、账号和客户端配置，开发阶段只执行了只读冒烟。需要按测试文档做一次可回滚的人工 Windows 验收。
2. **Linux 第三方 provider 能力尚未逐家验收。** TUI 已在 WSL Ubuntu 原生构建、测试并通过 PTY/真实只读 UI；实际启停、登录和第三方二进制支持仍取决于 Linux 侧部署。
3. **健康检查仍为文本。** `health.mjs --json` 尚未实现；TUI 展示清理后的完整文本和退出码，不解析文本成结构化指标。
4. **签到未接入真实动作。** 后端没有按 provider 统一的签到命令；界面只展示可领取状态并明确提示未接入，绝不误领取。
5. **写任务没有强制中断。** 当前禁止任务中退出；Node 命令永久挂起时缺少经过原子性评估的取消流程。

### 中优先级

6. 未做像素级 golden 快照：CJK 宽度受终端字体影响，当前用可见文本/边界/符号断言 + 手工 dump。
7. 日志过滤与 `n`/`N` 命中跳转已实现，但只标出当前落点（`»`），不做整行语法高亮。
8. Windows 与 WSL Linux 的 demo/真实只读 PTY 已自动测试；交互登录挂起后的恢复和真实写操作仍需人工验收。
9. 环形仪表是 buffer 自绘**矩形环**，不是真圆；换取 ASCII/无色下稳定。
10. 登录在 Linux 的实际 provider 命令支持未完成真实验收。
11. 未生成正式发布 zip/tar 和校验文件。

### 明确未做

- 逐请求 TTFT、P75/P99、HTTP 请求成功率、路由尝试和请求日志；OpenCode 聚合 Token/活动/工具成功率已提供。
- 自动签到、自动重启、自动真实试打。
- 任意 Shell 输入。
- 多用户、RBAC、远程后端。
- Rust 直接操作凭证或账号池。

## 5. 建议后续顺序

1. 在 Windows 完成一次可回滚的 P2 写操作人工验收，保存前后 `list --json`。
2. 运行 Linux CI，处理平台专属编译/测试问题，完成 Linux 只读实测。
3. 实现 `health.mjs --json`，让诊断页按 provider 展示结构化状态。
4. 补齐真实终端 PTY 恢复测试，并给日志命中加整行高亮。
5. 设计统一签到 Node 命令后再启用真实签到。
6. 完成发布打包、校验、安装/升级/回滚演练。

## 6. 文件状态

| 类型 | 是否已创建 |
|---|---|
| Rust 工程与源码 | 是 |
| Cargo.lock | 是 |
| 匿名 Fixture 数据 | 是，内嵌于 backend |
| 自动化测试 | 是 |
| Windows/Linux CI | 是，待运行 |
| 正式发布二进制 | 否，只有本机构建产物且被 gitignore |
| 真实凭证、日志、账号快照 | 否 |

本文件记录的是当前事实，不替代正式发布说明。发布前必须重新执行测试清单并更新状态。