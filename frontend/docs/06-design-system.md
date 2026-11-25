# 06 设计系统

状态：已实现（2026-11-25）· 对应需求：FR-180–189 · 依据：Fluent 2 语义 token + Tailwind CSS + shadcn/ui 原语

本文件定义 `frontend/` 网页面板的**视觉与组件词表**：设计原则、token、Provider 分类色、排版、
间距/层级、动效、组件清单、图表规范、图标与状态符号、主题切换。token 与语义色以
[00 设计基线 §10](00-design-baseline.md#10-视觉与-token) 为上位定义，排版与状态符号参照
[`tui/docs/03-ui-design.md` §13](../../tui/docs/03-ui-design.md) 与
[`tui/docs/14-usage-analytics.md` §5](../../tui/docs/14-usage-analytics.md)。本文只定义取值与用法，
不改变页面信息架构（见 [03 界面设计](03-ui-design.md)）。

**取值性质**：视觉基线是 **Fluent 2 语义 token**（`--accent-*`、`--surface-*`、`--stroke-*`、
`--text-*`、`--status-*`、elevation / radius / motion）。实现同时**保留旧 shadcn 变量名**
（`--background`、`--card`、`--primary`、`--muted` 等），把它们映射到 Fluent 值，因此既有的
`bg-card` / `text-muted-foreground` / `border-border` 等类无需改名即可继续工作。下表取值来自
`src/styles/index.css`，修改 token 必须同步深浅色与高对比三套值。

## 1. 设计原则

| 原则 | 含义 | 落地约束 |
|---|---|---|
| 状态真实 | `null`、`0`、加载失败、未查询是四种状态 | 未知显示 `—`；不把 pending 渲染成目标状态（§9） |
| 危险可见 | 高风险写操作影响面显式 | 危险色只用于真实危险；默认焦点"取消" |
| 密度优先 | 面向运维的多行表格 | 表格 13px、紧凑行高可选；关键列不换行 |
| 颜色不单独表意 | 色盲/高对比/打印下仍可读 | 每个颜色状态**同时**有图标/文字/数值 |
| 中文与宽字符正确 | 中英混排、截断不产生半字 | 字体回退含中文字族；`truncate` 配 `title`/详情 |

## 2. Token 规范

### 2.1 Fluent 原生语义 token

Fluent 2 负责「这是什么面 / 什么文字 / 什么状态」，Tailwind 只消费这些变量。

| Token | 角色 | 浅色 | 深色 |
|---|---|---|---|
| `--accent-rest` | 主操作/品牌静止态 | `#0f6cbd` | `#62b0f8` |
| `--accent-hover` | 主操作悬停 | `#115ea3` | `#7cc1f7` |
| `--accent-pressed` | 主操作按下 | `#0f548c` | `#4a9df0` |
| `--accent-selected` | 选中底（12%/18% 同色） | `color-mix(#0f6cbd 12%)` | `color-mix(#479ef5 18%)` |
| `--accent-subtle` | 悬停底（7%/10% 同色） | `color-mix(#0f6cbd 7%)` | `color-mix(#479ef5 10%)` |
| `--accent-on` | accent 上的文字 | `#ffffff` | `#0b1220` |
| `--surface-1` | 卡片面 | `#ffffff 92% + #0f6cbd 8%` | `#2b2b32 88% + #479ef5 12%` |
| `--surface-2` | 内嵌块/工具条 | `#ffffff 85% + #0f6cbd 15%` | `#ffffff 6% + #1f1f24` |
| `--surface-3` | 浮起面（弹层） | `#ffffff` | `#2c2c33` |
| `--stroke-1` | 常规描边 | `#101828 / 10%` | `#ffffff / 12%` |
| `--stroke-2` | 控件描边 | `#101828 / 16%` | `#ffffff / 18%` |
| `--text-primary` | 主文字 | `#1b1b1f` | `#f3f3f3` |
| `--text-secondary` | 次文字 | `#4a4a52` | `#c2c2cc` |
| `--text-tertiary` | 辅助文字（≥4.5:1） | `#5c5c66` | `#b0b0ba` |
| `--status-success` | 成功/运行 | `#0b6b0b` | `#70cc70` |
| `--status-warning` | 警告/冷却 | `#844d00` | `#f7c85c` |
| `--status-danger` | 危险/错误 | `#a92115` | `#ffa8b1` |
| `--status-info` | 信息 | `#0a5799` | `#86c8f8` |
| `--radius-2/4/8/12/16` | 圆角刻度 | 2/4/8/12/16px | 同左 |
| `--motion-fast` / `--motion-normal` | 动效时长 | 150ms / 250ms | 同左 |
| `--motion-curve` | 标准曲线 | `cubic-bezier(0.2, 0, 0, 1)` | 同左 |

材质与阴影：`--shadow-2/4/8/16`（elevation），浮层另用 `--shadow-flyout`；
`--mica-base` 是应用底，`--mica-layer-a/b` 只给 Mica 的两层极轻径向渐变使用。

### 2.2 旧 shadcn 变量名 → Fluent 映射（兼容层）

| 旧变量 | 映射到 | 说明 |
|---|---|---|
| `--background` | `--mica-base` | 应用底，不再是纯白/纯黑 |
| `--foreground` | `--text-primary` | 默认文字 |
| `--card` / `--card-foreground` | `--surface-1` / `--text-primary` | 卡片面 |
| `--popover` / `--popover-foreground` | `--surface-3` / `--text-primary` | 弹层面 |
| `--primary` / `--primary-foreground` | `--accent-rest` / `--accent-on` | 主操作 |
| `--secondary` | `--surface-2` | 次级填充面 |
| `--muted` | `--surface-2` | 弱化面 |
| `--muted-foreground` | `--text-secondary` | 弱化文字 |
| `--accent` | `--accent-selected` | 菜单/选中底 |
| `--destructive` | `--status-danger` | 破坏/错误 |
| `--border` | `--stroke-1` | 边框/分隔 |
| `--input` | `--stroke-2` | 表单控件边 |
| `--ring` | `--accent-rest` | 焦点环 |
| `--success` / `--warning` / `--info` | `--status-*` | 语义状态色 |

语义色映射（基线 §10 的语义集）：

| 语义 | 落地 token | 说明 |
|---|---|---|
| `success` | `--success` → `--status-success` | 运行正常、任务成功、`valid` |
| `warning` | `--warning` → `--status-warning` | `expiring`、冷却、`warn` 健康 |
| `error` | `--destructive` → `--status-danger` | 错误与破坏同色，不新增 `--error` |
| `info` | `--info` → `--status-info` | 信息态；不再复用 accent |
| `muted` | `--muted` / `--muted-foreground` | 未知、禁用、次要说明 |
| `selected` | `--accent-selected` / `--accent-subtle` | 选中项与悬停底分开 |
| `border` / `background` / `foreground` | 同名兼容变量 | 见 §2.2 |
| `accent` | `--accent-rest/hover/pressed` | 主操作与菜单高亮 |

```css
@custom-variant dark (&:is(.dark *));

:root {
  /* Fluent 原生层 */
  --accent-rest: #0f6cbd;
  --accent-selected: color-mix(in oklab, #0f6cbd 12%, transparent);
  --surface-1: color-mix(in oklab, #ffffff 92%, #0f6cbd 8%);
  --surface-2: color-mix(in oklab, #ffffff 85%, #0f6cbd 15%);
  --stroke-1: color-mix(in oklab, #101828 10%, transparent);
  --text-primary: #1b1b1f;
  --text-secondary: #4a4a52;
  --text-tertiary: #5c5c66;   /* 11px 文案仍满足 AA 4.5:1 */
  --status-success: #0b6b0b;
  --status-warning: #844d00;
  --status-danger: #a92115;
  --status-info: #0a5799;
  --radius-4: 4px;
  --radius-8: 8px;
  --radius-12: 12px;
  --radius-16: 16px;
  --motion-fast: 150ms;
  --motion-normal: 250ms;
  --motion-curve: cubic-bezier(0.2, 0, 0, 1);

  /* 旧 shadcn 变量全部映射，避免页面类名迁移 */
  --background: var(--mica-base);
  --foreground: var(--text-primary);
  --card: var(--surface-1);
  --popover: var(--surface-3);
  --primary: var(--accent-rest);
  --secondary: var(--surface-2);
  --muted: var(--surface-2);
  --muted-foreground: var(--text-secondary);
  --accent: var(--accent-selected);
  --destructive: var(--status-danger);
  --border: var(--stroke-1);
  --input: var(--stroke-2);
  --ring: var(--accent-rest);
  --success: var(--status-success);
  --warning: var(--status-warning);
  --info: var(--status-info);
}

.dark {
  --accent-rest: #62b0f8;
  --surface-1: color-mix(in oklab, #2b2b32 88%, #479ef5 12%);
  --surface-3: #2c2c33;
  --stroke-1: color-mix(in oklab, #ffffff 12%, transparent);
  --text-primary: #f3f3f3;
  --text-secondary: #c2c2cc;
  --text-tertiary: #b0b0ba;
  --status-success: #70cc70;
  --status-warning: #f7c85c;
  --status-danger: #ffa8b1;
  --status-info: #86c8f8;
  /* background/card/primary/... 需在 .dark 内再映射一次，不能只靠继承 */
}
```

### 2.3 高对比

支持两条入口，效果一致：

- `@media (prefers-contrast: more)`：自动提高描边与 `text-secondary/tertiary` 对比度；
- `:root.high-contrast` 与 `:root.high-contrast.dark`：显式高对比调色板（白底黑边/黑底白边、
  accent 加深、状态色重新校核）。`ThemeProvider` 暴露 `contrast` 与 `setContrast('normal'|'high')`，
  顶栏主题菜单可手动打开；系统 `prefers-contrast: more` 开启时也会自动启用。

高对比下背景纹理（Mica 层）归零，只保留纯色底，确保正文 ≥4.5:1、非文本 ≥3:1。

## 3. Provider 分类色

稳定映射（对齐 [00 §10](00-design-baseline.md#10-视觉与-token) 与
[tui 14 §5](../../tui/docs/14-usage-analytics.md)）。色相角度用于区分，**不作为唯一区分手段**：
图例、文字标签、图标始终同时存在。同一对明暗取值须各自满足 WCAG 2.1 **AA**（正文 ≥4.5:1，
大字/图形 ≥3:1）。

| Provider | 颜色 | 色相 | 浅色示例 | 深色示例 | token |
|---|---|---|---|---|---|
| `codearts` | 紫 | 300 | `#9260da` | `oklch(0.72 0.16 300)` | `--provider-codearts` |
| `qoder-cn` | 青 | 195 | `#009798` | `oklch(0.74 0.12 195)` | `--provider-qoder-cn` |
| `qoder` | 蓝 | 255 | `#2b7ad6` | `oklch(0.72 0.14 255)` | `--provider-qoder` |
| `trae-local` | 绿 | 150 | `#1b9247` | `oklch(0.74 0.14 150)` | `--provider-trae-local` |
| `workbuddy` | 黄 | 75 / 80 | `#b67c0d` | `oklch(0.80 0.12 80)` | `--provider-workbuddy` |
| `workbuddy-global` | 浅紫 | 300 | `#8e6ac7` | `oklch(0.74 0.13 300)` | `--provider-workbuddy-global` |
| `zcode` | 橙 | 50 / 55 | `#cf630d` | `oklch(0.76 0.14 55)` | `--provider-zcode` |
| `loomy` | 洋红 | 350 | `#cd4290` | `oklch(0.74 0.16 350)` | `--provider-loomy` |
| `raccoon` | 红 | 25 | `#d24c49` | `oklch(0.74 0.15 25)` | `--provider-raccoon` |
| `qwenwork` | 天蓝 | 205 | `#0092a7` | `oklch(0.74 0.13 205)` | `--provider-qwenwork` |
| `dumate` | 绿 | 120 | `#748d00` | `oklch(0.76 0.14 120)` | `--provider-dumate` |
| `lingxi` | 品红 | 330 | `#b05baa` | `oklch(0.75 0.13 330)` | `--provider-lingxi` |
| `lobster` | 朱红 | 10 | `#d44567` | `oklch(0.74 0.16 10)` | `--provider-lobster` |
| `gateway` | 中性 | — | `#5b646f` | `oklch(0.78 0.02 250)` | `--provider-gateway` |

命名约定 `--provider-<id>`；组件与图表**只从该表取值**，禁止在代码里写死 hex，也禁止为同一
provider 在不同页面换色。id 与 [00 §4](00-design-baseline.md#4-providerregion-与网关的关系) 的
十三家白名单 provider 及 `gateway` 一一对应。浅色示例取 `:root` 的实际 oklch 换算值，
深色示例取 `.dark` 的实际 token；改为 CSS 新值时必须同步本表。

## 4. 排版

| 项 | 值 |
|---|---|
| UI 字体族 | `Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, -apple-system, PingFang SC, sans-serif` |
| 展示字体族 | `--font-display`：`Segoe UI Variable Display` 优先，用于页面标题与 KPI 数值 |
| 等宽字体族 | `Cascadia Code, ui-monospace, JetBrains Mono, Consolas, monospace` |
| 字号阶梯 | Fluent ramp：12 / 14 / 16 / 20 / 28（px）；密集表格与辅助文案另有 11 / 13px 变体 |
| 行高 | 正文 1.45、标题 1.25、表格 1.35、等宽日志 1.5 |
| 字重 | 400 正文、500 强调/表头、600 标题与 KPI；避免 700 撑破紧凑行 |

| 层级 | 字号 | 用途 |
|---|---|---|
| `text-[11px]` | 11 | 徽标、脚注、时间戳、LiveBadge（已校核 4.5:1） |
| `text-ramp-12` | 12 | 辅助说明、表头、Kbd |
| `text-[13px]` | 13 | **表格正文**、日志、端口/PID |
| `text-ramp-14` | 14 | **UI 正文**、菜单、表单 |
| `text-ramp-16` | 16 | 区块标题、页头紧凑模式 |
| `text-ramp-20` | 20 | 页面标题（`PageHeader`）、环 gauge 中心值 |
| `text-ramp-28` | 28 | KPI 主数值（`MetricCard` comfortable） |

`PageHeader` 的标题层级是 20px（compact 16px），`SectionHeader` 是 16px（compact 14px）；
`MetricCard` compact 密度把主数值降到 20px。数字列一律 `tabular-nums` 右对齐。

数字：表格数值列、KPI、Token、耗时一律右对齐并启用 `tabular-nums`，避免跳动。

```tsx
// 端口/PID/日志用等宽；数值列右对齐 + 等宽数字
<span className="font-mono text-[13px] tabular-nums">10087</span>
<span className="text-right tabular-nums">6,599 credits</span>
```

## 5. 间距 / 圆角 / 材质 / 层级 / 密度

| 刻度 | 取值 |
|---|---|
| 间距 | `4px` 基准：4 / 8 / 12 / 16 / 24 / 32（`gap-1…gap-8`） |
| 圆角 | `--radius-2/4/8/12/16`；Tailwind `rounded-sm=4 / md=lg=8 / xl=12 / 2xl=16` |
| 阴影 | `elevation-2` 行内、`elevation-4` 卡片、`elevation-8` 浮层、`elevation-16` Dialog/Sheet |
| z-index | 见下方刻度，禁止散落魔数 |

### 5.1 材质与工具类

| 工具类 | 用途 | 实现 |
|---|---|---|
| `.mica` | 应用底 | `--mica-base` + 两层极轻径向渐变，`background-attachment: fixed` |
| `.acrylic` | 弹层/抽屉/下拉/命令面板 | 半透明 `surface-3` + `backdrop-filter: blur(30px) saturate(125%)` + 1px stroke；不支持 `backdrop-filter` 时回退不透明 |
| `.layer-1` | 卡片/主面板 | `surface-1` + `stroke-1` + 8px 圆角 + `shadow-2` |
| `.layer-2` | 内嵌块/工具条 | `surface-2` + `stroke-1` + 4px 圆角 |
| `.elevation-2/4/8/16` | 单独控制阴影 | 对应 `--shadow-*` |
| `.page-enter` | 路由页面进入 | 250ms fade + `translateY(4px)`，`reduced-motion` 下关闭 |
| `.fluent-focus` | 自定义可聚焦元素 | 2px accent focus rectangle + 2px offset，仅 `:focus-visible` |

材质只用在这三类容器，不把 Mica/Acrylic 叠加到表格行或 KPI 卡内部，避免层次浑浊。

**z-index 刻度**：`--z-base 0` < `--z-sticky 10`（顶栏、sticky 表头）< `--z-dropdown 20`
（DropdownMenu/Select/Popover）< `--z-overlay 40` < `--z-dialog 50`（Dialog/AlertDialog/Sheet）<
`--z-toast 60`（sonner）< `--z-tooltip 70`。

密度：设置页提供 `comfortable`（默认）与 `compact`。组件层通过 `density` prop 或 data 属性切换。

| 密度 | 行高 | 单元内边距 | 字号 |
|---|---|---|---|
| `comfortable` | 44px | `py-2.5 px-3` | 13px |
| `compact` | 32px | `py-1.5 px-2` | 13px |

`MetricCard` / `PageHeader` / `SectionHeader` 额外接受 `density: 'compact' \| 'comfortable'`。

## 6. 动效

| token | 值 | 用途 |
|---|---|---|
| `--motion-fast` | 150ms | hover、颜色/边框变化、导航指示条 |
| `--motion-normal` | 250ms | 展开、页面进入、RingGauge 弧线 |
| `--motion-curve` | `cubic-bezier(0.2, 0, 0, 1)` | 全部标准曲线 |
| `.page-enter` | 250ms | fade + `translateY(4px)` |
| Sheet 进出 | 150 / 250ms | 左右/底部 8px 位移 |

规则：只动 `opacity/transform/color/stroke-dashoffset`；轮询刷新（5s/60s/120s）**不触发**进出场
动效，只做数值就地更新，避免闪烁；`pending` 用不闪烁的 Skeleton/Spinner 表达，不整行变灰再复原。
`prefers-reduced-motion: reduce` 时全局把 animation/transition 压到 0.01ms，`.page-enter` 位移归零；
焦点环与选中态**保留**（对齐基线 §10 与 11 文档）。

## 7. 组件清单

标注「必须」为 MVP 依赖；「可选」按需引入，不阻塞首版。原语仍从 shadcn/ui（base 风格）复制进仓库，
视觉由 Fluent token 与共享容器统一；业务页不直接写颜色或阴影。

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
| Sidebar | 必须 | 240px 固定导航 | 10 个顶层项（概览/数据/系统三组）+ 6 个网关子页；<900px 折叠为 Sheet |
| Command | 必须 | 命令面板 | ⌘/Ctrl+K 跳页、刷新全部；Acrylic 浮层 |
| DropdownMenu | 必须 | 行内/顶栏菜单 | 主题、对比度、provider 动作、时间范围 |
| Select | 必须 | 枚举选择 | 时间范围、日志行数、额度排序、provider 过滤 |
| Input | 必须 | 文本输入 | 日志过滤、搜索、密钥前缀（脱敏展示） |
| Separator | 必须 | 视觉分隔 | 卡片内、详情区、菜单分组 |
| Switch | 必须 | 布尔开关 | 设置页：跟随系统、只读、SSE 跟随 |
| Breadcrumb | 必须 | 层级导航 | 顶栏与 PageHeader 的当前页定位 |
| Chart (Recharts) | 必须 | 图表 | 每日活动、网关用量、Token 构成、报表趋势（§8） |
| `Surface` / `Layer` | 必须 | Fluent 表面容器 | `level=1/2/3`、`acrylic`、`padding`；`Layer` 为无内边距别名 |
| `SectionHeader` | 必须 | 区块标题 | `title/description/actions/icon/density/as` |
| `Toolbar` | 必须 | 筛选/操作条 | `trailing`、`surface`；默认 `role="toolbar"` + 可访问名 |
| `Sparkline` | 必须 | 迷你趋势 | 纯 SVG，`data/label/description/fill/dot`；少于 2 点显示占位 |
| `RingGauge` | 必须 | 环形比例 | `value(0–100\|null)/display/caption/label/size/thickness/color`；`null` 不画弧 |
| `LiveBadge` | 必须 | 实时状态胶囊 | `kind(gateway/readonly/demo/unknown)/tone/label/hint/pulse`；图标 + 文字 |
| `ProviderChip` | 必须 | Provider 名称/分类色 | `compact` 只显示名称，`title`/`aria-label` 保留 id；完整 id 留给详情抽屉 |
| `MetricCard` | 必须 | KPI 瓦片 | `label/value/sub/hint/tone/spark/trend/density/accessory/onClick/sparkLabel` |
| `PageHeader` | 必须 | 页头 | `title/description/actions/as/eyebrow/breadcrumb/density` |
| `Empty` | 必须 | 空状态 | 加载/空/筛空/错误分别呈现，不只显示 0 |
| Collapsible | 可选 | 可折叠区域 | 诊断文本详情、免费供应商清单、日志来源说明 |
| Popover | 可选 | 轻量浮层 | 环境信息、图例说明、Kbd 提示 |
| Spinner | 可选 | 任务进行中 | 任务状态、SSE 连接中（不闪烁） |
| Kbd | 可选 | 快捷键提示 | 帮助页、命令面板、日志暂停/跟随 |

原则：状态真值只来自 §2 语义色 + 文字/图标；Toast 只做**瞬时反馈**，不得成为唯一状态来源。
`ProviderChip compact` 的可见文本只有中文名，provider id 进 `title` 与 `aria-label`；网关三页
（`/gateway` 调度、`/gateway/combos` 降级链、`/gateway/usage` 网关用量）统一用它，不再出现
`qoder-cn qoder-cn` 这类「名称 + id」重复；未知 id（`ollama`/`lmstudio`/`llamacpp`）回落成 id 本身，
也不重复。服务页、诊断页、设置页与详情抽屉仍保留完整「名称 + id」，这是刻意不同。
`MetricCard` 的 `spark`/`trend` 会自动生成 `sr-only` 摘要并通过 `aria-describedby` 关联；
`Sparkline` 默认 `aria-hidden`，只有传 `label` 时才作为 `role="img"` 暴露给读屏。

## 8. 图表规范

- **色板**：序列色优先复用 Provider 分类色（§3），同图固定「provider→色」映射；Token 构成用
  `--info`（输入）/ `--success`（输出）/ `--warning`（推理），缓存读写用 `--primary` + `--muted-foreground`。
  不得为同一 provider 换色。
- **轴**：X 轴时间按范围自适应（24h 到小时、30d/all 到日）；Y 轴从 0 起，标注单位（`steps`/`Token`/
  `credits`），**不**把 `steps` 写成请求数。网关用量是双轴（请求数 + 错误数）时须在轴上标明。
- **网格**：仅水平细网格（`--border`，虚线或低透明度）；去掉垂直网格；坐标轴用 `--muted-foreground`。
- **图例**：始终存在且带色彩外的第二标识（名称文本 + 色块）；点击图例可切换序列。
- **Tooltip**：显示序列名、值、单位、时间点；多序列按值排序。
- **空数据**：显示文字空态（对齐 [tui 14 §5](../../tui/docs/14-usage-analytics.md)），**不**渲染空坐标框。
- **stale**：保留旧曲线并叠加「数据时间 + stale 标记」，不隐藏、不置零。
- **Sparkline**：纯 SVG，只画真实点，不插值；少于 2 点显示「数据不足」占位，不伪造趋势。
- **RingGauge**：`value=null` 不画弧、显示 `—`；环本身 `aria-hidden`，文字/`sr-only` 摘要承载数值。
- **可访问性**：图形 ≥3:1 对比；提供表格化数值或 `aria` 摘要作为等价文本；`reduced-motion` 下
  关闭入场动画与弧线过渡。

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
| 信息 | `Info` | `--info` | 说明、演示、只读 |
| 网关可达 | `Wifi` / `WifiOff` | `--success` / `--destructive` | LiveBadge 的网关胶囊 |
| 报表 | `ChartNoAxesCombined` | `--accent-rest` | 导航「报表」 |
| 进行中 | `LoaderCircle`（旋转，reduced-motion 下静止） | `--muted-foreground` | 正在启动… |

符号约定（终端降级/日志沿用，见 [tui 03 §13](../../tui/docs/03-ui-design.md)）：`●` 运行、`○` 停止、
`✓` 成功、`!` 告警、`—` 未知/缺失。ASCII 环境用 `* OK ! -`。截断长名称保留完整值于 Tooltip/详情。
LiveBadge 始终「圆点/图标 + 文本」同现，圆点只是装饰，`aria-label` 给出完整语义。

## 10. 主题切换（深色 / 浅色 / 跟随系统）

采用自建 `ThemeProvider`（React context）保留 shadcn 的 class 策略：`localStorage` 记住选择，
在 `<html>` 上切 `.dark`/`.light`，默认 **dark**（对齐基线 §15）。切换不重载页面、不闪烁。

| 项 | 值 |
|---|---|
| 主题存储 key | `router-panel-theme` |
| 对比度存储 key | `router-panel-contrast` |
| 主题取值 | `dark` \| `light` \| `system` |
| 对比度取值 | `normal` \| `high` |
| 默认 | 主题 `dark`、对比度 `normal` |
| 策略 | `documentElement.classList` 增删 `light`/`dark`/`high-contrast`；`system` 监听 `prefers-color-scheme`，高对比同时监听 `prefers-contrast: more` |
| 入口 | 顶栏主题菜单（含高对比）；设置页外观卡同时提供主题三态与对比度（标准/高对比） |

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
