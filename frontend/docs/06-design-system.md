# 06 设计系统

状态：设计基线 · 对应需求：FR-180–189 · 依据：shadcn/ui + Tailwind CSS 变量约定

本文件定义 `frontend/` 网页面板的**视觉与组件词表**：设计原则、token、Provider 分类色、排版、
间距/层级、动效、组件清单、图表规范、图标与状态符号、主题切换。token 与语义色以
[00 设计基线 §10](00-design-baseline.md#10-视觉与-token) 为上位定义，排版与状态符号参照
[`tui/docs/03-ui-design.md` §13](../tui/docs/03-ui-design.md) 与
[`tui/docs/14-usage-analytics.md` §5](../tui/docs/14-usage-analytics.md)。本文只定义取值与用法，
不改变页面信息架构（见 [03 界面设计](03-ui-design.md)）。

**取值性质**：下文所有 hex/oklch 均为**设计取值示例**（虚构但合理），实现时**以 shadcn 默认
`neutral` 主题为底**，通过 `components.json` 与全局 CSS 覆盖；不得据此另造一套并行色板。

## 1. 设计原则

| 原则 | 含义 | 落地约束 |
|---|---|---|
| 状态真实 | `null`、`0`、加载失败、未查询是四种状态 | 未知显示 `—`；不把 pending 渲染成目标状态（§9） |
| 危险可见 | 高风险写操作影响面显式 | 危险色只用于真实危险；默认焦点"取消" |
| 密度优先 | 面向运维的多行表格 | 表格 13px、紧凑行高可选；关键列不换行 |
| 颜色不单独表意 | 色盲/高对比/打印下仍可读 | 每个颜色状态**同时**有图标/文字/数值 |
| 中文与宽字符正确 | 中英混排、截断不产生半字 | 字体回退含中文字族；`truncate` 配 `title`/详情 |

## 2. Token 规范

shadcn 使用「背景 / 前景」成对语义 token：`X` 控表面，`X-foreground` 控其上的文字与图标。
未列出的 shadcn token（`--chart-*`、`--sidebar-*`、`--radius` 等）沿用默认。

### 2.1 基础 token（本文件必须定义）

| Token | 角色 | 浅色示例 | 深色示例 |
|---|---|---|---|
| `--background` | 应用底 | `#ffffff` | `oklch(0.16 0.01 265)` |
| `--foreground` | 默认文字 | `oklch(0.18 0.01 265)` | `oklch(0.97 0.005 265)` |
| `--card` | 卡片/面板面 | `#ffffff` | `oklch(0.20 0.012 265)` |
| `--card-foreground` | 卡片内文字 | 同 `--foreground` | 同 `--foreground` |
| `--popover` | 浮层面 | `#ffffff` | `oklch(0.20 0.012 265)` |
| `--popover-foreground` | 浮层文字 | 同 `--foreground` | 同 `--foreground` |
| `--primary` | 主操作/品牌 | `oklch(0.52 0.19 264)` | `oklch(0.70 0.15 264)` |
| `--primary-foreground` | 主操作文字 | `oklch(0.985 0 0)` | `oklch(0.18 0.02 264)` |
| `--secondary` | 次级填充面 | `oklch(0.96 0.005 265)` | `oklch(0.27 0.015 265)` |
| `--secondary-foreground` | 次级文字 | `oklch(0.28 0.02 265)` | `oklch(0.97 0.005 265)` |
| `--muted` | 弱化面 | `oklch(0.96 0.005 265)` | `oklch(0.27 0.015 265)` |
| `--muted-foreground` | 弱化文字 | `oklch(0.55 0.02 265)` | `oklch(0.72 0.02 265)` |
| `--accent` | 悬停/选中面（含 **info 语义**） | `oklch(0.96 0.01 264)` | `oklch(0.30 0.02 264)` |
| `--accent-foreground` | accent 文字 | `oklch(0.28 0.03 264)` | `oklch(0.98 0 0)` |
| `--destructive` | 破坏/错误（含 **error 语义**） | `oklch(0.58 0.22 27)` | `oklch(0.66 0.19 25)` |
| `--border` | 边框/分隔 | `oklch(0.90 0.005 265)` | `oklch(1 0 0 / 12%)` |
| `--input` | 表单控件边 | `oklch(0.90 0.005 265)` | `oklch(1 0 0 / 16%)` |
| `--ring` | 焦点环 | `oklch(0.55 0.16 264)` | `oklch(0.60 0.12 264)` |

### 2.2 语义色映射（基线 §10 的语义集）

| 语义（基线 §10） | 落地 token | 说明 |
|---|---|---|
| `success` | `--success` | 运行正常、任务成功、`valid` |
| `warning` | `--warning` | `expiring`、冷却、`warn` 健康 |
| `error` | `--destructive` | **不新增** `--error`；错误与破坏同色 |
| `info` | `--accent` | **不新增** `--info`；信息态复用 accent |
| `muted` | `--muted` / `--muted-foreground` | 未知、禁用、次要说明 |
| `selected` | `--selected` | 选中行/选中项底色（区别于 hover 的 accent） |
| `border`/`background`/`foreground` | 同名 token | 见 §2.1 |
| `accent` | `--accent` | 交互悬停、菜单高亮 |

```css
/* 设计取值示例；实现以 shadcn 默认为底，只覆盖需要调整的项 */
@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  /* 语义色（基线 §10）；error→destructive、info→accent 不重复定义 */
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-selected: var(--selected);
  --color-selected-foreground: var(--selected-foreground);
}
/* 说明：Provider 分类色（§3）不注册为 Tailwind 颜色工具类，
   而由 CSS 变量 --provider-<id> 提供（明暗取值见 §3 表），
   供图表与行内样式通过 var(--provider-<id>) 使用。 */

:root {
  --radius: 0.625rem;
  --background: #ffffff;
  --foreground: oklch(0.18 0.01 265);
  --card: #ffffff;
  --card-foreground: oklch(0.18 0.01 265);
  --popover: #ffffff;
  --popover-foreground: oklch(0.18 0.01 265);
  --primary: oklch(0.52 0.19 264);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.96 0.005 265);
  --secondary-foreground: oklch(0.28 0.02 265);
  --muted: oklch(0.96 0.005 265);
  --muted-foreground: oklch(0.55 0.02 265);
  --accent: oklch(0.96 0.01 264);
  --accent-foreground: oklch(0.28 0.03 264);
  --destructive: oklch(0.58 0.22 27);
  --border: oklch(0.90 0.005 265);
  --input: oklch(0.90 0.005 265);
  --ring: oklch(0.55 0.16 264);
  --success: oklch(0.55 0.16 150);
  --success-foreground: oklch(0.985 0 0);
  --warning: oklch(0.75 0.15 75);
  --warning-foreground: oklch(0.28 0.07 60);
  --selected: oklch(0.94 0.03 264);
  --selected-foreground: oklch(0.24 0.05 264);
}

.dark {
  --background: oklch(0.16 0.01 265);
  --foreground: oklch(0.97 0.005 265);
  --card: oklch(0.20 0.012 265);
  --card-foreground: oklch(0.97 0.005 265);
  --popover: oklch(0.20 0.012 265);
  --popover-foreground: oklch(0.97 0.005 265);
  --primary: oklch(0.70 0.15 264);
  --primary-foreground: oklch(0.18 0.02 264);
  --secondary: oklch(0.27 0.015 265);
  --secondary-foreground: oklch(0.97 0.005 265);
  --muted: oklch(0.27 0.015 265);
  --muted-foreground: oklch(0.72 0.02 265);
  --accent: oklch(0.30 0.02 264);
  --accent-foreground: oklch(0.98 0 0);
  --destructive: oklch(0.66 0.19 25);
  --border: oklch(1 0 0 / 12%);
  --input: oklch(1 0 0 / 16%);
  --ring: oklch(0.60 0.12 264);
  --success: oklch(0.72 0.16 152);
  --success-foreground: oklch(0.16 0.02 150);
  --warning: oklch(0.82 0.16 80);
  --warning-foreground: oklch(0.20 0.05 70);
  --selected: oklch(0.30 0.045 264);
  --selected-foreground: oklch(0.97 0 0);
}
```

## 3. Provider 分类色

稳定映射（对齐 [00 §10](00-design-baseline.md#10-视觉与-token) 与
[tui 14 §5](../tui/docs/14-usage-analytics.md)）。色相角度用于区分，**不作为唯一区分手段**：
图例、文字标签、图标始终同时存在。同一对明暗取值须各自满足 WCAG 2.1 **AA**（正文 ≥4.5:1，
大字/图形 ≥3:1）。

| Provider | 颜色 | 色相 | 浅色示例 | 深色示例 | token |
|---|---|---|---|---|---|
| `codearts` | 紫 | 285 | `#7c3aed` | `oklch(0.72 0.17 288)` | `--provider-codearts` |
| `qoder-cn` | 青 | 195 | `#0e9aa7` | `oklch(0.78 0.12 195)` | `--provider-qoder-cn` |
| `qoder` | 蓝 | 250 | `#3355cc` | `oklch(0.72 0.15 250)` | `--provider-qoder` |
| `trae-local` | 绿 | 150 | `#1f9d5b` | `oklch(0.74 0.16 150)` | `--provider-trae-local` |
| `workbuddy` | 黄 | 85 | `#b58a00` | `oklch(0.84 0.15 88)` | `--provider-workbuddy` |
| `workbuddy-global` | 浅紫 | 305 | `#b06bd0` | `oklch(0.80 0.12 305)` | `--provider-workbuddy-global` |
| `zcode` | 橙 | 55 | `#d97706` | `oklch(0.78 0.15 58)` | `--provider-zcode` |
| `loomy` | 洋红 | 340 | `#d6337f` | `oklch(0.76 0.18 340)` | `--provider-loomy` |
| `gateway` | 中性 | — | `#6b7280` | `oklch(0.72 0 0)` | `--provider-gateway` |

命名约定 `--provider-<id>`；组件与图表**只从该表取值**，禁止在代码里写死 hex，也禁止为同一
provider 在不同页面换色。id 与 [00 §4](00-design-baseline.md#4-providerregion-与网关的关系) 的
八家 provider 及 `gateway` 一一对应。

## 4. 排版

| 项 | 值 |
|---|---|
| UI 字体族 | `system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif` |
| 等宽字体族 | `ui-monospace, "Cascadia Code", "JetBrains Mono", "Noto Sans Mono CJK SC", monospace` |
| 字号阶梯 | 12 / 13 / 14 / 16 / 20 / 24 / 32（px） |
| 行高 | 正文 1.5；表格 1.35；标题 1.25；等宽日志 1.5 |
| 字重 | 400 正文、500 强调/表头、600 标题；避免 700 撑破紧凑行 |

| 层级 | 字号 | 用途 |
|---|---|---|
| `text-xs` | 12 | 徽标、Kbd、脚注、时间戳 |
| `text-[13px]` | 13 | **表格正文**、日志、端口/PID |
| `text-sm` | 14 | **UI 正文**、菜单、表单 |
| `text-base` | 16 | 卡片标题 |
| `text-xl` | 20 | 页面内小标题 |
| `text-2xl` | 24 | 页面标题 |
| `text-[32px]` | 32 | KPI 主数值 |

数字：表格数值列、KPI、Token、耗时一律右对齐并启用 `tabular-nums`，避免跳动。

```tsx
// 端口/PID/日志用等宽；数值列右对齐 + 等宽数字
<span className="font-mono text-[13px] tabular-nums">10087</span>
<span className="text-right tabular-nums">6,599 credits</span>
```

## 5. 间距 / 圆角 / 阴影 / 层级 / 密度

| 刻度 | 取值 |
|---|---|
| 间距 | `4px` 基准：4 / 8 / 12 / 16 / 24 / 32（`gap-1…gap-8`） |
| 圆角 | 由 `--radius: 0.625rem` 派生：`sm 0.375rem / md 0.5rem / lg 0.625rem / xl 0.875rem` |
| 阴影 | `shadow-sm` 行内浮起、`shadow-md` 卡片/弹层、`shadow-lg` Dialog/Sheet；不做多层光晕 |
| z-index | 见下方刻度，禁止散落魔数 |

**z-index 刻度**：`--z-base 0` < `--z-sticky 10`（顶栏、sticky 表头）< `--z-dropdown 20`
（DropdownMenu/Select/Popover）< `--z-overlay 40` < `--z-dialog 50`（Dialog/AlertDialog/Sheet）<
`--z-toast 60`（sonner）< `--z-tooltip 70`。

密度：设置页提供 `comfortable`（默认）与 `compact`。以表格行为唯一影响面，通过 data 属性切换。

| 密度 | 行高 | 单元内边距 | 字号 |
|---|---|---|---|
| `comfortable` | 44px | `py-2.5 px-3` | 13px |
| `compact` | 32px | `py-1.5 px-2` | 13px |

## 6. 动效

| token | 值 | 用途 |
|---|---|---|
| `--duration-fast` | 120ms | hover、颜色/边框变化 |
| `--duration-base` | 200ms | 展开、Tab 切换、浮层进出 |
| `--duration-slow` | 300ms | Sheet/Dialog 位移 |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 常规 |
| `--ease-decelerate` | `cubic-bezier(0, 0, 0, 1)` | 进入 |
| `--ease-accelerate` | `cubic-bezier(0.3, 0, 1, 1)` | 退出 |

规则：只动 `opacity/transform/color`；轮询刷新（5s/60s/120s）**不触发**进出场动效，只做数值就地更新，
避免闪烁；`pending` 用不闪烁的 Skeleton/Spinner 表达，不整行变灰再复原。
`prefers-reduced-motion: reduce` 时**取消**位移动效，仅保留 ≤120ms 的透明度变化（对齐基线 §10 无障碍）。

## 7. 组件清单

标注「必须」为 MVP 依赖；「可选」按需引入，不阻塞首版。组件均从 shadcn/ui（base 风格）复制进仓库。

| 组件 | 必须/可选 | 用途 | 本项目使用场景 |
|---|---|---|---|
| Button | 必须 | 触发动作 | 刷新、启停/重启/同步、确认框主次按钮 |
| Badge | 必须 | 状态短标签 | `valid/expiring/expired/missing/unknown`、drift 种类 |
| Card | 必须 | 分区容器 | 总览汇总、KPI、额度桶、网关调度块 |
| Table / DataTable | 必须 | 主数据表 | 服务/额度/账号/用量/网关各主表（TanStack Table） |
| Dialog / AlertDialog | 必须 | 写操作确认 | 普通/高风险确认、真实试打加强确认（默认焦点取消） |
| Sheet | 必须 | 侧栏/移动端抽屉 | 导航折叠、行详情侧面板（窄屏） |
| Tabs | 必须 | 同级视图切换 | 网关子页、日志过滤视图、时间范围 |
| Tooltip | 必须 | 补充说明 | drift 解释、`—` 含义、截断的完整值 |
| Toast (sonner) | 必须 | 结果通知 | 任务完成/失败、只读拦截提示（不替代状态真值） |
| Progress | 必须 | 额度进度 | `total>0` 且剩余有效时的额度条 |
| Skeleton | 必须 | 首次加载骨架 | 表格/卡片首屏、stale 保留旧值时占位 |
| ScrollArea | 必须 | 定制滚动 | 日志区、长名单、命令面板 |
| Sidebar | 必须 | 左侧固定导航 | 九个页签 + 嵌套网关入口（响应式折叠） |
| Command | 必须 | 命令面板 | ⌘K 跳页/选 provider/执行显式动作 |
| DropdownMenu | 必须 | 行内/顶栏菜单 | 主题切换、provider 动作、时间范围 |
| Select | 必须 | 枚举选择 | 时间范围、日志行数、provider 过滤 |
| Input | 必须 | 文本输入 | 日志过滤、搜索、密钥前缀（脱敏展示） |
| Separator | 必须 | 视觉分隔 | 卡片内、详情区、菜单分组 |
| Switch | 必须 | 布尔开关 | 设置页：跟随系统、只读、SSE 跟随 |
| Breadcrumb | 必须 | 层级导航 | 网关嵌套路由定位 |
| Chart (Recharts) | 必须 | 图表 | 用量趋势、网关调度、Token 构成（§8） |
| Collapsible | 可选 | 可折叠区域 | 诊断文本详情、免费供应商清单、日志来源说明 |
| Popover | 可选 | 轻量浮层 | 环境信息、图例说明、Kbd 提示 |
| Empty | 可选 | 空状态 | 「该 provider 当前没有账号」等合法空态 |
| Spinner | 可选 | 任务进行中 | 任务状态、SSE 连接中（不闪烁） |
| Kbd | 可选 | 快捷键提示 | 帮助页、命令面板、日志暂停/跟随 |

原则：状态真值只来自 §2 语义色 + 文字/图标；Toast 只做**瞬时反馈**，不得成为唯一状态来源。

## 8. 图表规范

- **色板**：序列色优先复用 Provider 分类色（§3），同图固定「provider→色」映射；无归属的聚合序列用
  `--chart-1…5`（shadcn 默认）+ `--muted-foreground` 中性色。不得为同一 provider 换色。
- **轴**：X 轴时间按范围自适应（24h 到小时、30d/all 到日）；Y 轴从 0 起，标注单位（`steps`/`Token`/
  `credits`），**不**把 `steps` 写成请求数。
- **网格**：仅水平细网格（`--border`，虚线或低透明度）；去掉垂直网格；坐标轴用 `--muted-foreground`。
- **图例**：始终存在且带色彩外的第二标识（名称文本 + 色块）；点击图例可切换序列。
- **Tooltip**：显示序列名、值、单位、时间点；多序列按值排序。
- **空数据**：显示文字空态（对齐 [tui 14 §5](../tui/docs/14-usage-analytics.md)），**不**渲染空坐标框。
- **stale**：保留旧曲线并叠加「数据时间 + stale 标记」，不隐藏、不置零。
- **可访问性**：图形 ≥3:1 对比；提供表格化数值或 `aria` 摘要作为等价文本。

## 9. 图标与状态符号

图标统一 `lucide-react`，尺寸与文字对齐（`size-4` 内联、`size-5` 按钮），`stroke-width` 默认。
图标**始终**与文字/数值同现，不单独依赖形状。

| 语义 | 图标（lucide） | 颜色 token | 文字示例 |
|---|---|---|---|
| 运行 | `CirclePlay` / `Play` | `--success` | 运行中 |
| 停止 | `CircleStop` / `Square` | `--muted-foreground` | 已停止 |
| 漂移 | `TriangleAlert` / `GitCompareArrows` | `--warning` | 配置漂移 |
| 告警 | `TriangleAlert` | `--warning` | 需检查 |
| 过期/到期 | `Clock` / `CalendarClock` | `--destructive` 或 `--warning` | 已过期 / 1 天后到期 |
| 错误 | `CircleX` | `--destructive` | 失败 + 下一步 |
| 信息 | `Info` | `--accent` | 说明 |
| 进行中 | `LoaderCircle`（旋转，reduced-motion 下静止） | `--muted-foreground` | 正在启动… |

符号约定（终端降级/日志沿用，见 [tui 03 §13](../tui/docs/03-ui-design.md)）：`●` 运行、`○` 停止、
`✓` 成功、`!` 告警、`—` 未知/缺失。ASCII 环境用 `* OK ! -`。截断长名称保留完整值于 Tooltip/详情。

## 10. 主题切换（深色 / 浅色 / 跟随系统）

采用 shadcn Vite `ThemeProvider` 模式：`localStorage` 记住选择，`class` 策略在 `<html>` 上切
`.dark`，默认 **dark**（对齐基线 §15）。切换不重载页面、不闪烁。

| 项 | 值 |
|---|---|
| 存储 key | `router-panel-theme` |
| 取值 | `dark` \| `light` \| `system` |
| 默认 | `dark` |
| 策略 | `documentElement.classList` 增删 `light`/`dark`；`system` 时监听 `prefers-color-scheme` |
| 防闪 | 内联脚本在首帧前读取 key 并打 class |

```tsx
// App.tsx：包根布局；默认 dark，storageKey 与实现约定一致
export default function App({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="router-panel-theme">
      {children}
    </ThemeProvider>
  );
}

// 设置页：三态切换，不把 system 折叠成二值
const { theme, setTheme } = useTheme(); // "dark" | "light" | "system"
```

要求：主题切换必须即时作用于全部 token（含 Provider 分类色与语义色）；两种主题下均满足 WCAG 2.1
AA；仅显示颜色不做状态唯一判据；深色为默认，`system` 为可选，与 [11 可访问性与国际化](11-accessibility-i18n.md)
的对比度与降级验收一致。
