# 14 用量分析与视觉设计

状态：已实现（视觉重构 2026-11-25）  
数据来源：OpenCode V2 官方会话统计 API  
更新日期：2026-11-25

## 1. 目标

“用量分析”回答的是：

- 最近一段时间有多少会话、提示和会话步骤？
- 输入、输出、推理和缓存 Token 各是多少？
- 哪些模型和 provider 被使用最多？
- 每日活动如何变化？
- 工具调用的成功率如何？
- OpenCode 上报的成本是多少？

不把积分余额、进程在线时长或反代日志行数冒充为请求用量。

## 2. 参考产品

### OpenRouter Activity

参考其 Spend、Tokens、Requests 三类核心指标，以及按时间范围和模型分组的交互。Router TUI 保留“顶部 KPI + 活动趋势 + 模型聚合”的结构，但不把 OpenCode 的 `steps` 改名为 Requests。

参考：[OpenRouter Activity Export](https://openrouter.ai/docs/cookbook/administration/activity-export.md)

### Vercel AI Gateway

参考其总览 KPI、模型请求分布、Token 和按范围查看的方式。Vercel 的 TTFT、P75 延迟和逐请求路由尝试需要更细粒度事件，本功能不伪造这些指标。

参考：[Vercel AI Gateway Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability)

### OpenCode V2

OpenCode 官方 TUI 插件提供会话列表、消息、成本、模型、Provider、主题 token 和分类色板。官方统计接口直接返回聚合结果，避免 TUI 逐个拉取消息或读取数据库。

参考：

- [OpenCode TUI Plugins](https://opencode.ai/v2/docs/build/plugins/cli)
- [OpenCode HTTP API](https://opencode.ai/v2/docs/api)
- [OpenCode Theme](https://opencode.ai/v2/docs/cli/theme)

本实现借鉴语义色和分类色思想，不复制 OpenCode 私有 UI 结构。

## 3. 真实数据源

### 3.1 官方统计接口

```bash
opencode api experimental.session.stats \
  --param from=<unix-ms> \
  --param to=<unix-ms> \
  --param tools=summary
```

对应 OpenAPI：

```text
GET /api/experimental/session/stats
```

响应顶层为：

```json
{
  "data": {
    "range": { "from": 0, "to": 0 },
    "sessions": 0,
    "subagents": 0,
    "prompts": 0,
    "steps": 0,
    "tokens": {},
    "cost": 0,
    "tools": {},
    "activeDays": 0,
    "streak": 0,
    "activity": [],
    "models": []
  }
}
```

TUI 只消费这个只读接口：

- 不读取 OpenCode SQLite/数据库；
- 不读取或修改会话标题、提示词和响应正文；
- 不调用 `session.message.list` 生成近似统计；
- 不解析反代日志来猜测 Token 或费用。

### 3.2 字段与口径

| 字段 | 展示 | 说明 |
|---|---|---|
| `sessions` | 会话数 | OpenCode 会话数量 |
| `subagents` | 子会话/子代理数 | 当前只在详情数据中使用 |
| `prompts` | 提示数 | 不等同于模型请求数 |
| `steps` | 会话步骤 | **不等于 HTTP 请求数** |
| `tokens.input` | 输入 Token | OpenCode 上报值 |
| `tokens.output` | 输出 Token | OpenCode 上报值 |
| `tokens.reasoning` | 推理 Token | OpenCode 上报值 |
| `tokens.cache.read` | 缓存读取 Token | 单独展示，不重复累计 |
| `tokens.cache.write` | 缓存写入 Token | 单独展示，不重复累计 |
| `cost` | OpenCode 上报成本 | 不等于厂商积分余额，也不自行折算 |
| `tools.totals` | 工具调用统计 | 成功、失败、未完成及成功率 |
| `activeDays` | 活跃日 | 有活动的天数 |
| `streak` | 连续活跃 | 原样展示 |
| `activity[].steps` | 每日活动 | 用于 Sparkline |
| `models[]` | 模型/Provider 聚合 | 按 steps 降序，可查看 Token 详情 |

`Token 构成` 的概览值为 `input + output + reasoning`。缓存读写在另列展示，避免重复解释或错误求和。

### 3.3 时间范围

| 选项 | 起点 |
|---|---|
| 近 24 小时 | 当前 Unix 毫秒时间戳减 24 小时 |
| 近 7 天 | 当前时间减 7×24 小时 |
| 近 30 天 | 当前时间减 30×24 小时 |
| 全部历史 | `from=0` |

默认是近 7 天。`to` 是本次查询的当前时间，不使用本地写死的日期。

### 3.4 启动 OpenCode

Windows 上优先解析官方原生 CLI：

```text
%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe
```

它来自 `opencode.cmd` 所指向的实际可执行文件，避免通过 `.cmd` 或 PowerShell 启动。其他环境使用 PATH 中的 `opencode`。可用 `ROUTER_OPENCODE` 指定其他 CLI 路径。

OpenCode CLI 负责服务发现与认证上下文，TUI 不猜测服务端口或手工构造未认证请求。

## 4. 页面设计

### 4.1 “7 用量”页

标准高度下由四部分组成：

1. **KPI 卡**：会话/步骤、Token、成本、活跃/连续、工具成功率；窄屏截断到 3–4 张。
   工具成功率主数字已是百分比，副行只写成功/调用数（如 `116/120`），不重复 `116/120 · 96.7%`。
2. **每日活动 Sparkline**：按 OpenCode `activity` 绘制，带时间范围、峰值与上报成本。
3. **Token 构成横条 + 工具成功率矩形环**：输入/输出/推理分段，缓存读写另计；成功率带图例。
4. **模型/Provider 表**：模型、Provider、Steps、输入、输出、推理、缓存读取、成本、行内 steps 占比。

模型表默认按 Steps 降序，并随选中项滚动；`s` 在步骤/Token/成本/名称间循环排序（纯前端，不重新请求）。
窄屏减少输入和推理列，详情中仍保留完整数据；高度不足时先压缩说明与 Token 区，KPI 与表格保留。

### 4.2 总览 KPI

总览顶部使用同一数据源显示四张指标卡，让服务状态与近期用量同屏可见。服务表格仍独立显示开关、进程、认证和客户端配置。

### 4.3 操作

| 键位 | 行为 |
|---|---|
| `7` | 打开用量页 |
| `↑↓` / `jk` | 选择模型 |
| `Enter` | 查看模型完整 Token 与成本详情 |
| `t` | 切换近 24 小时、近 7 天、近 30 天、全部历史 |
| `s` | 循环排序：步骤 → Token → 成本 → 名称（纯前端，不重新请求） |
| `r` | 刷新当前范围和 OpenCode 状态 |
| `O` | 查看最近操作输出 |
| `?` | 查看帮助 |

## 5. 视觉规范

- 颜色只来自 `Tone` 语义层（Accent/Success/Warning/Error/Info/Muted/Normal），页面不直接写 `Color`。
- Provider 使用稳定分类色：CodeArts 紫、Qoder 国内青、Qoder 国际蓝、Trae 绿、WorkBuddy 黄、
  WorkBuddy 国际浅紫、ZCode 橙、Loomy 洋红、小浣熊红、千问办公浅绿、Gateway 中性。
  百度搭子、WPS 灵犀、有道龙虾暂回退默认前景色（见 [13 实现状态](13-implementation-status.md) 已知差距）。
- KPI 卡、Sparkline、Token 横条、矩形环和表格使用统一圆角/边框；行内 steps 占比条使用 `█░`。
- 表头使用低亮度底色，选中行使用高对比前景与背景（无色模式用 REVERSED）。
- 状态不仅靠颜色：数值、文字、单位和图例始终存在。
- `NO_COLOR` 与 `--ascii` 下保持可读：无色退化为 BOLD/DIM/REVERSED，ASCII 覆盖边框、选中、
  进度、sparkline 与环；无数据时使用文字而不是空白图表。

## 6. 错误与数据边界

- OpenCode CLI 不存在时，用量页显示明确错误，其他页面继续工作。
- 查询超时、API 不兼容或 JSON 字段错误时，保留上一份数据并标记 `stale`。
- 没有会话或模型时显示空状态，不生成随机演示值。
- 只有 `--demo` 使用匿名虚拟用量，且明确标记 DEMO。
- `steps` 永远不显示为“请求数”。
- `cost=0` 是 API 返回值，不解释为“没有消耗积分”。
- 工具成功率不代替模型请求成功率；主数字是百分比，副行不再重复百分比。

## 7. 验证

已覆盖：

- OpenCode 响应解析和 providerID 映射。
- 时间范围、Token 求和、工具成功率。
- 模型 Steps 排序和选择；`s` 四档排序只改渲染顺序、不触发请求。
- KPI、Sparkline、Token 横条、工具成功环、模型表及总览卡片渲染；120×40 / 80×24 / 60×20。
- 空数据、后端失败、`--ascii`、`--no-color` 均有渲染用例。
- Windows 原生 OpenCode CLI 的真实只读调用。
- Windows PTY：启动后按 `7`，等待 `Model/Steps/codearts` 出现后退出；Linux demo 与普通只读 PTY 另行验证。

真实统计只用于本机展示，不写入项目 fixtures 或文档。

## 8. 当前限制与后续

当前统计接口不提供：

- TTFT、P75/P99 延迟；
- HTTP 请求数与逐请求成功率；
- 每次 provider 路由尝试；
- 逐请求输入/输出详情；
- 积分消耗与 Token 的可靠兑换关系。

如后续需要这些能力，应使用 OpenCode `session.message.list` 或反代自身的结构化事件，单独设计去重、时间范围和隐私规则，不从进程日志反推。CodeArts 的 `/metrics` 可作为网关请求数、失败数、输出字符和进程运行时间的补充，但不能替代 OpenCode 的 Token 统计。
