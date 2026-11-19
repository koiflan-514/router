# 14 用量分析设计

状态：设计基线（文档阶段，尚未实现）
数据来源：OpenCode V2 官方会话统计 API
对应需求：FR-160–169
更新日期：2026-11-12
上位文档：[00 设计基线](00-design-baseline.md) §5/§7/§8/§10、[TUI 用量分析与视觉设计](../../tui/docs/14-usage-analytics.md)

> 本文只定义**用量页的数据口径与图表呈现**，不定义网关调度。用量页路由 `/usage`（页面 ID
> `usage`），与网关用量页 `/gateway/usage` 是**两个页面、两套口径**，不得互相混用（见 §7）。
> 术语以 [`tui/docs/12-glossary.md`](../../tui/docs/12-glossary.md) 为上位定义，字段名与 TUI 对齐。

## 1. 目标与问题

用量页回答以下问题，且**只**回答这些问题（FR-160–169）：

| 需求 | 问题 | 对应呈现 |
|---|---|---|
| FR-160 | 最近一段时间有多少会话、提示？ | KPI 卡「会话 / 提示」 |
| FR-161 | 会话规模有多大？ | KPI 卡「会话步骤」 |
| FR-162 | 输入、输出、推理和缓存 Token 各是多少？ | KPI 卡「Token 构成」+ 模型表分列 |
| FR-163 | 哪些模型和 provider 被使用最多？ | 模型 / Provider 表格（按 steps 降序） |
| FR-164 | 每日活动如何变化？ | 每日活动面积图 + `activeDays`/`streak` |
| FR-165 | 工具调用的成功率如何？ | KPI 卡「工具成功率」 |
| FR-166 | OpenCode 上报的成本是多少？ | 活动图角标 + 模型表「成本」列 |
| FR-167 | 时间范围如何切换？ | 范围切换器（写入 URL search params） |
| FR-168 | 加载 / 空 / stale / 错误如何呈现？ | 见 §8 |
| FR-169 | 与网关用量如何区分？ | 见 §7 对照表 |

**不做**：不把积分余额、进程在线时长或反代日志行数冒充为请求用量；不把 `steps` 显示为
「请求数」；不自行把 `cost` 折算成积分或跨厂商兑换。

## 2. 参考产品

