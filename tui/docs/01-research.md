# 01 调研与设计取舍

日期：2026-11-05  
状态：设计基线

## 1. 调研目的

调研网上 AI 提供商、AI Gateway 和可观测性产品的控制台，提取适合本项目的交互与指标，同时识别哪些能力缺乏本地数据源、不能直接进入 MVP。

本轮以可公开访问的官方文档为主。部分 OpenAI、Anthropic、Groq 控制台文档受到登录、区域或访问限制，因此本文不描述无法核实的界面细节，也不声称覆盖所有厂商。

## 2. 网上产品调研

### 2.1 OpenRouter

资料：

- [Activity Export](https://openrouter.ai/docs/cookbook/administration/activity-export.md)
- [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Analytics Cost Control](https://openrouter.ai/docs/cookbook/administration/analytics-cost-control.md)

观察：

- Activity 以 Spend、Tokens、Requests 为核心指标。
- 支持 1 小时、1 天、1 月、1 年等时间范围，并按 Model、API Key、Creator 分组。
- 路由决策综合有效价格、吞吐、TTFT、429、可靠性和工具调用质量。
- 分析接口提供模型、Key、Token、缓存和费用组成等维度。

可借鉴：

- 总览只放最关键的指标，详细维度进入下钻页面。
- 指标必须有筛选范围、时间范围和数据来源。
- provider 详情应能解释异常，而不是只显示一个颜色。

不直接照搬：

- 当前 router 不是 OpenRouter 式的实时智能路由层，没有统一请求分析数据库。
- 当前十三家厂商的 credits 不是统一货币，不能合并成 OpenRouter 式 Spend。

### 2.2 LiteLLM Admin UI

资料：

- [Admin UI Quick Start](https://docs.litellm.ai/docs/proxy/ui)
- [Customer Usage](https://docs.litellm.ai/docs/proxy/customer_usage)
- [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys)
- [UI Logs](https://docs.litellm.ai/docs/proxy/ui_logs)
- [Load Balancing](https://docs.litellm.ai/docs/proxy/load_balancing)

观察：

- 管理面覆盖模型、Key、用户、团队、预算、限流和路由。
- Usage 展示费用趋势、模型分布、请求、Token 和成功率。
- 日志可以查看错误和工具调用；请求/响应内容默认不保存，需要显式开启。
- 费用可按 Key、用户、团队和最终用户归属。

可借鉴：

- 将服务控制、额度账号、日志诊断拆成独立页面。
- 内容记录默认关闭，敏感数据不能因为“可观测”而无限收集。
- 每个数字都应有归属维度，不把服务在线与账号可用混为一谈。

不直接照搬：

- 本项目是个人本机控制器，MVP 不需要虚拟 Key、团队、RBAC 或计费数据库。

### 2.3 Vercel AI Gateway

资料：

- [Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability)
- [Request Logs](https://vercel.com/docs/ai-gateway/observability-and-spend/logs)

观察：

- 总览包含模型请求量、TTFT、输入/输出 Token 和 Spend。
- 汇总可按项目、API Key 查看，包含请求数、平均 Token、P75 Duration、P75 TTFT 和成本。
- 请求日志支持状态、模型、provider、延迟、Token、成本和时间范围过滤。
- 日志详情能够展示每次 provider 路由尝试，Live 模式可以暂停和跟随。

可借鉴：

- 日志页需要筛选、暂停、跟随和详情，而非只运行一次 `tail`。
- 聚合视图和单条详情的职责不同。
- 过滤条件必须明确作用于当前数据集。

不直接照搬：

- 当前日志是反代进程日志，不是结构化请求日志；首版不能承诺 TTFT、路由尝试或费用字段。

### 2.4 Portkey

资料：

- [Observability](https://portkey.ai/docs/product/observability)
- [Analytics](https://docs.portkey.ai/docs/product/observability/analytics.md)

观察：

- Analytics 覆盖成本、Token、延迟、请求、Top Models、用户、错误、缓存和反馈。
- Summary 能按 AI Service、模型、metadata 等维度聚合。
- 错误分析区分 API 错误、准确性问题和被路由策略挽救的请求。

可借鉴：

- 总览需要异常摘要和可操作的诊断入口。
- provider 维度比单纯全局数字更适合当前项目。
- 后续若增加遥测，可优先实现 provider/model 分组和错误率。

### 2.5 Helicone

资料：

- [Quickstart](https://docs.helicone.ai/getting-started/quick-start)
- [Platform Overview](https://docs.helicone.ai/getting-started/platform-overview.md)

观察：

- 重点是请求级成本、延迟、错误和调试。
- 将可观测性与 Gateway/fallback 结合，用于定位 provider 故障和费用异常。

可借鉴：

- 故障处理路径应短：总览异常 → provider → 日志/诊断。
- 展示真实错误原因比增加装饰性图表更重要。

### 2.6 Ratatui 与 Crossterm

资料：

- [Ratatui Installation](https://ratatui.rs/installation/)
- [Ratatui Backends](https://ratatui.rs/concepts/backends/)

观察：

- Ratatui 默认 Crossterm 后端适合跨平台终端。
- Ratatui 0.30.2 文档对应 Crossterm 0.29，MSRV 为 Rust 1.88。
- 不应混用多个不兼容的 Crossterm major 版本，否则事件队列和 raw mode 状态可能分离。
- `TestBackend` 可用于不依赖真实终端的渲染测试。

设计结论：实施时锁定互相匹配的 Ratatui/Crossterm 版本，并通过 Cargo.lock 保证可重复构建。

### 2.7 OpenCode V2

资料：

- [TUI Plugins](https://opencode.ai/v2/docs/build/plugins/cli)
- [HTTP API](https://opencode.ai/v2/docs/api)
- [Theme](https://opencode.ai/v2/docs/cli/theme)

观察：

- TUI 插件可以直接访问会话、消息、成本、模型、Provider 和主题 token。
- `GET /api/experimental/session/stats` 已提供会话、步骤、Token、缓存、每日活动、工具统计和模型聚合。
- 分类色与语义色适合做 provider 区分，不需要复刻 OpenCode 私有组件。

可借鉴：

- 用量页使用“指标卡 + 活动趋势 + 模型/Provider 聚合”。
- 真实统计优先于逐个拉取会话消息或解析日志。
- steps 必须按 OpenCode 原义展示，不能改名成 HTTP 请求数。

## 3. 本地能力盘点

### 3.1 已有控制面

根目录 [`router.mjs`](../../router.mjs) 已提供：

- `list --json`：十三家 provider 的开关、运行、PID、端口、模型数、opencode 和认证描述。
- `account --json`：账号 key、名称、启用、当前生效、详情和是否可切换。
- `up`、`down`、`restart`：进程生命周期。
- `on`、`off`、`all`、`none`：启用选择、进程和 opencode 联动。
- `sync`：客户端配置同步。
- `logs`：provider 日志尾部。
- `login`：浏览器或终端交互登录。
- `doctor`：环境自检。

因此 TUI 不应直接改写 PID 文件、账号文件或 opencode 配置。

### 3.2 已有健康与额度

- [`scripts/health.mjs`](../../scripts/health.mjs) 已检查模型端点、模型数、凭证有效期，并可显式执行真实对话试打。
- [`qodbuddy2pi/docs/credits.md`](../../integrations/qodbuddy2pi/docs/credits.md) 记录了 Qoder、Trae、CodeArts、WorkBuddy 的额度或凭证来源。
- `qoder2pi credits json` 已能返回结构化额度数据。
- WorkBuddy 的“余额”主要是凭证有效期和服务状态，不应显示为 credits。

### 3.3 已有 TUI 经验

[`assets/tui.js`](../../integrations/qodbuddy2pi/assets/tui.js) 提供了值得保留的本地设计经验：

- 真彩色、256 色、16 色和无色降级。
- 暗色/亮色语义色板。
- 全屏界面暂时挂起，以便运行交互式登录。
- 键盘导航、文本详情页和刷新提示。

新实现可以借鉴这些行为，但不在 Rust 中复用 Node 渲染代码。

## 4. 综合差距

| 目标 | 当前数据 | 设计处理 |
|---|---|---|
| 十三家服务状态 | 已有 JSON | MVP 直接接入 |
| 账号池与当前账号 | 已有 JSON | MVP 直接接入 |
| 积分与签到 | 已有 JSON，能力因 provider 而异 | 分来源展示，按能力提供操作 |
| 凭证状态 | 有布尔值和描述文本 | 补充结构化状态和到期时间，避免解析文案 |
| 健康检查 | 有人类文本 | 增加 JSON 输出或作为文本诊断，不用脆弱正则推导状态 |
| 会话/步骤、Token、缓存、活动、工具统计、模型聚合 | OpenCode 官方 stats | 已接入“7 用量” |
| TTFT、P75/P99、吞吐量 | 无持续采样 | 不进入 MVP |
| HTTP 请求成功率、错误率、逐请求日志 | 无统一请求事件 | 不进入 MVP；工具成功率单独展示 |
| 路由策略质量 | 当前不是统一智能路由 | 不设计虚假的控制器 |

## 5. 设计决策

### D-02 没有遥测就没有分析图

MVP 只显示能由当前 CLI、状态文件、本地网关或 OpenCode 官方统计接口真实取得的数据。后续若需要请求趋势，必须先设计独立请求事件契约，至少包含时间、provider、模型、状态、Token、延迟和费用来源；在数据可靠性验证前不上线图表。OpenCode `experimental.session.stats` 已提供可验证的聚合来源，因此会话/步骤、Token、活动和模型统计已按真实口径接入。

### 运维优先于“网页仪表盘复刻”

终端界面采用高密度表格、详情和快捷键，不机械复制网页卡片。优先级为：

1. 当前是否可用；
2. 不可用时为什么；
3. 用户能采取什么安全操作；
4. 额度和账号是否即将影响可用性；
5. 最后才是趋势分析。

## 6. 调研结论

最适合本项目的是“LiteLLM 的管理分面 + OpenRouter 的 provider 视角 + Vercel 的日志交互 + 本地现有运维语义”，而不是建设一套新的 AI Gateway。首版的成功标准是让十三家本地反代**看得清、控得准、出错能定位**，而不是图表数量。
