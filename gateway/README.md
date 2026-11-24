# 统一网关

> **适合**：已跑通至少两家反代，想用一个端口接入 opencode / pi / Claude Code。  
> **前置**：理解 provider id 与 `<供应商>/<模型>` 的写法。  
> **相关**：[文档索引](../docs/README.md) · [网关运维](../docs/11-gateway.md) · [网关调优](../docs/12-gateway-tuning.md)

把十三家反代拼成**一个端口、两种协议**，并补上 router 原本缺的三件事：统一入口、
密钥与用量、跨供应商故障转移。

```
Claude Code / opencode / pi / curl
              │
              │  http://127.0.0.1:8785  （一个 baseURL 就够了）
              ▼
┌──────────────────────────────────────────────┐
│              router 统一网关                  │
│                                              │
│  /v1/messages      ← Anthropic 方言           │
│  /v1/chat/completions ← OpenAI 方言           │
│              │                               │
│   鉴权 → 路由 → 调度 → 换家 → 协议转换         │
│              │                               │
│  ┌───────┬───┴───┬────────┬─────────┐        │
│  ▼       ▼       ▼        ▼         ▼        │
│ qoder  trae   codearts  zcode  workbuddy …   │
└──────────────────────────────────────────────┘
```

## 为什么要有这一层

router 原本管的是「进程」：起停十三家反代、切账号、看日志。但客户端那边仍然要**逐个**
配 provider（十三份 baseURL、十三份模型清单），而且一旦某家挂了，客户端只会报错，不会换家。

网关补上的正是这一层：

| 原来 | 现在 |
|---|---|
| 客户端要配 13 个 provider | 配 1 个 `http://127.0.0.1:8785/v1` |
| 换供应商要改客户端配置 | 模型名写 `<供应商>/<模型>`，或直接写裸模型名自动找 |
| 某家挂了 → 客户端报错 | 自动换下一家，客户端只看到 200 |
| 没有统一密钥/配额 | `zsk_` 密钥、供应商/模型/IP 白名单、token 配额 |
| 不知道用了多少 | 按天 JSONL + `gateway usage` 聚合 |
| 只看得到「进程在不在」 | 权重、冷却、成功率、粘性会话、并发 |

它**不替代**任何一家反代，只是在前面加了一层。十三家的进程、账号、登录仍然由
`router.mjs` 管。

## 快速开始

```bash
# 1. 起网关（它依赖的十三家可以按需起，网关自己不做登录）
node router.mjs gateway up

# 2. 探活
curl http://127.0.0.1:8785/health
curl http://127.0.0.1:8785/v1/models      # 十三家的并集，模型名带供应商前缀

# 3. 直接用（回环默认免密钥）
curl -X POST http://127.0.0.1:8785/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"trae-local/glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}'
```

接客户端：

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://127.0.0.1:8785
export ANTHROPIC_MODEL=codearts/deepseek-v4.1-flash

# OpenAI SDK
Base URL: http://127.0.0.1:8785/v1
Model:    trae-local/glm-5.3-flash

