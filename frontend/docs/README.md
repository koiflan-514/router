# Router 网页面板文档索引

本目录是 `frontend/` 网页面板的**设计基线与实现记录**，当前基线覆盖十三家本机反代 + `gateway`
叠加层；provider 清单以 `node router.mjs list`、[00 设计基线](00-design-baseline.md) §4 与根 README 为准。

当前状态：**MVP 已实现**——
文档、React 19 前端、回环桥接服务、单元/契约/E2E 测试均已完成。进度与差距见
[13 实现状态](13-implementation-status.md)。

唯一事实来源是 [00 设计基线](00-design-baseline.md)；其余文档不得与它冲突。

## 约定

- **必须**：实现与验收的强制条件。
- **应该**：默认遵循；偏离时记录原因。
- **可以**：可选能力，不影响首版完整性。
- `MVP`：首个可用版本。
- `后续`：有方向但不进入 MVP 承诺。
- 所有 JSON、账号和日志示例均为**匿名虚构数据**，不代表本机真实状态。
- 命令分"现有命令"（可直接执行）与"计划命令"（实现前不可执行）。

## 推荐阅读顺序

### 产品与交互

1. [00 设计基线](00-design-baseline.md)
2. [01 调研与设计取舍](01-research.md)
3. [02 产品需求](02-requirements.md)
4. [03 界面设计](03-ui-design.md)
5. [12 术语表](12-glossary.md)

### 技术与安全

1. [04 技术架构](04-architecture.md)
2. [05 后端契约](05-backend-contract.md)
3. [06 设计系统](06-design-system.md)
4. [07 安全与隐私](07-security.md)
5. [08 运行与部署](08-operations.md)

### 交付

1. [09 测试策略](09-testing.md)
2. [10 实施计划](10-implementation-plan.md)
3. [11 可访问性与国际化](11-accessibility-i18n.md)
4. [13 实现状态](13-implementation-status.md)
5. [14 用量分析设计](14-usage-analytics.md)

## 文档责任

| 变更 | 必须同步检查 |
|---|---|
| 页面、路由、键位或弹窗 | `02-requirements.md`、`03-ui-design.md`、`09-testing.md` |
| 桥接端点或 JSON 字段 | `04-architecture.md`、`05-backend-contract.md`、`09-testing.md` |
| 启停、账号、登录、签到语义 | `04-architecture.md`、`07-security.md`、`12-glossary.md` |
| 设计 token 或组件 | `03-ui-design.md`、`06-design-system.md`、`11-accessibility-i18n.md` |
| 安全边界 | `04-architecture.md`、`05-backend-contract.md`、`07-security.md` |
| 实施顺序或 MVP 范围 | `02-requirements.md`、`10-implementation-plan.md`、`../README.md` |
| 端口、构建或部署流程 | `04-architecture.md`、`05-backend-contract.md`、`08-operations.md` |
| 新增真实数据源 | `01-research.md`、`04-architecture.md`、`05-backend-contract.md`、`07-security.md` |

## 核心决策索引

| 编号 | 决策 | 位置 |
|---|---|---|
| W-01 | 复用 Node CLI 与网关，不复制进程/账号逻辑；桥接只监听回环 | [架构](04-architecture.md) |
| W-02 | 浏览器不直连网关（无 CORS、不能控制进程），一律经桥接 | [契约](05-backend-contract.md) |
| W-03 | URL 即状态：选中 provider、时间范围、过滤、排序进 search params | [界面](03-ui-design.md) |
| W-04 | 服务端状态用 TanStack Query，写操作用 React 19 Actions，不预改状态 | [架构](04-architecture.md) |
| W-05 | 开关、进程、客户端配置、认证是四个独立状态，漂移由后端字段推导 | [术语](12-glossary.md) |
| W-06 | 不汇总不同厂商积分；steps 不等于请求数；cost 不折算积分 | [需求](02-requirements.md) |
| W-07 | 危险操作显式确认、默认取消；写任务全局串行 | [界面](03-ui-design.md) |
| W-08 | 只读/演示模式在桥接层拦截，不靠前端隐藏 | [安全](07-security.md) |
| W-09 | 第三方依赖有预算上限并集中审计（面板必须有构建期依赖，与"零依赖"核心区分） | [安全](07-security.md) |

## 与 TUI 文档的关系

网页面板与 `router-tui`（`tui/`）共享目标、页面划分、状态口径和安全边界，但技术栈不同。
差异对照：

| 主题 | TUI | 网页面板 |
|---|---|---|
| 媒介 | 终端（Ratatui/Crossterm） | 浏览器（React 19 + Vite） |
| 数据 | 直接 spawn Node CLI | 桥接服务（spawn CLI + 代理网关 + SSE） |
| 键位 | 数字键切页、单键操作 | 点击 + 键盘快捷键 + 命令面板（⌘K） |
| 主题 | 终端 16/256/真彩 | CSS 变量 + Tailwind，dark/light/system |
| 窄屏 | 终端列数降级 | 响应式断点 + 抽屉侧栏 |
| 图表 | Sparkline（文本） | Recharts（面积/柱/折线） |
| 用量口径 | 相同（OpenCode `experimental.session.stats`） | 相同，来自同一只读接口 |

术语以上位定义 [`tui/docs/12-glossary.md`](../../tui/docs/12-glossary.md) 为准，前端新增术语记入本
目录的 [12 术语表](12-glossary.md)。
