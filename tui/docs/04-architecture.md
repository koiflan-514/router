# 04 技术架构

状态：设计基线  
目标：用最小的新控制逻辑构建可测试、可恢复、跨平台的 Rust TUI

## 1. 架构目标

1. 现有 `router.mjs` 始终是服务与账号控制事实来源。
2. UI 不阻塞在网络、进程探测、日志读取或长时间登录上。
3. 每个数据源可以独立失败、独立刷新和保留旧数据。
4. 所有写操作有明确状态机，不以按钮按下瞬间推断成功。
5. 无真实凭证即可测试全部渲染和命令映射。
6. 终端状态在正常退出、错误和 panic 路径上均可恢复。

## 2. 系统上下文

```text
用户键盘
   │
   ▼
router-tui（本地单用户进程）
   │ 参数数组、stdin/stdout/stderr、退出码
   ▼
Node.js CLI
   ├── router.mjs
   ├── scripts/health.mjs
   └── integrations/qodbuddy2pi/assets/qoder2pi
   │
   ├── OpenCode CLI（experimental.session.stats，只读）
   ├── 本地反代进程与端点
   ├── router.json / .run/processes.json
   ├── opencode / pi 配置
   ├── 厂商凭证与账号池
   └── 厂商或本地网关额度接口
```

TUI 与 CLI 同机运行。MVP 不开放 TCP 控制端口，不引入新的守护进程，也不把凭证交给 Rust 网络客户端。

## 3. D-01 复用 Node.js 控制后端

### 决策

采用 `NodeBackend` 调用现有 Node CLI，而不是 `DirectBackend` 直接读写状态文件。

### 原因

- `router.mjs` 已处理 Windows PID 树、POSIX 进程组、端口兜底和 Trae 双进程。
- 账号切换包含供应商特定状态和重启行为。
- opencode 写入有用户自管 `.jsonc`、备份和共享模块等边界。
- 额度采集已经处理厂商接口、本地网关、错误归一和敏感字段。

### 后果

- 运行真实后端需要 Node.js 和可发现的 router root；启动时必须清楚诊断。
- TUI 发布不意味着脱离 Node.js；`--demo` 可以在没有 Node 时运行。
- 新增 provider 或控制动作应先扩展 CLI 契约，再接入 TUI。
- 不允许为了少一次子进程调用而在 Rust 中复制高风险控制逻辑。

## 4. 技术栈

| 组件 | 选择 | 职责 |
|---|---|---|
| Rust | stable，MSRV 1.88 | 单二进制、类型安全、跨平台 |
| Ratatui | 0.30.x，实施时锁定 | 即时模式渲染、布局、TestBackend |
| Crossterm | 与 Ratatui 匹配的 0.29 | 事件、raw mode、alternate screen、终端能力 |
| Tokio | 实施时锁定 | 子进程、定时器、通道、协作取消 |
| Clap | derive | 启动参数和版本信息 |
| Serde / serde_json | 实施时锁定 | 契约解析和匿名 fixtures |
| anyhow / thiserror | 按模块边界使用 | 应用错误与可分类领域错误 |

约束：

- 不引入第二个不兼容的 Crossterm major。
- MVP 不需要 SQLite、Web 框架、独立 HTTP 控制服务或 Rust 厂商 SDK。
- 日志查看调用现有 CLI 或只读后端，不引入完整日志数据库。

## 5. 模块划分

计划中的逻辑模块，不代表本阶段已经创建代码：

| 模块 | 职责 | 不应承担 |
|---|---|---|
| `main` | 参数解析、初始化、运行和退出码 | 页面业务逻辑 |
| `cli` | root/node/demo/read-only/ascii 等参数 | 调用 provider |
| `app` | App 状态、事件归约、焦点、任务状态机 | Ratatui 绘制细节 |
| `domain` | Provider、Account、Quota、Health、Action 等统一模型 | JSON 命令细节 |
| `backend` | Backend 能力接口和错误分类 | 键盘与布局 |
| `backend::node` | CLI 发现、参数数组、输出解析、超时 | 直接修改配置文件 |
| `backend::fixture` | 匿名演示、错误注入、模拟任务 | 访问真实本机状态 |
| `terminal` | 初始化、恢复、挂起、panic hook | 数据轮询 |
| `ui` | 七页和通用组件 | 发起子进程 |
| `redact` | 控制序列清理和显示脱敏 | 改写原始日志文件 |

