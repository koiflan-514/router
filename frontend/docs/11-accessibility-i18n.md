# 11 可访问性与国际化

状态：设计基线 ｜ 对应需求：FR-180–189 ｜ 目标：WCAG 2.1 AA

本文定义 `frontend/` 网页面板的无障碍（a11y）、键盘模型、语义与 ARIA、状态多通道表达、动效降级
与国际化（i18n）策略，是**交互层**的验收依据。视觉 token 由 [06 设计系统](06-design-system.md)
定义（未生成前以 [00 设计基线](00-design-baseline.md) §10 为准），本文只引用、不重定义。
术语继承 [`tui/docs/12-glossary.md`](../tui/docs/12-glossary.md)。

## 1. 无障碍目标与验收

目标级别 **WCAG 2.1 AA**；下表为**必须**（MVP 验收项）。

| # | 要求 | 判据 | 验收方式 |
|---|---|---|---|
| A1 | 对比度·正文/大字 | 正文 ≥ **4.5:1**；大字（≥24px 或 ≥18.66px 粗体）≥ **3:1** | 主题各态实测；axe color-contrast |
| A2 | 对比度·非文本 | 图标/边框/图表色块/焦点环 ≥ **3:1**（1.4.11） | 组件快照比对 |
| A3 | 可见焦点 | 可聚焦元素均有可见焦点环，不被 `outline:none` 抹除 | 逐组件 Tab 走查 |
| A4 | 可缩放 | 浏览器 **200%** 缩放/文本放大不丢功能、不遮挡、无双向滚动条 | 200% 视口回归 |
| A5 | 不依赖颜色 | 状态同时有**符号 + 文本 + 数值**（§4） | 灰度截图审查 |
| A6 | 动效可关 | 尊重 `prefers-reduced-motion`（§6） | 强制 reduced-motion 回归 |
| A7 | 全键盘可达 | 全部功能可仅用键盘完成，无键盘陷阱 | E2E 键盘用例 |
| A8 | 名称·角色·语言 | 交互元素有可访问名与正确角色（§3、§5）；根 `lang` 正确（§8） | axe + 读屏矩阵 |

统一强制项：`on`/`up`/`oc`/`auth` 四态、`stale` 标记、`—`（未知）必须在**视觉与读屏两个通道**都
可辨识；`stale` 不得仅以降低不透明度表达。

## 2. 键盘模型

### 2.1 全局规则

| 规则 | 行为 |
|---|---|
| Tab 顺序 | 遵循 DOM 顺序：左侧导航 → 顶栏 → 主内容 → 页脚；不用 `tabindex>0` 重排 |
| 跳转到主内容 | 页面首个可聚焦元素是 Skip link，指向 `<main id="main-content">` |
| 焦点可见 | 用 `:focus-visible`；焦点环用 `token:selected` 与 2px 外环 |
| 焦点不丢 | 关闭覆盖层/切换路由后，焦点归还触发元素或逻辑后继（§2.4） |
| 无键盘陷阱 | 除 Dialog/Sheet 刻意包含外，任何区域都可用 Tab/Esc 离开 |

### 2.2 栅格、表格与树的键盘导航

| 组件 | 键 | 行为 |
|---|---|---|
| 表格行内 | `Tab` | 只读单元格不逐个 Tab，仅可交互控件入序列 |
| 可交互单元格 | `←/→` | 在可交互单元格间移动 |
| 表头排序 | `Enter`/`Space` | 触发排序，表头 `aria-sort` 同步（§3.2） |
| 树（网关降级链） | `↑/↓`、`→/←` | 移动可见节点 / 展开收起 |
| 列表（provider 侧栏） | `j/k` 或 `↑/↓`、`Enter` | 移动选中项 / 打开详情 |

### 2.3 快捷键表

默认修饰键 Ctrl（macOS 显示 ⌘ 并同时接受 ⌘/Ctrl）；`G` 为序列键（按后短暂窗口再按次键）。

