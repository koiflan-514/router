# 09 测试策略

状态：已实现并实测（2026-11-25）  
原则：无凭证可测、写操作可验证但不触碰真实环境、两个平台同标准

## 1. 测试目标

1. 证明命令映射准确，尤其是 `on/down/down --keep-oc/all/none` 的语义。
2. 证明任何后台延迟都不会冻结键盘和终端恢复。
3. 证明局部错误、旧数据和未知字段不会导致整页失败。
4. 证明日志和错误文本不能泄露常见密钥或控制终端。
5. 证明 Windows/Linux 的构建、渲染和子进程行为一致。
6. 证明 CI 不需要真实账号、Node 服务或模型额度。

## 2. 测试分层

```text
大量纯单元测试
  ↓
JSON 契约与命令映射测试
  ↓
App reducer / Action 状态机测试
  ↓
Ratatui TestBackend 渲染测试
  ↓
假 Node 子进程集成测试
  ↓
Windows/Linux 终端与真实后端人工验收
```

下层失败应先修复，不靠增加人工测试掩盖。公共 CI 只运行确定、匿名、可重复的自动化层级。

## 3. 测试数据

### 3.1 FixtureBackend

至少提供以下匿名场景：

- `healthy`：十三家状态完整，含单账号、多账号和不同额度类型，网关作为叠加层。
- `mixed`：开关/进程/opencode 漂移，凭证将到期，部分额度可领取。
- `partial_failure`：单家端点、额度和账号查询独立失败。
- `empty`：无账号、无额度桶、无日志、无模型。
- `stale`：有旧数据但最近刷新失败。
- `legacy`：缺 schemaVersion 和新增 auth 字段。
- `unknown_fields`：包含额外 provider、字段和未知 enum。
- `slow`：延迟响应、乱序完成和动作执行中。
- `action_failure`：非零退出、输出警告、成功后刷新失败。
- `hostile_text`：ANSI、OSC、控制字符、伪 token、超长行和 Unicode 控制字符。

### 3.2 数据安全

- fixtures 全部手写匿名值，不能从本机真实 JSON 直接复制。
- 使用 `example-user`、`slot-a`、示例 UUID 和虚构数值。
- 安全测试中的伪秘密必须明显是不可用的测试字符串，同时能覆盖对应模式。
- 不把真实 home、邮箱、用户 UID、token 或完整日志写入快照。

## 4. 单元测试

### 4.1 领域与状态推导

覆盖：

- `on=true/up=false/oc=true` 等所有关键组合。
- `models=null` 与 `models=0` 的区别。
- 合法空数组与查询失败的区别。
- auth valid/expiring/expired/missing/unknown。
- active/enabled 的账号组合。
- credits/days 不混合，total 为 0 或 null 不计算百分比。
- stale、last_success、receivedAt、fetchedAt 的推导。
- 未知 provider 只读，未知 enum 不崩溃。
- 数字异常、缺时间和非法时间不会 panic。

### 4.2 App reducer

覆盖：

- 页面切换和 provider 焦点保留。
- provider 消失后的安全选中。
- 弹窗优先级和输入模式隔离。
- key repeat/release 不重复提交。
- 过滤输入时字母不触发动作。
- 日志上滚暂停、End 恢复跟随。
- 日志和任务输出环形缓冲上限。
- 旧 request ID 响应被丢弃。
- 写操作后 generation 增加。
- 连续 resize 不产生副作用。

### 4.3 Action 状态机

每个 Action 都验证：

- 默认确认状态；
- read-only 阻断；
- demo 只走 fixture；
- 参数数组；
- 互斥范围；
- 成功后刷新集合；
- 非零退出和输出保存；
- 成功但刷新失败的“未确认”状态；
- 不自动重试写操作。

`Start/Stop/StopKeepOpenCode/Restart/OnlyEnable/Disable/EnableAll/DisableAll/Sync` 的命令映射必须穷举测试。账号 dry-run、正式切换、恢复整池、登录、添加账号和真实试打分别测试。

## 5. JSON 契约测试

### 5.1 Provider

- 现有 v0 输出可解析。
- v1 新字段可解析。
- 缺失可选字段使用默认。
- 缺 id 等核心字段产生最小范围错误。
- models/pid/pids 的 null/空数组合法。
- auth label 与结构化 state 不一致时以 state 为状态机输入，并保留诊断。
- 未知未来字段不失败。

### 5.2 Account

- 全部与单 provider 两种形状。
- 空账号、switchable=false、多账号 active/enabled。
- dry-run 成功、找不到账号、多个匹配和正式切换失败。
- 错误输出不包含秘密。