UI 只消费统一领域模型。Node CLI 的 legacy 字段和文本输出不得渗透到页面组件。

## 6. 主事件循环

```text
Tokio select
├── Crossterm Event → UserIntent → App reducer → 必要时提交 BackendJob
├── Refresh Tick    → 若对应请求不在途 → BackendJob
├── Backend Message → 更新 Resource<T> / ActionTask → 必要时二次查询
├── Resize          → 只重算布局
└── Shutdown        → 停止轮询、处理在途任务、恢复终端
```

原则：

- App 状态由单个 UI 事件循环拥有，避免到处使用共享可变锁。
- 后台任务通过有界 `mpsc` 返回带序号的不可变结果。
- UI reducer 不直接等待网络或子进程。
- 绘制频率与数据刷新频率分离；没有变化时可以低频重绘。
- 每次提交查询生成 `request_id`；只有最新请求可以替换对应资源。

## 7. 资源状态模型

每类远程数据使用统一资源状态：

```text
Resource<T>
├── data: Option<T>                 最近一次成功数据
├── last_success: Option<Instant>   最近成功时间
├── refreshing: Option<RequestId>   当前在途查询
├── error: Option<BackendError>     最近失败
└── generation: u64                 失效代次
```

状态推导：

- 首次加载：`data=None + refreshing=Some`。
- 空数据：`data=Some(empty)`，不是错误。
- 刷新成功且有旧数据：直接替换并更新成功时间。
- 刷新失败且有旧数据：保留数据，同时设置 error/stale。
- 刷新失败且无旧数据：显示加载失败，不展示假 0。
- 写操作完成：增加相关 generation，使旧的只读响应失效，再查询真实状态。

stale 是“有旧数据但最近刷新失败或超过阈值”，不是简单按页面停留时间判断。

## 8. 后端能力接口

逻辑能力如下，具体 Rust 签名在实现阶段确定：

| 能力 | 输入 | 输出 |
|---|---|---|
| `providers` | 无 | Provider 列表和 enabled 集合 |
| `accounts` | 可选 provider | 分组账号列表 |
| `credits` | 可选 provider、强制刷新 | 按来源独立的额度结果 |
| `logs` | provider、尾部行数 | 文本块及来源说明 |
| `health` | provider 集合、是否真实试打 | 结构化逐项结果或诊断文本 |
| `doctor` | 无 | 退出码和脱敏文本 |
| `usage` | UsageRange | OpenCode 会话/Token/活动/工具/模型统计 |
| `execute` | 受控 Action | 任务输出、退出码和完成状态 |
| `interactive` | 登录/添加账号参数 | 终端挂起执行结果 |

`NodeBackend` 与 `FixtureBackend` 必须产生相同领域模型。测试可通过 FixtureBackend 注入部分失败、慢响应、未知字段和动作失败。

## 9. Action 状态机

```text
Draft
  → Confirming
  → Queued
  → Running
  → Succeeded / Failed
  → Refreshing（Succeeded 后）
  → Confirmed / RefreshFailed
```

规则：

- `Draft/Confirming` 不产生副作用。
- `Queued/Running` 对同一互斥范围去重。
- 子进程退出码为 0 只表示 CLI 成功，不直接改写 provider 当前状态。
- 非零退出码保留输出并进入 `Failed`，随后可以进行一次只读状态校正。
- `RefreshFailed` 必须区分“动作成功但状态尚未确认”和“动作失败”。
- 写操作不使用容易中途杀死的短超时；提供运行时间和输出，而不是静默卡死。

## 10. 互斥与调度

| 操作范围 | 互斥规则 |
|---|---|
| 单 provider 只读刷新 | 同数据源最多一个在途 |
| 单 provider 写操作 | 同 provider 最多一个写任务 |
| `all/none`、全局 reload | 与所有 provider 写任务互斥 |
| opencode sync | 与会影响客户端配置的写任务串行 |
| 不同 provider 写操作 | 默认可以排队，但 MVP 应优先全局串行以降低风险 |
| 登录/添加账号 | 与目标 provider 的账号切换和启停互斥 |

MVP 推荐“写任务全局串行、只读任务受控并发”。八家规模很小，简单和可解释优先于并行启动速度。

## 11. 刷新策略