# opencode / pi：把网关写成一份 provider（模型名自带前缀）
node router.mjs gateway install
```

pi 那边不用改 `api`：网关同时支持 OpenAI 与 Anthropic 方言，写进 `models.json` 的是
`openai-completions` + 一个 baseURL，模型选 `trae-local/glm-5.3-flash` 或 combo 名。
免费供应商另有一条直连路：`node router.mjs providers install` 会同时写 opencode 与 pi。

## 模型名的三种写法

| 写法 | 行为 | 适用 |
|---|---|---|
| `trae-local/glm-5.3-flash` | **只用**这家；失败才按 `fallbacks` 换 | 明确知道要用哪家 |
| `glm-5.3-flash` | 在所有能提供它的可用上游里**按权重**挑 | 想让网关自己决定 |
| `combo:fast`（或 `fast`） | 一条**用户命名**的有序链，可跨供应商跨模型 | 想自己定降级顺序 |

「可用上游」包含两类，对客户端没有区别：

| 类别 | 数量 | 谁在跑 | 要 key |
|---|---|---|---|
| 本机反代 | 8 | router spawn，有 PID/日志 | 否（占位值） |
| 免费供应商（云端） | 15 | 别人家的 HTTP 端点 | 是（有免费额度） |
| 免费供应商（本机） | 3 | 你自己装的 Ollama / LM Studio / llama.cpp | 否 |

裸模型名是这次升级的重点：客户端只认模型名，让人为了「换个供应商」去改配置很别扭。
找不到时返回 404 并**列出当前目录**，而不是让上游回一个含糊的 400。

显式前缀默认**不**扩散到其它供应商——写死 `trae-local` 就是 `trae-local`。
想让它也参与转移，配 `fallbacks`，或打开 `explicitFailover`。

## 免费供应商

18 家**有免费额度**的供应商，来自 dsh-our-free-model 的注册表（那 76 家里只留了这些——
其余 61 家是纯付费直连，填 key 只是换一种计费方式）。

```bash
node router.mjs providers list            # 18 家与可用状态
node router.mjs providers show openrouter # 看一家的详情
node router.mjs providers key openrouter sk-or-v1-...
node router.mjs providers test openrouter # 探活
node router.mjs providers install         # 写成独立的 opencode + pi provider
```

三家**完全不用钱**（本机推理，不需要 key）：

| id | 默认地址 | 说明 |
|---|---|---|
| `ollama` | `127.0.0.1:11434` | 装了什么模型就有什么 |
| `lmstudio` | `127.0.0.1:1234` | 要在 LM Studio 里先开本地服务器 |
| `llamacpp` | `127.0.0.1:8080` | `llama-server` 默认端口 |

十五家**有免费额度但要 key**：

| id | 免费额度 | 有 `/models` |
|---|---|---|
| `openrouter` | 约 27 个免费模型，约 200 请求/天 | ✓ |
| `opencode-zen` | 一批 `-free` 模型 | ✓ |
| `gemini` | AI Studio 免费额度 | ✗（静态表） |
| `nvidia-nim` | 开发者计划免费 | ✓ |
| `kilo` | 免费池（`kilo-auto/free` 等） | ✓ |
| `bazaarlink` | `auto:free` 档 | ✓ |
| `ollama-cloud` | 轻度使用 | ✓ |
| `cloudflare` | Workers AI 免费配额 | ✗（需替换 `{account_id}`） |
| `byteplus` | 新账号免费额度 | ✗ |
| `kimchi` | 注册即发凭据 | ✗ |
| `tokenrouter` / `nararoute` / `orcarouter` / `zenmux` / `xkiro` | 各有 `-free` 模型 | 部分 |

### key 存哪里

**不写进 `config.json`**，单独放 `gateway/data/providers.json`，AES-256-GCM 加密，
密钥在 `data/.vault-key`（0600）。取 key 的顺序：

1. `ROUTER_PROVIDER_KEY_<ID>` 环境变量（不落盘，适合临时用）
2. 加密存储
3. 明文存储（加密不可用时的退化，会明确警告）

**要说清楚这个取舍**：`.vault-key` 和密文在同一个目录里，所以这**不是防入侵**——
目的是防止「把 data 目录误提交/误打包/误发群」时 key 直接可读。真正的隔离靠
`.gitignore` 与文件权限。

### 探活的局限

`providers test` 只验证**地址通、网络通**，**不验证 key**——因为多数上游的 `/models`
根本不需要鉴权。dsh 的文档把这叫「列表探测」并明确写了这个边界。

真想验 key 只能花一次最小生成：

```bash
node router.mjs providers test openrouter --deep   # 会消耗一次极小的额度
```

### baseUrl 覆盖

覆盖 baseUrl 通常是为了走镜像或自建代理。这时**模型列表端点也必须跟着走**——
继续拉官方 `/models` 会得到一份「看起来能选、实际调不通」的清单（官方有什么
≠ 这个端点有什么）。这条已经写成回归测试。

```bash
node router.mjs providers key cloudflare <token> --base-url https://你的代理/v1
```

Cloudflare 的官方地址里含 `{account_id}`，不替换就发请求只会得到一个 404。
`providers list` 会把它标成「待配置」而不是「可用」。

## 降级链（combo）

裸模型名解决的是「同一个模型在哪家跑」，combo 解决的是「**我自己定一条链**」：

```bash
node router.mjs gateway combo add --name fast \
  --models 'trae-local/glm-5.3-flash,codearts/deepseek-v4.1-flash,zcode/glm-5.3'