| 快捷键 | 作用 | 冲突规避 |
|---|---|---|
| `Ctrl/⌘ K` | 打开命令面板 | 浏览器基本空闲；覆盖默认搜索 |
| `Ctrl/⌘ /` | 打开/关闭快捷键帮助 | 避开常用键 |
| `Esc` | 逐层关闭覆层（面板/Dialog/Sheet/Popover） | — |
| `G` 然后 `O/P/Q/L/G` | 转到 总览/服务/额度/日志/网关 | 序列键，不用单键字母 |
| `?` | 状态符号与快捷键图例 | 仅在非输入态 |
| `R` | 刷新当前页数据 | 不触发写操作 |
| `P` | 日志"跟随/暂停"切换 | 仅 `/logs`，不停止进程 |

约束：输入框内**不拦截**字符键（仅在非输入目标生效）；`Ctrl+W/T/N` 等浏览器键一律不占用；
所有快捷键都有等价的**可点击按钮**，快捷键只是加速而非唯一入口。

### 2.4 焦点陷阱与焦点归还

- **Dialog / Sheet / Popover / 命令面板**：打开时焦点移入首个可聚焦控件，内部 `Tab` 循环，`Esc` 关闭。
- 关闭后**归还焦点**到触发元素；触发元素消失时归还到逻辑后继（同表上一行或页面主标题）。
- 危险确认框（`high` 等级）**默认焦点在"取消"**（对齐 00 §9），且列出受影响名单。

### 2.5 命令面板（⌘K / Ctrl+K）

| 要求 | 说明 |
|---|---|
| 可键盘操作 | `↑/↓` 移动结果、`Enter` 执行、`Esc` 关闭；输入即筛选 |
| 语义 | `role="dialog"` + `aria-modal="true"`；输入框 `role="combobox"` + `aria-expanded` + `aria-controls` 指向结果 `role="listbox"` |
| 项角色 | 结果 `role="option"`，用 `aria-activedescendant` 标记当前项（不逐个 `tabindex`） |
| 结果可读 | 每项含名称 + 类别（页面/动作/provider），动作用"启动 trae-local"这类动词短语 |
| 危险动作 | 面板内**不直接执行**写操作，选中后打开确认框 |
| 空结果 | `aria-live="polite"` 播报"无匹配结果" |

```html
<div role="dialog" aria-modal="true" aria-labelledby="cmdk-title">
  <label id="cmdk-title" class="sr-only">命令面板</label>
  <input role="combobox" aria-controls="cmdk-list" aria-expanded="true"
         aria-activedescendant="cmdk-opt-2" />
  <ul id="cmdk-list" role="listbox" aria-label="可用命令">
    <li id="cmdk-opt-1" role="option">转到 额度</li>
    <li id="cmdk-opt-2" role="option" aria-selected="true">刷新 服务状态</li>
  </ul>
</div>
```

## 3. 语义与 ARIA

### 3.1 地标与区域

| 区域 | 语义 | 说明 |
|---|---|---|
| 左侧导航 | `<nav aria-label="主导航">` | 当前页 `aria-current="page"` |
| 主内容 | `<main id="main-content">` | Skip link 目标 |
| 顶栏 | `<header>` + 状态区 `role="status"` | 工作范围、可达性、最后成功时间 |
| 页脚/工具条 | `<footer>` / 具名 `<section aria-labelledby>` | 刷新、行数、时间范围 |
| 通知与任务 | 独立 `aria-live` 区（§3.6） | 不放入会被整体重渲染的容器 |

同一页重复出现的 region 必须有区分标签（如 `aria-label="服务状态表"` 与 `"网关调度表"`）。

### 3.2 表格

使用原生 `<table>`；表头 `<th scope="col">`；以 provider 为键的行首列用 `<th scope="row">`
（`rowheader`）；嵌套表用 `aria-labelledby` 关联父行标题；表格重渲染**不整表替换** live region，
避免读屏刷屏。

