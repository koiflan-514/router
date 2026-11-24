# Router 网页面板

> **适合**：想用浏览器面板管理本机 router。  
> **前置**：Node.js 20+；首次运行需 `cd frontend && npm install`。  
> **相关**：[文档索引](../docs/README.md) · [前端文档](docs/README.md) · [根 README](../README.md)

> **时效说明**：网页面板当前的白名单与设计基线覆盖 9 家本机反代；新增的千问办公、百度搭子、WPS 灵犀、有道龙虾请用 CLI 或 TUI。

> 状态：**MVP 已实现（文档 + 代码 + 测试）**
> 目标平台：现代桌面浏览器（Chromium / Firefox / Safari 最新稳定）
> 运行时：本机 Node.js（桥接服务）+ 浏览器（React 19 单页应用）
> 边界：面板本身跨浏览器；具体 provider 能力仍取决于本机 Node router 与第三方反代

`frontend/` 是 router 的**浏览器控制台**。它不替代根目录的 [`router.mjs`](../router.mjs)
和 [`gateway/`](../gateway/README.md)，而是通过一个**只监听回环的 Node 桥接服务**复用它们：
把 CLI 的 `--json` 输出规范化为统一领域模型，把网关的 HTTP 端点代理给它，并用 SSE 推送
日志与任务进度。

它与 [`tui/`](../tui/README.md) 是同一套语义的两个前端：页面划分、状态口径、操作确认与
安全边界一致；技术栈与交互媒介不同。设计原则上，**TUI 的文档是首选参照物**。

## 设计目标

- **看得清**：九家 provider 的开关、进程、客户端配置、认证四个状态分别可见，配置漂移一眼可见。
- **控得准**：启停、重启、仅启用、关闭、同步、账号切换都有确认；写操作全局串行、操作后重新查询。
- **出错能定位**：从总览异常一键进入对应 provider 的日志或诊断，三秒内看到原因。
- **不虚构数据**：只展示 CLI、本地网关或 OpenCode 官方统计能真实取得的数据。

## 技术栈

| 组件 | 选择 |
|---|---|
| 框架 | React 19（最新稳定）、TypeScript |
| 构建 | Vite |
| 路由 | TanStack Router（search 参数即状态） |
| 数据 | TanStack Query v5 |
| UI | Tailwind CSS + shadcn/ui + Radix |
| 图表 / 表格 | Recharts（shadcn chart）、TanStack Table |
| 校验 | Zod（契约运行时校验） |
| 测试 | Vitest、React Testing Library、MSW、Playwright |
| 桥接 | Node.js（`frontend/server/`），仅监听 `127.0.0.1:8792` |

## 运行方式

```bash
# 开发（Vite dev server，代理到桥接）
cd frontend
npm install
npm run dev            # http://127.0.0.1:5173

# 生产（桥接同时服务静态站点与 /api）
npm run build
npm run start          # http://127.0.0.1:8792

# 匿名演示：不 spawn 任何进程、不读真实文件
npm run start -- --demo
```

以上命令均为**已实现**。`npm run dev:all` 会同时拉起桥接（`--dev`）与 Vite；也可在
两个终端分别运行 `npm run dev:bridge` 和 `npm run dev`。

验证：

```bash
npm run typecheck                # tsc --noEmit
npm test                         # vitest：单元 + 契约 + 桥接集成
npm run build                    # 生产构建（桥接随后托管 dist）
npx playwright test              # E2E（demo，无需凭证）
PANEL_REAL_SMOKE=1 npx vitest run tests/bridge-real.test.ts   # 可选：真实只读冒烟
```

## 页面

| 页面 | 路由 | 回答的问题 |
|---|---|---|
| 总览 | `/` | 九家现在能不能用？哪里漂移？ |
| 服务 | `/providers` | 谁在跑？怎么启停/重启/开关/同步？ |
| 额度 | `/quota` | 余额、凭证天数、签到、重置日？ |
| 账号 | `/accounts` | 当前生效谁？怎么切/恢复整池？ |
| 日志 | `/logs` | 某家为什么报错？ |
| 诊断 | `/diagnostics` | doctor / 健康 / 试打结果？ |
| 用量 | `/usage` | OpenCode 会话 / Token / 工具 / 模型聚合？ |
| 网关 | `/gateway/*` | 调度、用量、降级链、密钥、免费供应商、本地应答 |
| 设置 | `/settings` | 主题、刷新间隔、只读、桥接连接、演示模式 |

## 安全语义

- 桥接**只监听回环**；非回环来源一律拒绝。
- JSON 中不出现任何 token、PAT、API Key、Authorization、session、签名或提示词正文。
- 命令一律参数数组 spawn；禁止 `sh -c` / `cmd /c` / PowerShell 拼接。
- 写操作需显式确认，高风险操作列出受影响名单，默认焦点为"取消"。
- `--read-only` 与 `--demo` 在**桥接层**拦截，不靠前端隐藏按钮。
- 日志/任务输出在展示前剥离终端控制序列并脱敏常见密钥。

## 文档

设计基线见 [文档索引](docs/README.md)。核心文档：

- [00 设计基线](docs/00-design-baseline.md)
- [01 调研与设计取舍](docs/01-research.md)
- [02 产品需求](docs/02-requirements.md)
- [03 界面设计](docs/03-ui-design.md)
- [04 技术架构](docs/04-architecture.md)
- [05 后端契约](docs/05-backend-contract.md)
- [06 设计系统](docs/06-design-system.md)
- [07 安全与隐私](docs/07-security.md)
- [08 运行与部署](docs/08-operations.md)
- [09 测试策略](docs/09-testing.md)
- [10 实施计划](docs/10-implementation-plan.md)
- [11 可访问性与国际化](docs/11-accessibility-i18n.md)
- [12 术语表](docs/12-glossary.md)
- [13 实现状态](docs/13-implementation-status.md)
- [14 用量分析设计](docs/14-usage-analytics.md)

---

← 返回 [文档索引](../docs/README.md) ｜ [前端文档](docs/README.md)