node router.mjs gateway combo list
```

调用时 `model` 写 `combo:fast`（或直接 `fast`），链上每一环按顺序试，第一个产出
输出的赢。

规则（移植自 dsh-our-free-model，每条都对应一个真实故障）：

| 规则 | 为什么 |
|---|---|
| 任何**正文增量之前**的失败，整段丢弃换下一环 | 调用方不该看见「试了两家」 |
| **思考增量不算正文** | 「想了一分钟然后撞上配额墙」正是最该降级的场景 |
| 一旦已有正文增量交付，之后的失败正常结束 | 重放会让用户看到重复输出 |
| 容量取**交集**而非并集 | 链头支持视觉不代表降级那一环也支持 |
| 全部环节不可用的链**保留并标注** | 静默消失会让人以为配置丢了 |

两种策略：`fallback`（永远从链头开始，适合质量阶梯）与 `round-robin`
（按 `stickyLimit` 轮换起点，适合等价模型分摊负载）。

链上每环可以是**不同模型**：`zcode/glm-5.3 → codearts/deepseek-v4.1-flash` 会真的
把上游模型名换掉，而不是拿第一环的名字去问第二家。

## 本地应答（省额度）

Claude Code 每一轮都会发一批**答案已经写在请求体里**的固定问题。转发到上游等于用
订阅额度换一个只有一个正确答案的问题，还多花一次往返。网关在进程内直接答：

| 优化 | 触发条件 | 答案 |
|---|---|---|
| `quota` | `max_tokens:1` + 内容含 "quota" | `Quota check passed.` |
| `prefix` | `<policy_spec>` + `Command:` | 命令前缀（`git commit`） |
| `title` | system 里要标题，且不带工具 | `Conversation` |
| `suggestion` | 任何 user 消息含 `[SUGGESTION MODE:` | 空字符串 |
| `filepath` | `Command:`/`Output:` 在问路径，且不带工具 | `<filepaths>…</filepaths>` |

五个全部默认开启，各自可关：

```bash
node router.mjs gateway local              # 看状态
node router.mjs gateway local off title    # 关掉某一项
node router.mjs gateway local off          # 全关
```

响应头 `x-router-local-answer: quota` 标明这次是本地答的，排查时一眼能看出来。

三条纪律：
- 只读请求、不改请求，**不匹配就 `null`**，绝不猜；
- 认证仍然要做——本地问题不能变成免密钥的口子；
- 命令替换（反引号 / `$(`）如实报 `command_injection_detected`，不执行也不解析。

## 协议转换

| 上游能力 | `/v1/messages` | `/v1/chat/completions` |
|---|---|---|
| `both`（CodeArts、ZCode） | 原生直通 | 原生直通 |
| `openai`（Qoder、Trae、WorkBuddy、Loomy、有道龙虾） | **转换** | 原生直通 |

三条取舍，都是「宁可报错也不静默丢东西」：

- **图片**：Anthropic 的 base64/URL 图片映射成 OpenAI 的 `image_url`，不丢；
- **thinking**：OpenAI 的 `reasoning_content` 默认**不**转成 Anthropic thinking 块——
  Anthropic 要求 signature，伪造会被客户端拒。要看就打开 `exposeReasoning`；
- **未知内容块**：直接 400 说清是哪一块，而不是丢掉后让模型答非所问。

### 判断响应形状看体，不看头

这是从 dsh-our-free-model 移植的第二处真 bug 修复。它的车道会在高负载下以
`200 + application/json` 返回完整 SSE 帧序列，按 Content-Type 判断就会把整条流读成
字符串、`JSON.parse` 失败、整轮报废——而那个错误对象还带着 status 200，会让可用性
探测把可用模型判成不可路由。

本项目在 Trae 上撞到的是同一个坑的另一种表现：无论 `stream:false` 都回 SSE。
所以现在一律**先嗅探首块（≤4KB）**再决定怎么读：

```
客户端要流 + 上游 SSE + 方言一致 → 逐帧 pipe，真流
客户端要流 + 上游 SSE + 需转换   → 边读边转，仍是真流
客户端要流 + 上游 JSON           → 合成为一份合法 SSE（否则客户端会挂住）
客户端不要流                     → 读完聚合，渲染成单个 JSON
```

响应头 `x-router-upstream-shape` 会告诉你上游实际给的是 `sse` 还是 `json`。

### 工具调用配对修复

这是第三处移植过来的真 bug 修复，原项目的注释记着它的后果：

> 一次被中断的工具调用会永久污染该会话。缺少对应结果的工具调用在重放时，上游返回
> `400 invalid_request_error`，此后该会话中的每一次请求都会失败。

场景很常见：用户按 Esc、工具启动失败、客户端崩溃。于是历史里留下「有 `tool_use`
没有 `tool_result`」的助手轮次，**下一次**请求带着它发出去就 400，而且因为历史不变，
之后每一轮都 400。

网关在**唯一收口**上修一次，两种方言共用同一份逻辑（发生在协议转换之前）。三条规则：

- 没有结果的调用丢掉（连同参数）；
- 没有调用的结果也丢掉（空的 `tool_call_id` 在线上是整轮 400）；
- **没有名字的调用丢掉**——它不可执行，而且一旦被宿主答成 `Error: unknown tool ""`
  就变成「已配对」，靠配对检查永远清不掉。

## 调度

```text
weight = (quotaFactor + idleBonus + successFactor) × manualWeight
  quotaFactor   = 额度比例 × 10         （无快照 → 取同批已知均值，不惩罚）
  idleBonus     = min(闲置小时 × 0.5, 5) （从未用过按 999 小时）
  successFactor = 最近 50 次成功率 × 3
  manualWeight  = config.weights[id]，默认 10；0 = 硬过滤
```

这套公式与 OpenResolver 的 `pools/base.mjs` 一致，便于两个项目之间对照排查。

调度单位是**供应商**而不是账号：router 管的十三家里，换账号要改文件再重启进程
（见 [05-operations.md](../docs/05-operations.md)），在一个 HTTP 请求里做账号级切换不现实。
账号健康通过 `router account check` 暴露，额度通过 `gateway refresh-quota` 写进快照、
间接参与权重。

失败分类决定冷却时长与是否换家。这套词汇移植自 dsh-our-free-model 的
`src/route/classify.js`，比「只看状态码」多识别三类情况：

| 类别 | 触发 | 冷却 | 换家 |
|---|---|---|---|
| `auth` | 401/403、"no credentials"、"凭证失效" | 2 分钟 | ✓ |
| `permission` | 403、"request not allowed" | 5 秒 | ✓ |
| `billing` | 402、"额度不足"、"余额不足"、"积分不足" | 2 分钟 | ✓ |
| `rate_limit` | 429、"rate limit"、"已达上限"、"并发会话数" | 2 秒起，翻倍 | ✓ |
| `overloaded` | 502/503/504/529、"capacity"、"overloaded" | 30 秒 | ✓ |
| `context_window` | "context_length_exceeded"、"maximum context length" | **不冷却** | **✗** |
| `invalid_request` | 其余 4xx | **不冷却** | **✗** |
| `upstream` / `timeout` | 5xx、网络错误、408 | 30 秒 | ✓ |

三条关键判断：

1. **body 措辞优先于状态码。** 一个 body 里写着 "rate limit" 的 400 就是限流，
   一个写着 "no credentials" 的 429 就是凭据失效。这修掉了我原来的实现的一个真 bug：
   ZCode 把「额度用尽」放在 HTTP 200/400 的 body 里，只看状态码会判成 client error
   （不换家、不冷却），于是同一家被反复打到。
2. **上下文溢出单独成类，不换家。** 重放同样的字节永远救不了，只能缩小请求或换更大
   的模型。把它归进 `invalid_request` 会让网关白试三家。
3. **未匹配的 4xx 不冷却。** 一个由请求本身造成的 400 说明不了凭据有问题，冷却它会
   把健康连接摘出轮转，还会把真正的原因藏起来。

限流走指数退避：`2000 × 2^(level-1)`，上限 5 分钟，等级上限 15。上游自己报的
reset 时长只在**冷却方向**生效（可以拉长、不会缩短），并封顶 30 分钟——有的上游报
几小时，照做等于把这家清出轮转。

连续失败到 `breakerThreshold` 开始指数退避，上限 `breakerCapMs`。
**冷却只增不减**：短冷却不能抹掉还在生效的长冷却。

## 密钥

```bash
node router.mjs gateway key add --name dev --providers trae-local,zcode --days 30
node router.mjs gateway key add --name ci --models 'glm-*' --quota 2000000
node router.mjs gateway key list
node router.mjs gateway key rm <前缀>
node router.mjs gateway key disable <前缀>
```

明文**只显示一次**，库里只有 SHA-256。白名单为空 = 不限制。

与 OpenResolver 有一处刻意不同：**密钥库热加载**。OpenResolver 新建密钥后要重启网关，
这在 CLI 场景下很容易误判成「密钥没生成」；这里按 mtime 检测，`key add` 之后立刻就能用。

回环地址默认免密钥，而且**带了无效密钥也不拦**——opencode / pi 会强制带一个占位
`apiKey`（`router-local`），如果只放行「完全不带密钥」，这些客户端反而全部 401。
要收紧就设 `strict: true`（或 `ROUTER_GATEWAY_STRICT=1`），非回环来源永远需要有效密钥。

## 配置

`gateway/data/config.json`（可选，不写就用默认值）：

```json
{
  "strict": false,
  "upstreamTimeoutMs": 600000,
  "maxBodyBytes": 8388608,
  "exposeReasoning": false,
  "explicitFailover": false,
  "aliases": { "fast": "trae-local/glm-5.3-flash" },
  "fallbacks": { "trae-local": ["codearts", "loomy"] },
  "weights": { "qoder": 20, "workbuddy": 0 },
  "settings": { "maxAttempts": 3, "topN": 2, "maxInFlight": 4 },
  "localAnswers": { "title": false },
  "combos": [
    { "name": "fast", "models": ["trae-local/glm-5.3-flash", "codearts/deepseek-v4.1-flash"], "strategy": "fallback" }
  ]
}
```

| 键 | 作用 |
|---|---|
| `strict` | 回环也要求有效密钥 |
| `aliases` | 模型别名 |
| `fallbacks` | 显式前缀失败后的备份顺序 |
| `explicitFailover` | 让显式前缀也参与跨供应商转移 |
| `weights` | 供应商权重，0 = 硬关掉 |
| `settings` | 调度参数（见 `config.mjs` 的 `DEFAULT_SETTINGS`） |
| `localAnswers` | 本地应答开关；`false` 关单项，整体 `false` 全关 |
| `combos` | 降级链（也可用 `gateway combo add` 管理） |

环境变量：`ROUTER_GATEWAY_PORT`（默认 8785）、`ROUTER_GATEWAY_HOST`（默认 127.0.0.1）、
`ROUTER_GATEWAY_DATA`、`ROUTER_GATEWAY_STRICT`、`ROUTER_GATEWAY_TIMEOUT_MS`。

## 观测

```bash
node router.mjs gateway status     # 权重/额度比/并发/成功率/冷却/粘性
node router.mjs gateway usage      # 最近 7 天按天聚合（网关没跑也能读）
node router.mjs gateway balance    # 各家额度汇总（本机 13 家）
node router.mjs gateway combo      # 降级链列表
node router.mjs gateway local      # 本地应答开关
node router.mjs gateway doctor     # 自检 + 端口交叉校验
node router.mjs providers list     # 18 家免费供应商与可用状态
```

HTTP 侧：

| 端点 | 说明 |
|---|---|
| `GET /health` | 探活，无需密钥 |
| `GET /v1/gateway/status` | 调度快照 |
| `GET /v1/gateway/usage?days=7` | 用量聚合 |
| `GET /v1/gateway/balance` | 各家额度 |
| `POST /v1/gateway/models/refresh` | 清空模型缓存 |

每个响应都带三个头，排查时很有用：

```
x-router-provider: trae-local      # 最终服务的是哪家
x-router-attempts: 3               # 换了几次
x-router-upstream-dialect: openai  # 上游用的是哪种方言（是否转换过）
x-router-upstream-shape: sse       # 上游实际给的是 sse 还是 json
x-router-local-answer: quota       # 仅本地应答时出现，标明是哪一项
```

## 数据目录

```
gateway/data/
├── keys.json          # 网关密钥（别人访问本网关），只有 SHA-256
├── providers.json     # 免费供应商的 key（本网关访问上游），加密
├── .vault-key         # providers.json 的加密密钥（0600，与密文同目录）
├── config.json        # 上面的配置（可选）
├── quota.json         # 额度快照，gateway refresh-quota 写
└── usage/2026-11-11.jsonl   # 按天分片的用量
```

已被 `.gitignore` 的 `/gateway/data/` 排除。

> `keys.json` 与 `providers.json` 是**两个方向**的凭据，不要混淆：
> 前者是「谁可以调用本网关」（只存哈希，不可逆），后者是「本网关怎么调用上游」
> （必须可读回明文，所以加密）。前者泄露等于别人能用你的额度，后者泄露等于
> 你的上游 key 被拿走。

## 自测

```bash
node gateway/selftest.mjs     # 66 项：协议转换、SSE 分块、调度器、失败分类、工具配对、本地应答、combo、免费供应商
```

不依赖任何反代在跑，也不消耗额度。用 `node:assert` 而不是测试框架——本仓库没有
devDependencies，加框架会让「clone 下来就能跑」失效。

## 与 dsh-our-free-model 的对应关系

第二、三轮的增强来自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
（MIT）。下面六块是真正移植过来的：

| 能力 | dsh-our-free-model | 本项目 |
|---|---|---|
| 失败词汇与冷却策略 | `src/route/classify.js` | `gateway/failure.mjs` |
| 工具调用配对修复 | `src/messages.js` | `gateway/pairing.mjs` |
| 按响应体形状嗅探 | `src/http.js` | `gateway/sse.mjs` |
| 本地应答（省额度） | `src/local-optimize.js` | `gateway/local-answer.mjs` |
| 降级链 | `src/combos.js` | `gateway/combo.mjs` |
| 供应商注册表 | `src/providers/registry.json`（76 家） | `gateway/free-providers.mjs`（**18 家，只留免费的**） |

刻意没移植的三块：

- **工具输出压缩（RTK，1700 行）**：收益大但风险也大——它要在请求发出前就地重写
  `tool_result` 内容，十三个过滤器各有边界条件。它的安全规则（报错的不碰、小于 500
  字节不碰、替换结果永不大于原文、失败开放）是对的，但把 1700 行搬进来会让这个
  「clone 下来就能跑」的零依赖项目变成一个需要长期维护的子系统。**如果哪天要做，
  应该单独成模块并带独立的回归语料**，而不是塞进网关。
- **纯付费的 61 家供应商**：填 key 只是换一种计费方式，不符合「把订阅额度榨干」的定位。
- **网页面板**：已有 Rust TUI，重复建设。

两处刻意不同：

1. dsh 的 combo 是插件内的虚拟模型行，本项目还额外让它参与
   `x-router-provider` / `x-router-attempts` 头，于是**降级过程可观测**——
   dsh 的设计目标是「用户完全看不见」，而本项目的定位是运维工具，看不见反而不好排查。
2. dsh 把 76 家全列出来（含不可驱动的 OAuth/ADC），本项目**只列真的能用的**：
   有免费额度、baseUrl 可解析、不需要交互式登录。列出点了报错的条目不如不列。

## 端口交叉校验

网关的 `providers.mjs` 和 router 的 `PROVIDERS` 各有一份端口表。两边漂移的症状是
「请求打到旧端口 → 502」，极难查，所以 `gateway doctor` 会逐条比对：

```
端口交叉校验（router PROVIDERS ↔ gateway DESCRIPTORS）
✓ 13 家端口一致
```

新增一家时，两处都要改——`doctor` 会告诉你漏了哪边。

---

← 返回 [文档索引](../docs/README.md) ｜ [网关运维](../docs/11-gateway.md) ｜ [网关调优](../docs/12-gateway-tuning.md)