### 5.3 Credits

- 顶层数组 legacy 兼容。
- qoder buckets、Trae/CodeArts accounts、WorkBuddy days。
- available=false、单账号 error、缺失 checkin。
- remaining=0、total=0、total=null、浮点显示。
- fetchedAt 与 receivedAt 分离。
- 不把不同单位汇总。

### 5.4 Health

- 无试打 `probe=null`。
- 非零退出但合法逐项结果仍展示。
- reachable=false 与 auth_failed/rate_limited 不混淆。
- probe success/429/401/timeout/upstream/invalid response。
- 不解析旧 ANSI 文本生成结构化指标。

### 5.5 版本与大小

- 不支持的高 major 明确报兼容性错误。
- 非法 JSON、混合 stdout、超大输出被限制并诊断。
- stdout 与 stderr 不混合解析。

## 6. 渲染测试

使用 Ratatui `TestBackend`，不依赖真实终端截图。

页面矩阵：

| 页面 | 必测状态 |
|---|---|
| 总览 | 正常、混合漂移、局部失败、首次加载、stale；宽屏右栏与窄屏关键列 |
| 服务 | 操作中、只读、普通确认、高风险确认、刷新未确认 |
| 额度 | 多单位、多账号、空桶、可领取、活动关闭、过期提醒、`reset_date`、无总量 `────` |
| 账号 | 单账号、多账号、空账号、dry-run、平台不支持 |
| 日志 | 空日志、过滤、暂停、跟随、截断、脱敏、级别着色 |
| 诊断 | 环境错误、健康部分失败、真实试打确认、checklist + 通过率 meter |
| 用量 | KPI/Sparkline/Token 横条/gauge/模型表；空活动、stale；`s` 四档排序 |
| 帮助 | 当前页面和当前模式说明 |

每个关键页面至少测试：

- 120×40、100×30、80×24、60×20（当前测试矩阵 `SIZES`）；
- dark/light 的语义不丢字；
- NO_COLOR（BOLD/DIM/REVERSED，不产生调色板色）；
- Unicode 与 ASCII（边框/选中/进度/sparkline/环全部 7-bit）；
- 中文长名称和截断；
- 小于最小尺寸（<40×12）；
- 弹窗默认焦点为取消。

不断言无意义的完整样式字节；重点断言可见文本、布局边界、状态和关键符号。稳定页面可以使用匿名快照，但快照更新必须人工审查。

## 7. 假 Node 集成测试

使用测试专用可执行脚本或 fixture helper 模拟 CLI，不连接真实 provider。

验证：

1. argv 在 Windows/Linux 均正确传递，路径含空格和非 ASCII。
2. Node/root 不存在时错误分类正确。
3. stdout/stderr、退出码和超时正确处理。
4. 慢 list 后快 account 不互相覆盖。
5. 同一数据源不会请求堆积。
6. 写命令带 `--no-login`，登录命令才挂起。
7. 子进程取消只影响目标只读任务。
8. 输出超过上限会截断并标记。
9. demo 模式从未 spawn Node。
10. read-only 模式从未 spawn 写命令。

测试 helper 不包含真实 CLI 文件写逻辑，也不启动反代。

## 8. 安全测试

- Shell 元字符、引号、分号、管道、换行和 `$(...)` 作为不可信字符串不会形成额外命令。
- ANSI CSI/OSC、clipboard 序列、cursor 序列被清理。
- Bearer、伪 API key、伪 PAT、JSON token 字段和 URL query 被脱敏。
- C0/C1、Unicode bidi 控制和超长行不会破坏布局。
- 错误和 panic 不包含完整环境变量或账号 JSON。
- 发布 fixture 扫描不到真实路径和秘密模式。
- `on/all/none` 无确认不会执行。
- 自动刷新不会触发签到或真实试打。
- 写任务退出路径不会默认强杀。

## 9. 终端集成测试

当前已有 `tests/pty_smoke.rs`：在 Windows ConPTY 中启动匿名 demo，等待标题绘制，发送 `q` 并验证成功退出。另有 default-ignored 测试用真实后端 `--read-only` 启动，等待 provider 数据出现后退出。Linux 首次 CI 运行后再确认真实 PTY 表现。

pseudo-terminal 测试至少验证：

- raw mode/alternate screen 进入与退出；
- q、Ctrl+C、初始化失败、渲染错误和 panic 后恢复；
- 登录挂起前后模式恢复；
- resize 事件；
- 非 TTY 不输出全屏控制序列。