```html
<table aria-labelledby="providers-caption">
  <caption id="providers-caption">Provider 服务状态（示例数据）</caption>
  <thead><tr>
    <th scope="col">Provider</th>
    <th scope="col" aria-sort="descending"><button type="button">状态 <span aria-hidden="true">▼</span></button></th>
    <th scope="col">端口</th>
  </tr></thead>
  <tbody><tr><th scope="row">trae-local</th><td>运行中</td><td>7863</td></tr></tbody>
</table>
```

### 3.3 图表

图表（Recharts）必须提供**可读等价**。

| 要求 | 做法 |
|---|---|
| 角色 | 外层容器 `role="img"` + `aria-label` 概述（趋势/范围/单位） |
| 文字摘要 | 紧邻图表给 1–2 句结论（含时间范围与 `fetchedAt`） |
| 表格替代 | 提供"查看数据表"折叠区，输出同源数值表（可聚焦） |
| 装饰 | 网格线、坐标轴刻度 `aria-hidden="true"` |
| 空态 | 说明"该范围无数据"，不生成随机曲线 |

```html
<figure role="img" aria-label="近 7 天 Token 用量趋势：输入 1.2M、输出 0.4M、推理 0.1M">
  <figcaption>近 7 天 Token 用量（示例数据），来源 07-01T00:00Z</figcaption>
  <!-- Recharts 图形；坐标轴与网格 aria-hidden -->
  <details><summary>查看数据表</summary></details>
</figure>
```

### 3.4 状态徽标

`auth.state`、`drift`、`health.level`、`Task.status` 徽标以图标 + 文字呈现；图标
`aria-hidden="true"`，文字承载语义，徽标本身给 `aria-label`，避免"图标 + 文本"重复播报。

```html
<span class="badge" aria-label="认证状态：即将过期">
  <svg aria-hidden="true"><!-- clock --></svg><span aria-hidden="true">即将过期</span>
</span>
```

### 3.5 对话框

| 需求 | 属性 |
|---|---|
| 角色 | `role="dialog"`（危险确认用 `role="alertdialog"`） |
| 模态 | `aria-modal="true"` |
| 标题/描述 | `aria-labelledby` 指向标题；`aria-describedby` 给描述 |
| 关闭 | 显式关闭按钮 + `Esc`；危险框默认焦点"取消" |
| 背景 | 打开时对背景 `inert`，防止读屏漫游到后方 |

### 3.6 通知、进度与 SSE 实时区域

| 场景 | 区域 | 通道 |
|---|---|---|
| 成功提示（可稍后读） | Toast `role="status"` / `aria-live="polite"` | polite |
| 错误/失败（立即知会） | Toast `role="alert"` / `aria-live="assertive"` | assertive |
| 任务进度（`Task`） | `role="progressbar"` + `aria-valuenow/min/max` + 可见文本 | polite |
| 日志流（SSE） | **不是** live region，见下 | 按需 |

**SSE 日志实时区域策略**（避免刷屏打断）：①日志正文**默认不设为** live region，读屏用户进入面板
时按需读取；②仅在面板头部提供**节流汇总**的 `aria-live="polite"` 区域（如"新增 12 行，最新：
…"），间隔 ≥ 1s 且合并同批；③"跟随/暂停"以按钮 `aria-pressed` 暴露，暂停时停止 live 更新；
④日志行用 `<pre>` + 可读时间戳，控制字符经桥接清理（00 §11）后才播报；⑤assertive **只**用于
错误与失败，不用于普通日志行。

## 4. 状态不只靠颜色

每个语义状态用 **符号 + 文本 + 数值** 三通道表达；灰度下仍可区分。

