# 09 测试策略

状态：已实现并实测（2026-11-25）
对应需求：NFR-108/109

> NFR-108：无真实凭证也能跑通 CI（确定性、匿名、可重复）。NFR-109：桥接契约可解析、
> 可升版、容忍未知字段与未知 enum。本文只描述测试策略与验收口径，不含实现代码；
> 术语与状态口径以 [00 设计基线](00-design-baseline.md) 与 [`tui/docs/12-glossary.md`](../../tui/docs/12-glossary.md) 为准。
> 桥接端点引用 [00 设计基线 §11](00-design-baseline.md#11-桥接服务契约摘要细节见-05)；`05-backend-contract.md` 成文后以其为准。

## 1. 测试目标与原则

网页面板与 `router-tui` 是同一套语义的两个前端，测试目标继承 [`tui/docs/09-testing.md`](../../tui/docs/09-testing.md)，
并按浏览器/HTTP 媒介重述：

| 编号 | 原则 | 落地约束 |
|---|---|---|
| P1 | **无凭证也能跑 CI** | 公共 CI 只跑匿名 fixtures 与 `--demo` 桥接；不读 `router.json`、`gateway/data/`、`~/.pi` |
| P2 | **不执行真实写操作** | 测试不调用真实 `up/down/on/all/restart`、不签到、不真实试打、不发起 `login`/`account add` |
| P3 | **契约驱动** | 所有数据经 Zod schema 解析；fixtures 即契约样本；CLI JSON → 领域模型映射有独立用例 |
| P4 | **UI 与桥接解耦** | 浏览器侧只经 MSW 消费 `frontend/fixtures/` 的 `/api/*` 与 SSE，不依赖真实桥接进程 |
| P5 | **状态口径一致** | `null`／加载失败／未查询／真实 `0` 是四种状态；未知显示 `—`（00 §7） |
| P6 | **安全可回归** | 脱敏与控制序列清理是被测能力，不是旁路；只读/演示拦截在桥接层可断言（00 §12） |
| P7 | **不解析人类文本** | 禁止用正则把 CLI 人类文本转成结构化字段；文本只作展示（00 §13） |
| P8 | **下层优先** | 下层失败先修下层，不用人工测试掩盖自动化缺口 |

## 2. 测试分层金字塔

```text
        Playwright（--demo 桥接端到端 + axe）
      ─────────────────────────────────────────
        假桥接 MSW（/api/* 与 SSE，匿名 fixtures）
      ─────────────────────────────────────────
          契约 Zod + fixtures（CLI JSON → 领域模型）
        ───────────────────────────────────────
          组件 RTL（每 feature 状态渲染、确认框、只读）
        ───────────────────────────────────────
              单元 Vitest（纯函数、推导、清理、换算）
```

公共 CI 只运行确定、匿名、可重复的自动化层级；无法稳定自动化的部分进入 §8 人工矩阵。

### 2.1 单元（Vitest）

纯函数、无 DOM、无网络。用 `vitest run`，覆盖率作为参考指标而非门禁。

| 目标 | 用例要点 |
|---|---|
| 格式化 | 时间（Iso/IsoMs → 本地显示）、单位（credits/tokens/days）、大数缩写、数字右对齐与 `—` 回退；`null` 不显示为 `0` |
| drift 推导 | 穷举 `on/up/oc/ocUserOwned` 组合：`stopped`、`notSynced`、`stillRunning`、`ocUserOwned` 永不报同步漂移（00 §7） |
| 脱敏 | Bearer、伪 API key、伪 PAT、`Authorization`、JSON token 字段、URL query 中的密钥被替换为占位符 |
| 控制序列清理 | ANSI CSI/OSC、clipboard、cursor、C0/C1、Unicode bidi 控制被剥离；超长行被有界截断并标记 |
| 额度计算 | `remaining=0`／`total=0`／`total=null` 不计算百分比；`credits/days` 不混合；不显示跨家总额 |
| 时间范围换算 | `24h|7d|30d|all` → `from/to` 毫秒区间；边界含当月、DST 与本地时区偏移 |
| Zod 契约解析 | envelope `{schemaVersion,generatedAt,ok,data?,error?}` 解析；未知字段透传不报错；缺核心字段给出最小范围错误 |
| 状态推导 | `stale`、`lastSuccessAt`、`receivedAt`、`fetchedAt` 的推导；`steps`、`cost` 仅展示不折算 |
| Provider 白名单 | `tests/bridge-provider-whitelist.test.ts` 钉住白名单 ⊇ `router.mjs` 真实 id；`tests/provider-coverage.test.ts` 校验 13 家分类色与标题 |
| usage 模型归一化 | 真实嵌套 `{model:{id,providerID,variant}}` 与扁平夹具都接受；同 `providerID/id` 的 variant 合并，steps/cost/tokens 相加；空 id 丢弃 |

### 2.2 组件（React Testing Library）

对每个 feature 断言**加载／空／错误／stale／只读**五态齐全，且状态不只靠颜色。
其中「加载中」不得被断言或渲染成「空」：真实 `/api/quota` 首次约 24s，首屏加载态必须与
「成功但 0 行」分开（见 §2.5 真实模式注意点）。

| 页面（ID） | 必测渲染 |
|---|---|
| `overview` | 正常、混合漂移、局部失败、首次加载（`—`）、stale 角标；额度三态（加载中「正在读取额度…」/ 失败 / 空） |
| `providers` | 操作中（pending 不预改状态）、只读、普通确认、高风险确认、成功后刷新未确认 |
| `quota` | 多单位、多账号、空桶、可领取、活动关闭、`fetchedAt` 过期 |
| `accounts` | 单账号、多账号、空账号、dry-run 预览、平台不支持 |
| `logs` | 空日志、过滤、暂停、跟随、截断、脱敏后显示 |
| `diagnostics` | 环境错误、健康部分失败、真实试打加强确认（默认折叠） |
| `usage` | 六 KPI、双模式活动图、Token 构成、工具可靠性、缓存效率、模型表排序、CSV 导出；空活动、旧数据 stale |
| `reports` | 五源状态、结论按数据生成、范围映射、CSV/JSON 导出、打印样式；空/失败/stale |
| `gateway/*` | 调度 lane（成功率三态：有样本 / 真 0% / 无样本 `—`）、用量双轴/Token 图、降级链阶梯、密钥（只显示 SHA-256 摘要）、免费供应商只读、本地应答；三页 chip 为 `compact` |
| `settings` | 主题、对比度、刷新间隔、只读、桥接连接、演示模式切换 |

组件层通用断言：

- **确认框默认焦点**在"取消"；高风险必须列出受影响名单；`Esc` 关闭并回焦触发按钮。
- **危险名单**：`on/all/none` 与"恢复整池"渲染受影响 provider/account 列表，缺项即失败。
- pending 期间按钮禁用且不乐观改状态；失败路径给"下一步"。
- 键盘：Tab 顺序合理、焦点可见、`aria-live` 播报任务完成。
- 只读模式：写按钮隐藏或禁用，并断言桥接返回的 403 有对应提示。

### 2.3 契约（Zod + fixtures）

映射"CLI 输出 → 领域模型（00 §6）"，是 P3 的核心证据。

| 契约面 | 用例要点 |
|---|---|
| Provider | `list --json` v0（缺 `schemaVersion`/`auth`）与 v1 均可解析；`auth.label` 与 `state` 不一致时以 `state` 为状态机输入并保留诊断；`models/pid/pids` 的 `null`/空数组合法 |
| Account | 全部与单 provider 两种形状；空账号、`switchable=false`、多账号 `active/enabled` 组合；平台不支持 |
| Quota | 顶层数组 legacy 兼容；qoder buckets、Trae/CodeArts accounts、WorkBuddy days；`available=false`、单账号 `error`、缺失 `checkin` |
| Gateway | `status/usage/balance` 快照字段完整；cooldown 缺省、`dialect` 未知值 |
| 升版 | 未知 `schemaVersion`（更高 major）给出明确兼容性错误；同级新增字段 additive 通过 |
| 未知 | 额外 provider、额外字段、未知 enum 不崩溃、不丢数据、可只读展示 |
| 边界 | 非法 JSON、stdout 混入噪音、超大输出被限制并诊断；`stdout` 与 `stderr` 不混合解析 |

### 2.4 假桥接（MSW）

浏览器侧用 MSW 拦截 `GET /api/*`、`POST /api/actions` 与 SSE，数据全部来自 `frontend/fixtures/`，
**不启动真实桥接、不 spawn CLI、不访问真实文件**。同一 fixtures 同时供 Playwright 的 `--demo` 桥接复用，避免两份真相。

### 2.5 端到端（Playwright）

对 `--demo` 桥接运行（见 §7），至少覆盖：

| 场景 | 断言 |
|---|---|
| 全页面冒烟 | 15 个路由页（含 6 个 `gateway/*` 子页）依次可达，页面无未捕获错误、无控制台 error |
| 键盘与焦点 | Skip link 首焦点、主导航 `aria-current`、`Esc` 关闭弹层、焦点回到触发处、额度页 `r` 只触发一次 |
| 命令面板 | `Ctrl/⌘+K` 打开/关闭、输入过滤、`↑↓` 选择、回车跳转报表页 |
| 确认流程 | 普通/高风险确认、默认焦点在取消、受影响的 `on/all/none` 名单可见 |
| 日志跟随 | 连接 SSE、追加行、暂停/恢复跟随、`End` 复位、断开重连 |
| 响应式断点 | 375 / 768 / 1440 三档 × 8 个关键页，`scrollWidth - clientWidth <= 1`；侧栏折叠与图表不溢出 |
| URL 即状态 | 选中 provider、时间范围、过滤、排序进 search params；刷新后恢复；后退有效 |
| 报表 | 五源状态、范围映射、CSV 下载内容、窄屏不溢出、打印入口存在 |

**实测（2026-11-25，demo 桥接）**：demo 套件 **103 passed / 9 skipped / 0 failed**；
`real.spec.ts` 按设计跳过（需 `PANEL_E2E_REAL=1`）。`workers=1`、headless、`PANEL_E2E_PORT=8892`。

真实只读验收是**本地人工链路**，不替代 demo 的确定性 CI：

```bash
node server/index.mjs --read-only --port 8894
PANEL_E2E_REAL=1 PANEL_E2E_PORT=8894 npx playwright test e2e/real.spec.ts --workers=1
```

**实测（2026-11-25，真实只读桥接 8894）**：**9 passed / 0 failed**。断言 14 条 provider
（13 反代 + `gateway`）、无演示徽标、额度/报表无 `example-`/`demo-`/`slot-a`、用量为真实数值、
网关返回真实数据；全程只读，不点击任何写操作。

真实模式的几个注意点（都是「加载态不等于空态」的具体形态，写断言时别踩）：

- **`/api/quota` 首次约 24s**：网关 `/v1/gateway/balance` 本身慢，桥接该路径超时已放宽到 45s。
  E2E 必须先等额度三态里的「加载完成」，不能把首屏的加载态断言成空态或少数据。
- 额度加载中：右栏额度 Top 为 `正在读取额度…`（`role="status"`），KPI「额度可领取」为 `…`，
  矩阵额度列为灰字 `读取中`（`title` 说明 `—` 不代表没有额度）；失败为「额度数据读取失败」；
  只有成功且 0 行才是原空态。
- **调度成功率无样本不显示 0%**：`/v1/gateway/status` 的 16 个上游里只有被调用过的（`lastUsedAt > 0`）
  有样本，其余显示 `—` + 「尚无调用样本」且不画进度条；真实只读验收时不要断言「全部上游都有成功率」。

### 2.6 可访问性

- **自动化**：`@axe-core/playwright` 对 15 个路由页 + 命令面板运行，规则集
  `wcag2a/wcag2aa/wcag21a/wcag21aa`；深色 16 个目标与浅色 5 页抽检均为 **0 violation**
  （critical/serious/moderate/minor 全 0）。`KNOWN` 豁免清单已清空，新增 serious/critical 一律失败。
- **人工矩阵**：纯键盘走查（无需鼠标完成一次启停预览）、NVDA（Windows）与 VoiceOver（macOS）读屏抽检、`prefers-reduced-motion` 下无强制动效、对比度符合 WCAG 2.1 AA（00 §10）。细节与 `11-accessibility-i18n.md` 一致。

## 3. 测试数据

所有 fixtures 为**匿名虚构**，与 [`tui/docs/09-testing.md`](../../tui/docs/09-testing.md) 场景命名对齐。

### 3.1 目录结构与命名

```text
frontend/fixtures/
├─ scenarios.json              # 场景 → fixture 文件清单（MSW 与 --demo 桥接共用）
├─ cli/                        # 桥接输入：CLI/网关原始输出（匿名）
│  ├─ list.healthy.json         # 已实现 JSON
│  ├─ account.healthy.json
│  ├─ account-check.mixed.json
│  ├─ quota.healthy.json
│  ├─ usage.7d.json
│  ├─ gateway-status.mixed.json
│  ├─ doctor.partial.txt        # 人类文本，仅展示（禁止结构化）
│  └─ list.legacy.json          # 缺 schemaVersion/auth
├─ api/                        # 浏览器输入：桥接 envelope（MSW 直接返回）
│  ├─ providers.healthy.json    # { schemaVersion:1, generatedAt, ok, data }
│  ├─ accounts.partial_failure.json
│  ├─ quota.stale.json
│  └─ ...
├─ sse/                        # 假流（NDJSON，见 §5）
│  ├─ logs.follow.ndjson
│  └─ actions.ndjson
└─ hostile/
   └─ hostile_text.json        # ANSI/OSC/伪 token/超长行/bidi
```

命名规则：`<资源>.<场景>.json`；场景取 `healthy|mixed|partial_failure|empty|stale|legacy|unknown_fields|slow|action_failure|hostile_text`。

### 3.2 数据安全

- 使用 `example-user`、`slot-a`、示例 UUID 与虚构端口/数值；**禁止**从本机真实 JSON 复制。
- 不提交真实 token/UID/邮箱/home 绝对路径/完整日志；伪秘密必须是显然不可用的测试串。
- 提供 fixture 扫描：CI 断言 fixtures 与文档中匹配不到真实路径与秘密模式（见 §7）。
- 快照更新必须人工审查；不把真实数据写入快照。

示例（匿名、虚构）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-01-05T04:00:00Z",
  "ok": true,
  "data": {
    "providers": [
      {
        "id": "qoder-cn",
        "title": "Qoder CN",
        "on": true,
        "up": true,
        "models": 12,
        "port": 7863,
        "pid": 4242,
        "pids": [4242],
        "control": "example-control",
        "oc": true,
        "ocUserOwned": false,
        "auth": { "ok": true, "state": "valid", "expiresAt": null, "label": "example-label" }
      }
    ]
  }
}
```

## 4. 覆盖矩阵（抽样）

FR/NFR 段按 [00 §14](00-design-baseline.md#14-文档约定) 编号。本表抽样覆盖各段，不穷举全部 FR。

| FR/NFR 段 | 主题 | 主要测试层 | 用例要点 |
|---|---|---|---|
| FR-101–109 | 总览与状态 | 契约 + 组件 + E2E | drift 推导、`null/0/未知` 四态、局部失败降级、可分享 URL |
| FR-110–119 | 服务控制 | 单元 + 组件 + E2E | 命令映射穷举（up/down/keep-oc/restart/off/sync）、`on/all/none` 危险名单与默认取消 |
| FR-120–129 | 额度 | 单元 + 契约 + 组件 | 多单位不混合、`total=null` 不算百分比、`fetchedAt` 过期、可领取/活动关闭 |
| FR-130–139 | 账号与登录 | 契约 + 组件 | dry-run 预览、正式切换、恢复整池、平台不支持、交互式动作挂起与取消 |
| FR-140–149 | 日志与诊断 | 单元 + 组件 + E2E | 脱敏/控制序列清理、跟随/暂停/截断、健康部分失败、真实试打加强确认 |
| FR-160–169 | 用量分析 | 单元 + 组件 + E2E | 24h/7d/30d/all 换算、steps 排序、空活动 stale、图表响应式、CSV 导出 |
| FR-160–169 | 报表汇总 | 单元 + 组件 + E2E | 五源状态、范围→网关天数映射（24h/7d/30d/all→1/7/30/90）、CSV/JSON、不跨口径相加 |
| FR-170–179 | 网关 | 契约 + 组件 + E2E | 调度 lane、用量双轴/Token 图、降级链阶梯、密钥仅 SHA-256 摘要、免费供应商只读、本地应答 |
| FR-180–189 | 设置/主题/a11y/i18n | 组件 + a11y | 主题切换持久化、刷新间隔、axe 零 critical、zh/en 文案 |
| FR-190–199 | 通用交互 | 组件 + E2E | 加载/空/错/慢/只读、命令面板、键盘导航、demo 与只读拦截 |
| NFR-101–110 | 非功能 | 单元 + CI | 无凭证 CI、契约升版与未知字段、有界输出、双平台、安全扫描 |

## 5. SSE 与轮询的测试手法

| 维度 | 手法 |
|---|---|
| 假流 | MSW/EventSource 喂 `frontend/fixtures/sse/*.ndjson`：逐行 push `data:` 帧，可注入 `event:` 类型与 `retry:` |
| 断线重连 | 主动 close 后断言重连与"连接中/已断开"提示；重连不重复渲染历史行 |
| 时间控制 | `vi.useFakeTimers()` 推进轮询间隔（Provider 5s、usage 60s、quota 120s）；断言不产生请求堆积、同 key 去重 |
| `document.hidden` | mock `visibilityState='hidden'` 并派发 `visibilitychange`：暂停轮询与 SSE；可见时立即补一次（00 §8） |
| 乱序/慢响应 | 让 list 慢、account 快，断言旧响应按 request key/序号丢弃，不覆盖新数据 |
| 背压与上限 | 超量帧触发有界缓冲，旧行淘汰并标记截断 |
| 清理 | 卸载组件/切 provider 时关闭 EventSource，断言无悬挂监听 |

## 6. 契约测试的迁移与文本解析禁令

- **禁止**用正则解析人类文本（`logs`、`doctor`、`health.mjs` 文本）生成结构化字段（00 §13）。
  出现 `doctor.partial.txt` 这类输入时，测试只断言"清理后原样展示为文本"，不得断言被拆成指标。
- 健康页在 `health.mjs --json` 增量落地前允许展示文本；该增量落地时，**新增结构化契约用例**并把
  文本渲染用例标记为 `legacy`，而非就地改语义。
- 结构化迁移路径：`schemaVersion` 升版 → 同步更新 Zod schema 与 fixtures → 保留旧版解析用例
  （标 `legacy`）→ 删除旧版需单独提案。新字段优先 additive；改义/删字段必须升版。
- envelope 与 CLI 同为 `schemaVersion:1`；升级断言"更高 major 报兼容性错误、同级 additive 通过"。

## 7. CI

公共 CI **不接触真实后端**：不跑 `router.mjs all/none/up/down`、不签到、不跑 `health.mjs` 真实试打、
不读 `gateway/data/`。

Node 版本矩阵：`20.x`（LTS）与 `22.x`（LTS）；本机另有 `v26` 仅用于人工验收。

```bash
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest run（单元 + 契约 + 组件 + MSW）
npm run build          # tsc --noEmit && vite build
PANEL_E2E_PORT=8892 npx playwright test --workers=1   # 对 --demo 桥接，headless
node server/index.mjs --read-only --port 8894         # 真实只读桥接（人工验收）
PANEL_E2E_REAL=1 PANEL_E2E_PORT=8894 npx playwright test e2e/real.spec.ts --workers=1
```

> `package.json` 当前没有 `lint` 脚本；ESLint 不在本仓库的验证链路内，门禁是 typecheck + test + build + Playwright。

### 7.1 本机实测结果（2026-11-25）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 error |
| 单元/契约/组件 | `npm test` | ✅ 30 passed + 1 skipped 文件；286 passed + 3 skipped 用例（共 289 用例）；0 failed |
| 生产构建 | `npm run build` | ✅ 通过 |
| E2E（demo） | `PANEL_E2E_PORT=8892 npx playwright test --workers=1` | ✅ 103 passed / 9 skipped / 0 failed（real.spec 按设计跳过） |
| E2E（真实只读） | `PANEL_E2E_REAL=1 PANEL_E2E_PORT=8894 npx playwright test e2e/real.spec.ts --workers=1` | ✅ 9 passed / 0 failed |
| axe 深色 | Playwright + axe | ✅ 15 路由页 + 命令面板 0 violation |
| axe 浅色 | Playwright + axe | ✅ 5 页抽检 0 violation |
| 响应式 | Playwright 375/768/1440 × 8 页 | ✅ 横向溢出全部为 0（阈值 ≤1） |

截图存档：`frontend/test-results/screenshots/`（24 张，`test-results/` 已 gitignore）。

补充检查：

| 检查 | 说明 |
|---|---|
| a11y | Playwright + axe，页面与关键弹层零 critical/serious；`KNOWN` 为空 |
| fixture 扫描 | fixtures 与文档匹配不到真实路径/秘密模式 |
| 匿名文档链接 | 相对链接有效，无死链 |
| 锁文件一致 | `package-lock.json` 与 `package.json` 一致 |
| 构建产物 | 内容与体积预算符合 `08-operations.md` |

## 8. 人工验收矩阵（真实后端，只读优先）

真实后端只读为先；任何写操作逐项授权、记录前后 `list --json`、事后恢复开关与账号选择（对齐 TUI §10）。

| 维度 | 变体 | 期望 |
|---|---|---|
| 平台 | Windows 10/11、Linux | 构建、渲染、子进程行为一致 |
| 桥接 | 连真实 `node router.mjs` | 只读页显示真实状态；脱敏生效 |
| 网关 | 可达 | 调度/用量/额度/免费供应商正常 |
| 网关 | 不可达 | 网关页降级为 `—` 并给"下一步"，不拖垮其它页 |
| 单家失败 | 某 provider 端点/额度/账号查询失败 | 局部失败隔离，其余项照常；显示 stale 与最后成功时间 |
| 凭证 | 缺 Node/root 错误/端口占用/凭证过期/日志不存在 | 错误分类正确、无敏感信息泄漏 |
| 交互式 | `login`/`account add` | 显示"等待外部登录完成"、可取消、终端归用户 |
| 只读 | `--read-only`/演示模式 | 桥接层拦截写请求（403），非前端隐藏 |

> 无法在所有 CI 环境稳定自动化的部分必须进入本矩阵，不得直接标记"已测试"。

## 9. 完成定义与回归清单

一个功能只有满足以下条件才算完成：

- 正常、空、错误、慢（stale）与只读路径均已考虑；
- 有自动化测试，或有明确原因的人工测试记录；
- Windows/Linux 不因平台专属假设失败；
- 无真实凭证的 CI 可重复通过（NFR-108）；
- 契约可解析、可升版、容忍未知字段（NFR-109）；
- 文档、帮助、命令与实际行为一致；
- 没有通过降低安全断言来换取测试通过。

提交前回归清单：

| # | 检查项 | 通过标准 |
|---|---|---|
| R1 | `npm run typecheck` | 0 错误（本仓库未配置 lint 脚本） |
| R2 | `npm test` | 单元/契约/组件/MSW 全绿；新增或更新的 fixture 已审查 |
| R3 | 契约升版 | 新字段 additive 或已升 `schemaVersion` 并同步 schema/fixtures/用例 |
| R4 | 组件五态 | 每 feature 覆盖加载/空/错误/stale/只读 |
| R5 | 确认与只读 | 默认焦点取消、危险名单可见、桥接层拦截 403 可断言 |
| R6 | 脱敏与清理 | 新增日志/输出路径有脱敏与控制序列清理用例 |
| R7 | 文本解析禁令 | 无正则把人类文本转为结构化字段 |
| R8 | `PANEL_E2E_PORT=<free> npx playwright test --workers=1` + axe | demo E2E 全绿、a11y 零 violation，375/768/1440 无横向溢出 |
| R8b | `PANEL_E2E_REAL=1 PANEL_E2E_PORT=8894 npx playwright test e2e/real.spec.ts --workers=1` | 本机真实只读验收 9 项全绿；不作为公共 CI 门禁 |
| R9 | fixture 安全 | 匿名扫描通过，无真实 token/UID/邮箱/路径 |
| R10 | 需求追踪 | FR/NFR 段有对应测试映射，改需求必改测试 |

任何需求变更都必须同步增加或修改测试映射，不能只改验收文案。