| 数据 | 默认策略 | 手动刷新 |
|---|---|---|
| Provider 状态 | 5 秒；同请求不重叠 | `r` |
| 账号 | 进入页面、写操作后；不高频轮询 | 账号页 `r` |
| 额度 | 120 秒；允许后端缓存 | 额度页 `r` |
| OpenCode 用量 | 120 秒；按当前 UsageRange 查询 | 用量页 `r`，`t` 切换范围 |
| 日志 | 仅页面可见且跟随开启时约 1 秒 | 切换 provider/行数 |
| 健康 | 进入诊断页或显式执行，不持续后台试打 | `h` |
| 真实试打 | 从不自动执行 | `P` 加强确认 |

后端失败时采用有上限的只读退避；用户手动刷新可以立即重试，但仍需去重。窗口 resize 不触发数据刷新。

## 12. 终端生命周期

### 初始化

1. 解析参数并检查 stdin/stdout 是否适合交互。
2. 安装 panic/错误恢复路径。
3. 进入 raw mode 和 alternate screen，隐藏 cursor。
4. 创建事件流和 App；启动只读查询。

### 挂起

用于登录、PAT 等交互：

1. 停止本 TUI 的键盘消费和自动刷新。
2. 恢复 cursor、离开 alternate screen、关闭 raw mode。
3. 使用继承的 stdin/stdout/stderr 运行指定 CLI。
4. 等待子进程结束，不读取或保存用户输入的秘密。
5. 重新初始化终端，立即查询受影响状态。

### 退出

- 停止新的查询和写任务提交。
- 只读任务可以协作取消；写任务不能无条件强杀。
- 有活动写任务时提示等待或明确说明后果。
- 恢复顺序必须幂等：显示 cursor、关闭 raw mode、离开 alternate screen、flush。
- panic hook 先尽力恢复，再输出不包含敏感信息的错误。

## 13. 错误分类

| 类型 | 示例 | UI 行为 |
|---|---|---|
| 配置错误 | root 不存在、Node 路径错误 | 启动诊断，提供参数建议 |
| 启动错误 | 无法 spawn、权限不足 | 当前数据源失败，其他来源继续 |
| 超时 | 状态查询超时 | 保留旧数据，标记 stale |
| 输出错误 | 非 UTF-8、非法 JSON、混合 ANSI | 保留有限脱敏诊断，不 panic |
| 契约错误 | 字段类型不符、版本不支持 | 显示后端版本不兼容 |
| 业务失败 | provider 未登录、端点不可达 | 显示在该 provider 内，不升级为全局失败 |
| 动作失败 | 非零退出码 | 任务失败并可查看输出 |
| 平台不支持 | Linux 上 Windows 计划任务 | 禁用操作并说明具体原因 |

## 14. 配置与发现

优先级：

1. `--router-root`、`--node` 等显式参数；
2. `ROUTER_ROOT` 等文档化环境变量；
3. 当前目录若包含 `router.mjs`；
4. 当前目录父目录若包含 `router.mjs`。

不依赖编译机器上的绝对路径。安装后的 binary 不能假设仍在仓库 `tui/` 下。

MVP 不需要额外用户配置文件。刷新间隔等先通过 CLI 参数提供，避免同时维护多套配置来源。

## 15. 性能与资源预算

- 八家 provider 下，状态表格应保持简单 O(n) 汇总。
- 单 provider 日志视图最多保留 2000 行；操作输出同样设上限。
- 单行日志和任务输出设置显示长度上限，完整原始内容仍由用户通过既有文件查看。
- 查询通道必须有界，慢后端不能造成无限排队。
- 后台等待期间键位应在下一次事件循环得到处理，不能等待子进程完成才重绘。

这些是设计预算，不是尚未测量的性能承诺；实施后以测试和实测结果修订。

## 16. 可扩展方向

当前用量统计通过 `NodeBackend::usage(UsageRange)` 调用 OpenCode 官方 CLI 的 `experimental.session.stats`，获得真实聚合数据；不从进程日志反推 Token 或费用。Windows 优先使用官方 `opencode.exe`，Linux 使用 PATH 中的 `opencode`，也可用 `ROUTER_OPENCODE` 覆盖。后续新增逐请求遥测时，应新增独立 `TelemetryBackend`，而不是把进程日志正则解析伪装成指标。远程后端也应作为新的 Backend 实现，先完成认证、授权、TLS 和威胁模型，不能直接复用本地明文 CLI 假设。