| 状态 | 符号（aria-hidden） | 文本（可读） | 数值/附加 |
|---|---|---|---|
| 进程 `up=true` / `false` | ● / ○ | 运行中 / 未运行 | 端口、PID |
| 启用 `on=true` | ✓ | 已启用 | — |
| 认证 `valid` | ✓ | 有效 | 到期时间（UTC） |
| 认证 `expiring` | ! | 即将过期 | 剩余天数 |
| 认证 `expired` / `missing` | ⨯ | 已过期 / 缺少凭证 | 下一步：重新登录 |
| 认证 `unknown` | ? | 未知 | — |
| 漂移 `stopped` | △ | 已启用未运行 | 建议：启动 |
| 漂移 `notSynced` | △ | 未同步到客户端 | 注明 `ocUserOwned` 例外 |
| 漂移 `stillRunning` | △ | 已关闭但仍在运行 | 建议：停止 |
| 健康 `warn`/`error` | ! / ⨯ | 告警 / 错误 | `notes[]` 摘要 |
| `stale` | ⟳ | 数据可能过期 | 最后成功时间（UTC） |
| 未知 `—` | — | 未知 | 读屏读作"未知"（§5） |

告警的可读表述（示例，匿名）：

| 场景 | 面向用户的一句话 | 下一步 |
|---|---|---|
| 漂移·未运行 | "trae-local 已启用但进程未运行。" | "启动 trae-local" |
| 漂移·未同步 | "codearts 已启用但未写入客户端配置。" | "同步客户端（`sync`）" |
| 认证·即将过期 | "loomy 凭证约 3 天后过期。" | "重新登录 loomy" |
| 认证·未知 | "workbuddy 凭证状态未知（后端无法判断）。" | "重试体检" |
| 额度·即将失效 | "qoder-cn 有 120 积分将在 07-15 失效。" | "查看额度明细" |

> `up`/`reachable` 不代表凭证有效；`on`/`up`/`oc`/`auth` 四态独立（对齐 00 §7）。

## 5. 读屏与文本

| 规则 | 要求 |
|---|---|
| 按钮名 | 用**动词短语**描述结果："启动 trae-local"，不用"点击这里""详情""更多"；链接文本自证目标（"查看日志"优于"这里"） |
| 图标按钮 | 必须 `aria-label`；纯装饰图标 `aria-hidden="true"` |
| 错误信息 | 说明**发生了什么 + 下一步**；字段错误用 `aria-describedby` 关联输入 |
| `—` 的读法 | 视觉 `—`，读屏读作"未知"（可见 `—` + 隐藏文本"未知"） |
| 数值单位 | 播报含单位（"3 天""120 积分"）；右对齐仅为视觉 |
| 复数/量词 | 交给 i18n ICU 处理（§7），不手拼"1 providers" |

```html
<p id="login-error" role="alert">loomy 登录未完成：等待外部终端超时。请重试或在原生终端登录。</p>
<button type="button" aria-describedby="login-error">重新登录 loomy</button>
```

## 6. 动效与闪烁

| 规则 | 做法 |
|---|---|
| 尊重偏好 | `@media (prefers-reduced-motion: reduce)` 下动效降为瞬时/无，`transition-duration` 归零；焦点环与选中态**保留** |
| 禁止闪烁 | 不出现每秒 > 3 次闪烁（2.3.1）；状态更新用文字/数值，不频闪 |
| 骨架屏替代 | reduced-motion 下不做扫光，改静态占位 + `role="status"` "加载中" |
| Spinner 替代 | 提供文本状态；spinner `aria-hidden`，状态由 `role="status"` 播报 |
| 自动更新 | 轮询/SSE 更新**不**触发滚动跳动；数字变化用轻微高亮，不长时间脉冲 |

## 7. 国际化

