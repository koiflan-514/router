# Router TUI 文档索引

本目录是 `router-tui` 的设计基线与实现记录。MVP 代码已存在；实际完成度、测试结果和已知差距见 [13 实现状态](13-implementation-status.md)。

## 约定

- **必须**：实现和验收的强制条件。
- **应该**：默认遵循；偏离时必须记录原因。
- **可以**：可选能力，不影响首版完整性。
- `MVP`：首个可用版本。
- `后续`：已有方向但不进入 MVP 承诺。
- 所有 JSON、账号和日志示例均为匿名虚构数据，不代表本机真实状态。
- 文档中的命令分为“现有命令”和“计划命令”；计划命令在实现前不可执行，当前状态见实现记录。

## 推荐阅读顺序

### 产品与交互

1. [01 调研与设计取舍](01-research.md)
2. [02 产品需求](02-requirements.md)
3. [03 界面设计](03-ui-design.md)
4. [12 术语表](12-glossary.md)

### 技术与安全

1. [04 技术架构](04-architecture.md)
2. [05 后端契约](05-backend-contract.md)
3. [06 操作手册](06-operations.md)
4. [07 安全与隐私](07-security.md)
5. [08 跨平台设计](08-cross-platform.md)

### 交付

1. [09 测试策略](09-testing.md)
2. [10 实施计划](10-implementation-plan.md)
3. [11 发布与运维](11-release.md)
4. [13 实现状态](13-implementation-status.md)
5. [14 用量分析与视觉设计](14-usage-analytics.md)

## 文档责任

| 变更 | 必须同步检查 |
|---|---|
| 页面、键位、状态或弹窗 | `02-requirements.md`、`03-ui-design.md`、`09-testing.md` |
| CLI 参数或 JSON 字段 | `04-architecture.md`、`05-backend-contract.md`、`09-testing.md` |
| 启停、账号、登录、签到语义 | `06-operations.md`、`07-security.md`、`12-glossary.md` |
| 平台或终端支持范围 | `02-requirements.md`、`08-cross-platform.md`、`11-release.md` |
| 实施顺序或 MVP 范围 | `02-requirements.md`、`10-implementation-plan.md`、`../README.md` |
| 新增真实数据源 | `01-research.md`、`04-architecture.md`、`05-backend-contract.md`、`07-security.md` |

## 核心决策索引

| 编号 | 决策 | 位置 |
|---|---|---|
| D-01 | Rust TUI 复用 Node.js 控制后端，不复制生命周期逻辑 | [架构](04-architecture.md#d-01-复用-nodejs-控制后端) |
| D-02 | MVP 不虚构请求级分析指标 | [调研](01-research.md#d-02-没有遥测就没有分析图) |
| D-03 | 开关、进程、客户端配置是三个独立状态 | [术语](12-glossary.md#服务状态) |
| D-04 | 所有副作用操作都由用户显式触发 | [操作](06-operations.md#操作分级) |
| D-05 | 跨平台 TUI 不等于第三方反代全部跨平台 | [跨平台](08-cross-platform.md#支持边界) |
| D-06 | JSON 做增量兼容，TUI 不解析人类文本来推导状态 | [契约](05-backend-contract.md#兼容策略) |
| D-07 | 不汇总不同厂商积分为统一价值指标 | [需求](02-requirements.md#额度与单位规则) |
| D-08 | 真实凭证不进入源码、fixtures、测试日志或发布包 | [安全](07-security.md#凭证与个人信息) |
| D-09 | 用量分析使用 OpenCode 官方统计，steps 不等于 HTTP 请求数 | [用量分析](14-usage-analytics.md) |

## 基线完成条件

设计阶段被认为完成，是因为：

- 六个目标页面均有功能、状态和交互定义；
- 八家现有 provider 均有真实数据来源；
- 所有有副作用的现有命令均有明确映射和确认规则；
- Windows/Linux 的支持边界和测试方式已定义；
- 后端契约、测试计划、实施顺序和发布流程可以指导后续开发；
- 未通过写代码来验证假设，也未声称功能已经存在。