| 产品 | 借鉴点 | 明确不复制 |
|---|---|---|
| [OpenRouter Activity](https://openrouter.ai/docs/cookbook/administration/activity-export.md) | Spend / Tokens / Requests 三类核心指标、按时间范围与模型分组的交互 | 不把 OpenCode 的 `steps` 改名为 Requests |
| [Vercel AI Gateway Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability) | 总览 KPI、模型请求分布、Token 与范围查看、URL 即状态 | TTFT / P75 / 逐请求路由尝试——本口径无此数据，不伪造 |
| [OpenCode V2](https://opencode.ai/v2/docs/api) | 官方统计接口直接返回聚合结果，语义色与分类色思想 | 不复制 OpenCode 私有 UI 结构，不读其数据库 |

网页面板在此之上补一层浏览器能力：可分享 URL 范围、面积图（TUI 用 Sparkline）、表格排序与
详情抽屉。参考 [01 调研](01-research.md) 的选型结论。

## 3. 真实数据源与只读边界

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

### 3.2 桥接暴露方式

浏览器**不直连** OpenCode，也不经网关，统一走桥接（[00 §11](00-design-baseline.md)）：

| 端点 | 说明 |
|---|---|
| `GET /api/usage?range=24h\|7d\|30d\|all` | 桥接把 `range` 换算为 `from`/`to` 毫秒后调用上述只读接口，原样透出 `data` |

- 默认 `range=7d`；`to` 是**本次查询时刻**，不用本地写死的日期。
- 桥接只做参数换算与 `Resource<T>` 包装，不改写字段语义、不做二次求和。
- OpenCode CLI 不存在或接口失败时，桥接返回错误而**不**去读数据库补救。

### 3.3 只读不变量

- **不**读取 OpenCode SQLite / 数据库文件。
- **不**读取或修改会话标题、提示词与响应正文。
- **不**解析反代日志来猜测 Token 或费用。
- **不**调用 `session.message.list` 逐条拉取来生成近似统计。
- 真实用量只用于本机展示，不写入 fixtures 或文档（演示模式除外，见 §8）。

## 4. 字段与口径

字段名与 [`tui/docs/14-usage-analytics.md`](../../tui/docs/14-usage-analytics.md) §3.2 一致。

| 展示名 | 字段 | 说明 | 边界 |
|---|---|---|---|
| 会话数 | `sessions` | OpenCode 会话数量 | `0` 是真实值，不是「未查询」 |
| 子会话数 | `subagents` | 子会话 / 子代理数 | 仅在详情抽屉使用，不上 KPI 卡 |
| 提示数 | `prompts` | 提示数量 | **不**等同于模型请求数 |
| 会话步骤 | `steps` | OpenCode 会话步骤 | **永远不等于 HTTP 请求数**；不显示为「请求数」 |
| 输入 Token | `tokens.input` | OpenCode 上报值 | 原样展示，不推算 |
| 输出 Token | `tokens.output` | OpenCode 上报值 | 原样展示 |
| 推理 Token | `tokens.reasoning` | OpenCode 上报值 | 窄屏可收进详情，不并入「输入」 |
| 缓存读取 Token | `tokens.cache.read` | 单独展示 | **不重复累计**进 Token 构成 |
| 缓存写入 Token | `tokens.cache.write` | 单独展示 | **不重复累计**进 Token 构成 |
| Token 构成 | `input+output+reasoning` | 三者和 | 概览值只含这三项；缓存读/写另列 |
| 上报成本 | `cost` | OpenCode 上报成本 | **仅**是 OpenCode 上报值，≠ 积分余额，不折算、不求和 |
| 工具统计 | `tools.totals` | 成功、失败、未完成与成功率 | 工具成功率**不代替**模型请求成功率 |
| 活跃日 | `activeDays` | 有活动的天数 | 原样展示 |
| 连续活跃 | `streak` | 连续活跃天数 | 原样展示，不做趋势推断 |
| 每日活动 | `activity[].date` / `.steps` | 面积图的逐日 steps | 空数组即空状态，不生成随机曲线 |
| 模型聚合 | `models[]` | 模型 / Provider 聚合，按 steps 降序 | 未知 providerID 原样显示并用中性色 |
| 范围 | `range.from` / `range.to` | 本次查询的毫秒边界 | 用于角标标注范围 |

三条必须写进实现的强调：

1. **`steps` ≠ HTTP 请求数**：它是 OpenCode 会话步骤，可表示活动规模，但不等于模型调用次数。
2. **缓存读写不重复累计**：`cache.read` / `cache.write` 单独成列，「Token 构成」只算输入+输出+推理。
3. **`cost` 仅是 OpenCode 上报值**：`cost=0` 是接口返回值，不解释为「没有消耗积分」。

## 5. 时间范围

范围切换写进 URL search params（`?range=`），可分享、可回退。`to` 为查询时刻。

| 选项 | `range` 值 | `from` | 默认 |
|---|---|---|---|
| 近 24 小时 | `24h` | `to - 24h` | |
| 近 7 天 | `7d` | `to - 7×24h` | ✅ 默认 |
| 近 30 天 | `30d` | `to - 30×24h` | |
| 全部历史 | `all` | `0` | |

默认值是近 7 天，与 TUI 一致。范围变化立即重查；`all` 在数据量大时仍只做展示层虚拟滚动，
不在桥接层截断字段。

## 6. 页面设计（网页面板）

页面由四段组成：KPI 卡 → 每日活动面积图 → 模型/Provider 表 → 详情抽屉。

### 6.1 线框

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 用量 /usage     范围 [24h] [7d*] [30d] [全部]     刷新  最后成功 12:03:44    │
├──────────────────┬──────────────────┬──────────────────┬───────────────────┤
│ 会话 / 提示       │ 会话步骤          │ Token 构成        │ 工具成功率         │
│ 128 / 1 024      │ 3 512            │ 4.20 M           │ 96.4 %            │
│ 子会话 17         │ steps            │ 入 2.80M 出 1.10M │ 成功 412 · 失败 15 │
│                  │                  │ 推 0.30M         │ 未完成 3           │
│                  │                  │ 缓存读 0.90M      │                   │
│                  │                  │ 缓存写 0.20M      │                   │
└──────────────────┴──────────────────┴──────────────────┴───────────────────┘

每日活动 · 近 7 天 · 2026-11-06 → 2026-11-12 · OpenCode 上报成本 —（cost 为空时）
   steps
     ▲
 1.2K│        ▂▄▆█▅▃▂
     │     ▂▄████████▄▂
   0 └──────────────────────────────────────────► 日期
     11-06 11-07 11-08 11-09 11-10 11-11 11-12

模型 / Provider（按 steps 降序）
┌───────────────────┬────────────┬────────┬────────┬────────┬──────┬────────┬────────┬────────┐
│ 模型               │ Provider   │ Steps  │ 输入   │ 输出   │ 推理 │ 缓存读 │ 缓存写 │ 成本   │
├───────────────────┼────────────┼────────┼────────┼────────┼──────┼────────┼────────┼────────┤
│ claude-sonnet-4-5 │ codearts   │ 1 204  │ 980K   │ 420K   │ 88K  │ 310K   │ 96K    │ —      │
│ gpt-5-codex       │ gateway    │   812  │ 640K   │ 300K   │ 120K │ 210K   │ 40K    │ —      │
│ gemini-3-pro      │ qoder-cn   │   406  │ 320K   │ 160K   │ 44K  │ 120K   │ 18K    │ —      │
│ …                 │            │        │        │        │      │        │        │        │
└───────────────────┴────────────┴────────┴────────┴────────┴──────┴────────┴────────┴────────┘
```

> 线框为示意，匿名虚构数值；CJK 字符宽度会破坏严格对齐，实际由组件渲染。

### 6.2 KPI 卡

四张，固定顺序：

1. **会话 / 提示**：`sessions` / `prompts`，副行 `subagents`。
2. **会话步骤**：`steps`，必须带「steps」单位文本，不写「请求」。
3. **Token 构成**：`input + output + reasoning`，三行分列，缓存读/写另起小字。
4. **工具成功率**：`tools.totals` 的成功率，副行成功 / 失败 / 未完成计数。

未知值显示 `—`（不是 `0`）。`0` 只在接口确实返回 `0` 时显示。总览页可复用同一数据源显示
同样四张卡，但服务表格保持独立（对齐 [00 §5](00-design-baseline.md)）。

### 6.3 每日活动面积图

- 数据来自 `activity[]`，逐日 `steps`。
- 角标常驻：**范围**（`range.from → range.to`，本地化）+ **OpenCode 上报成本**。
- `cost` 缺失/为 `0` 时角标标注「—（OpenCode 未上报）」，不隐藏、不推算。
- 只有 `activeDays`/`streak` 作为副信息展示，不叠加第二条趋势线。
- 空 `activity[]` 时显示空状态文字，**不**生成随机曲线。

### 6.4 模型 / Provider 表

- 列：`模型、Provider、Steps、输入、输出、推理、缓存读、缓存写、成本`。
- 默认按 **steps 降序**；点击表头排序（排序状态进 search params）。
- 窄屏（< 1024px）收起「输入」「推理」「缓存写」，数据仍可在详情抽屉看全。
- 数字右对齐、等宽字体、千分位；`cost` 未上报显示 `—`。

### 6.5 详情抽屉

选中行打开右侧抽屉（URL 带 `?model=`，可分享）：

```text
┌──────────────────────────────────────────────┐
│ claude-sonnet-4-5            codearts     ✕   │
├──────────────────────────────────────────────┤
│ 会话步骤            1 204                     │
│ 输入 Token          980 000                   │
│ 输出 Token          420 000                   │
│ 推理 Token           88 000                   │
│ 缓存读取 Token      310 000                   │
│ 缓存写入 Token       96 000                   │
│ 上报成本            —（OpenCode 未上报）       │
│ 首次/最近活动       11-06 → 11-12             │
└──────────────────────────────────────────────┘
```

抽屉内容**只**来自该行与聚合字段，不请求逐条消息，不显示提示词或响应正文。

### 6.6 刷新策略

对齐 [00 §8](00-design-baseline.md)：

| 触发 | 行为 |
|---|---|
| 进入页面 | 查询当前范围 |
| 切换范围 / 更改排序 | 立即重查（query key 含 `range`） |
| 停留页面 | 120s 轮询（与 TUI 一致，设置页可覆盖） |
| 手动刷新 | 顶栏 / 页内刷新按钮 |
| `document.hidden` | 暂停轮询，可见时立即补一次 |

## 7. 与「网关用量」页的区别

`/usage` 与 `/gateway/usage` **并列存在、互不替代**，一个看 OpenCode 会话统计，一个看网关
请求聚合。两者数据源、计数单位、时间模型都不同，**不得相加、不得相除、不得互相填充**。

| 维度 | 用量 `/usage` | 网关用量 `/gateway/usage` |
|---|---|---|
| 数据源 | OpenCode `experimental.session.stats`（经桥接 `GET /api/usage`） | 网关 `gateway/data/usage/<date>.jsonl`（经桥接 `GET /api/gateway/usage?days=N`） |
| 记录对象 | OpenCode **会话** | 网关代理的 **HTTP 请求** |
| 计数单位 | `steps`（会话步骤）、`sessions`、`prompts` | `requests`、`errors`、`avgDurationMs` |
| Token 字段 | `tokens.input/output/reasoning/cache.read/cache.write`（OpenCode 上报） | `inputTokens` / `outputTokens`（网关从上游 `usage` 采集，无推理/缓存写） |
| 身份维度 | 模型 + Provider（OpenCode providerID） | 模型 + Provider + 密钥（`key`/`keyName`）+ 状态码 + `attempts` |
| 时间模型 | 24h/7d/30d/all 滚动窗口，毫秒 `from`/`to` | 按自然日 `YYYY-MM-DD.jsonl` 分片，`days=N` 从今天往回 |
| 成本 | `cost`（OpenCode 上报） | 无成本字段 |
| 延迟 | 无 | `durationMs` / `avgDurationMs` |
| 典型问题 | 我用了多少会话/Token？哪个模型最忙？ | 网关今天转发多少请求、失败多少、谁在换家？ |

桥接层必须把两者映射为**不同的 query key 与不同的领域类型**，避免缓存串用；UI 文案也不得
把 `steps` 与 `requests` 混称。

## 8. 视觉规范

- **图表**：Recharts，经 shadcn chart 封装，沿用主题 token（[00 §10](00-design-baseline.md)）。
  未生成 [06 设计系统](06-design-system.md) 时以 [00 §10](00-design-baseline.md) 的语义色为准。
- **Provider 分类色**（稳定映射，与 TUI 一致）：`codearts` 紫 · `qoder-cn` 青 · `qoder` 蓝 ·
  `trae-local` 绿 · `workbuddy` 黄 · `workbuddy-global` 浅紫 · `zcode` 橙 · `loomy` 洋红 ·
  `gateway` 中性。未知 providerID 用中性色并原样显示 ID。
- **语义色**：`accent / success / warning / error / muted / selected / border / background /
  foreground`，实现为 Tailwind CSS 变量 + shadcn 约定，支持 dark/light/system。
- **状态不只靠颜色**：数值、单位、图例、文本同时存在。
- **表格**：13px，数字右对齐，端口/PID 之类用等宽；表头低亮度底色，选中行高对比。
- **动效**：`prefers-reduced-motion` 下取消面积图入场动画。

状态呈现（对应 [00 §7](00-design-baseline.md) 的四种状态）：

| 状态 | 呈现 |
|---|---|
| 加载中（首次无数据） | 骨架屏，不显示 `0` |
| 空数据（成功但无会话/模型） | 明确空状态文字 + 范围提示，不画空图、不发散随机曲线 |
| stale（有旧数据且最近刷新失败/超阈值） | 保留旧数据 + `stale` 角标 + 「最后成功时间」+ 重试按钮 |
| 错误（OpenCode 不可用 / 超时 / 字段不兼容） | 错误卡 + 「下一步」指引；仅影响用量页，其它页继续工作 |
| 演示模式 `--demo` | 匿名虚构用量 + 常驻 `DEMO` 标记，不 spawn 进程、不访问真实文件 |

## 9. 验证与限制

### 9.1 验收要点

- 桥接 `range` → `from`/`to` 换算正确（24h/7d/30d/all），默认 7d，`to` 为查询时刻。
- 字段解析与 providerID → provider 分类色映射正确；未知 ID 不崩。
- 「Token 构成」= 输入+输出+推理；缓存读/写**不**并入。
- 模型表按 steps 降序；排序与范围写入 search params 并可分享 / 回退。
- `steps` 在任何文案、tooltip、导出中都不显示为「请求数」。
- 空 / stale / 错误 / 演示四种状态按 §8 呈现；OpenCode 不可用不影响其它页。
- 面积图角标同时展示范围与上报成本（含未上报的 `—`）。
- 契约测试用 Zod 校验 `{data:{...}}` 形状，字段 additive 兼容。

### 9.2 当前口径不提供（不得伪造）

- TTFT、P75 / P99 延迟；
- HTTP 请求数与逐请求成功率；
- 每次 provider 路由尝试与降级链；
- 逐请求输入 / 输出详情；
- 积分消耗与 Token 的可靠兑换关系；
- 与上一周期的对比（无对应字段时不做「环比」，即使图上有空间）。

### 9.3 未来方向

上述能力需要更细粒度事件。若后续需要，应**单独设计独立遥测契约**（独立桥接端点、独立去重与
时间范围、独立隐私规则），而不是从进程日志正则反推，或把网关 JSONL 混入本页口径。可选补充：

- 网关 JSONL 的逐请求维度作为 `/gateway/usage` 的增强（不是本页）；
- CodeArts `/metrics` 作为网关请求数 / 失败数 / 进程运行时间的补充，但**不能**替代 OpenCode
  的 Token 统计。

任何新增字段遵循 [00 §14](00-design-baseline.md) 的 additive 规则：优先新增，改义/删除需升
`schemaVersion` 并同步 fixtures 与测试。