| 项 | 约定 |
|---|---|
| 默认语言 | `zh-CN`（`<html lang="zh-CN">`） |
| 回退链 | `zh-CN → zh → en`；缺失键回退 `en`，最后显示键名占位并记警告 |
| 文案外置 | 全部用户可见文案放 `src/locales/<lang>/<ns>.json`；组件内不硬编码中文 |
| 表单化 | ICU MessageFormat：`{count, plural, …}`、`{state, select, …}` |
| 数字/货币 | `Intl.NumberFormat`；积分是厂商口径，**不**折算法币、不跨家汇总（00 §7） |
| 日期时间 | `Intl.DateTimeFormat`；**绝对到期时间统一以 UTC 展示**并标时区（如 `2026-07-15 00:00 UTC`）；提供本地时区切换时必须显式标注且可持久化；相对时间作补充 |
| 不本地化 | 端口、PID、provider id、模型名、命令名（`up`/`off`/`sync`）、HTTP 头、`null` 语义 |
| 术语一致 | provider/Region/Gateway/drift/stale 等以 `tui/12-glossary.md` 为准 |

```jsonc
// src/locales/zh-CN/providers.json（节选，匿名）
{
  "auth.expiring": "即将过期（剩 {days} 天）",
  "drift.stopped": "{provider} 已启用但进程未运行。",
  "count.providers": "{count, plural, other {{count} 家 provider}}"
}
```

## 8. 文本与布局

| 项 | 约定 |
|---|---|
| `lang` 属性 | 根元素 `lang="zh-CN"`；内嵌英文/命令片段用 `lang="en"` 包裹 |
| 中文宽字符 | 截断/省略按**显示列**（CJK = 2）计算，不产生半个字符；复制保留原值 |
| 长 provider 名 | 默认**中间省略**（`qoder-c…cn`），悬浮 `title` 与详情页展示全文；读屏始终读全文 |
| 列宽 | 端口/PID/数值右对齐、等宽；provider 名列 `min-width` 防挤压 |
| 日志等宽 | 日志用等宽字体；CJK 与 ASCII 混排按列对齐，行号固定宽度；长 ID/URL 允许 `overflow-wrap` |
| 缩放 | 200% 下导航折叠为抽屉、表格用可键盘滚动的横向容器 |

## 9. 测试与工具

| 层 | 工具 | 覆盖 |
|---|---|---|
| 静态/组件 | `axe-core`（`jest-axe`/`vitest-axe`） | 地标、名称、对比度、表单关联 |
| E2E | Playwright + `@axe-core/playwright` | 每页 scan；键盘导航；焦点归还/陷阱 |
| 键盘回归 | Playwright `keyboard` | Skip link、命令面板、Dialog Esc、表格排序 |
| 对比度 | 主题 token 快照 + 检查工具 | 正文/大字/非文本三档（A1–A2） |
| 缩放/动效 | Playwright 200% 视口 + reduced-motion 上下文 | 无功能丢失、骨架屏/Spinner/过渡降级 |
| i18n | 伪本地化 + 缺失键扫描 | 回退、截断、复数 |
| 人工读屏 | **至少其一**：NVDA（Windows）/ VoiceOver（macOS） | 主要流程走查 |

人工读屏矩阵（每轮发布至少跑一遍）：总览（`aria-sort`、`—` 读作"未知"、漂移告警）、写操作（默认
焦点"取消"、受影响名单、Toast 播报）、日志（实时区不刷屏、暂停可操作）、命令面板（`combobox`/
`listbox`/`activedescendant` 语义、`Esc` 归还焦点）。

## 10. 未来方向

| 方向 | 说明 | 状态 |
|---|---|---|
| 高对比主题 | 额外主题满足 7:1（AAA 正文），支持 `forced-colors` | 后续（待拍板，00 §15） |
| RTL | 逻辑属性（`margin-inline`/`padding-inline`）替代物理属性，为 `dir="rtl"` 准备 | 后续 |
| 更多语言 | 在 `src/locales/` 增 `<lang>` 目录 + 回退链扩展（如 `ja`） | 后续 |
| 无障碍声明 | 发布页提供可访问性说明与反馈渠道 | 后续 |

新增语言/主题时的同步检查：`06 设计系统`（token）、`09 测试策略`（用例）、`12 术语表`（英译），
以及本文件的对比度与键盘回归。