无法在所有 CI 环境稳定自动化的部分，必须进入人工矩阵，不得直接标记“已测试”。

## 10. 真实后端人工验收

### 前置保护

- 先备份用户配置，明确当前启用的 provider。
- 默认先运行只读检查。
- 写操作逐项执行并记录前后 `list --json`。
- 真实试打与签到单独授权，不在普通回归中执行。
- 测试后恢复测试前开关和账号选择。

### 核心场景

1. 十三家 list/account/credits/log 只读显示。
2. 单 provider up/down/restart 和 `--keep-oc`。
3. `off` 后再恢复；`on` 验证排他确认。
4. opencode 用户自管配置不会被 TUI 绕过。
5. 账号 dry-run 与正式切换，恢复原账号。
6. 登录取消与成功后的终端恢复。
7. Node 缺失、root 错误、端口占用、凭证过期和日志不存在。
8. 动作成功但刷新失败的提示。
9. Windows/Linux 各自支持和不支持能力。
10. 长时间运行日志缓冲与内存稳定。

## 11. OpenCode 用量专项测试

- 解析官方 SessionStats：providerID、活动、模型、Token、缓存和工具统计。
- 验证 24h/7d/30d/全部的 from/to 毫秒区间。
- 模型按 steps 排序，选中项保持可见；`s` 循环排序不触发新请求。
- KPI 卡、Sparkline、Token 构成横条、工具成功环和模型表在 120×40 / 80×24 下渲染。
- 无 OpenCode、空活动、空模型、字段错误和旧数据 stale 均有明确状态。
- `local_usage_smoke` 使用真实官方 CLI，不读取数据库或修改会话。
- PTY 中按 `7` 打开用量页，等待真实 Model/Steps/provider 出现后退出。
- 真实统计不写入 fixtures、测试快照或公开文档。

## 12. CI 计划

Windows/Linux 均执行等价命令：

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
cargo test dump_screens -- --ignored --nocapture   # 手工 dump 7 页 × 4 尺寸
cargo build --release
```

### 12.1 本机实测结果（2026-11-25）

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元 + PTY | `cargo test` | ✅ 98 unit + 1 demo PTY = **99 passed**，0 failed；unit 4 ignored，PTY 另 2 live ignored |
| 格式 | `cargo fmt --check` | ✅ 通过 |
| Clippy | `cargo clippy --all-targets -- -D warnings` | ✅ 0 warning |
| 发布构建 | `cargo build --release` | ✅ 通过 |
| 渲染矩阵 | TestBackend | ✅ 120×40、100×30、80×24、60×20 × 7 页面；空数据/后端失败/ascii/no-color |
| 截图 | `cargo test dump_screens -- --ignored --nocapture` | 手工 dump，不做像素 golden |

新增 44 个测试；unit 侧 4 个 ignored 为 2 个真实只读冒烟 + 2 个截图 dump，PTY 侧另有 2 个
live ignored（共 6 个 ignored）。CJK 宽度受终端字体影响，因此不引入像素级 golden 快照，
改为断言可见文本、边界与状态符号。

另做：

- `router-tui --help` 启动检查；
- 匿名文档/fixture 链接和秘密扫描；
- Cargo.lock 一致性检查；
- 发布包内容检查。

CI 不运行 `router.mjs all/none/up/down`、真实签到或 `health.mjs` 真实试打。

## 13. 需求追踪

| 需求范围 | 主要验证 |
|---|---|
| FR-001–006 | 领域、 reducer、总览渲染、局部失败契约 |
| FR-010–016 | Action 穷举、假 Node、任务状态机、人工控制 |
| FR-020–025 | 额度契约、单位、stale、签到安全和渲染 |
| FR-030–035 | 账号契约、dry-run、挂起恢复、单/多账号 |
| FR-040–046 | 日志渲染、安全、健康契约、真实试打确认 |
| FR-050–055 | 键位、帮助、demo/read-only、响应式、终端恢复 |
| NFR-001–010 | 双平台 CI、慢任务、有界资源、安全、兼容与发布检查 |

任何需求变更都必须同步增加或修改测试映射，不能只改验收文案。

## 14. 完成定义

一个功能只有满足以下条件才算完成：

- 正常、空、错误、慢和旧数据路径已考虑；
- 有自动化测试，或有明确原因的人工测试记录；
- Windows/Linux 不因为平台专属假设失败；
- 无真实凭证的 CI 可重复通过；
- 文档、帮助、命令和实际行为一致；
- 没有通过降低安全断言来换取测试通过。
