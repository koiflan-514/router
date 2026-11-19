# 网关调优

这份讲「怎么配」，[11-gateway.md](11-gateway.md) 讲「怎么运维」。

## 降级链怎么配

先想清楚你在解决哪一类问题，三种写法各有分工：

| 你的问题 | 用什么 |
|---|---|
| 同一个模型，想让它自动选最闲/最有钱的那家 | 裸模型名 `glm-5.3-flash` |
| 我明确要用某一家，别给我换 | 显式前缀 `trae-local/glm-5.3-flash` |
| 我要一条**自己定顺序**的链，可能跨模型 | `combo:名字` |

### 典型链：质量阶梯

```bash
node router.mjs gateway combo add --name smart --models 'codearts/deepseek-v4.1-flash,trae-local/glm-5.3-flash,loomy/GLM-5.3-Flash'
```

永远从链头开始。适合「先试最好的，不行再降级」。

### 典型链：等价模型分摊

```bash
node router.mjs gateway combo add --name spread \
  --models 'trae-local/glm-5.3-flash,codearts/glm-5.3-flash,zcode/glm-5.3-flash' \
  --strategy round-robin --sticky 2
```

每 2 个回合换一次起点，负载摊到三家。

### 配链时的三个坑

**1. 链上每环可以是不同模型，但客户端只认一个名字。**
`combo:fast` 的第一环是 `zcode/glm-5.3`、第二环是 `codearts/deepseek-v4.1-flash` 时，
网关会真的把上游模型名换掉。但客户端看到的 `model` 字段是**第一环**的名字——
如果你依赖响应里的 `model` 做统计，会有一点偏差。这是刻意的：改 `model` 字段会让
某些客户端把它当成不同的模型重新计费。

**2. 容量取交集，所以链越长能力越窄。**
链头支持视觉、链尾不支持，整条链就**不**声明支持视觉。这是诚实的做法：声明了却
在降级那环收到读不懂的图，比一开始就说不支持糟得多。

**3. 全链不可用时是 503 而不是静默消失。**
`combo:fast` 的每一环都拿不到模型目录时，请求返回
`503 降级链 "fast" 上没有任何可用环节（不可用：...）`，而 `/v1/models` 里那条链
仍然在（标注了不可用）。**不要**因为看不到就以为配置丢了。

## 本地应答什么时候该关

五项默认全开。绝大多数情况**不用关**，但三种场景要留意：

| 场景 | 建议 |
|---|---|
| 你在调试「为什么模型没被调用」 | `gateway local off title` 之类逐项关，排除干扰 |
| 你的客户端把 `Conversation` 当成真实回答 | 关 `title`——说明它没按 Claude Code 的协议发标题请求 |
| 你换了非 Claude Code 的客户端 | 全关 `gateway local off`，这些检测器是针对 Claude Code 的提示格式写的 |

判断依据：响应头 `x-router-local-answer` 会写明是哪一项答的。看到不该出现的值就是
该关的信号。

一个容易误解的点：**本地应答仍然走认证**。它只是跳过上游，不是跳过鉴权。

## 失败分类怎么读

`gateway status` 的 `cooldownKind` 字段用的是调度器的桶名（`auth`/`quota`/
`rate_limit`/`server`/`client`），而日志与错误文案用的是更细的 failure kind。
两者的对应关系在 `server.mjs` 的 `kindOfVerdict`。

排查时最有用的三个信号：

```bash
# 1. 哪家在冷却、为什么
node router.mjs gateway status

# 2. 这次请求换了几家、上游给的是什么形状
curl -s -D- -o/dev/null -X POST http://127.0.0.1:8785/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}' \
  | grep x-router

# 3. 最近几天哪家在出错
node router.mjs gateway usage --days 7
```

### 几个容易误判的情况

| 你看到的 | 实际原因 |
|---|---|
| 400 但提示「额度不足」 | 上游把额度错误放在 400 的 body 里；分类器按文本判成 billing，会换家 |
| 429 说「约 120 秒后恢复」 | 该家限流冷却中。等，或看 `gateway status` 确认是哪家 |
| 502 且 `x-router-shape: unknown` | 上游返回了既不是 JSON 也不是 SSE 的内容（常见于反代自己的错误页） |
| 明明有额度却被判成 billing | 上游文案里含「额度」二字但不是真的耗尽。看 `cooldownKind` 与日志里的原始 body |

## 调权重

```json
{ "weights": { "qoder": 20, "workbuddy": 0, "trae-local": 5 } }
```

- `0` = **硬关掉**，不参与调度（比 `on/off` 更细：进程还在，只是不选它）；
- 不写 = 10（默认）；
- 上限 20。

权重是乘在「额度比例 + 闲置加成 + 成功率」之上的，所以把一家设成 20 不会让它
吃掉全部流量——额度耗尽的供应商仍然会掉下去。

想让权重反映真实余额，跑 `gateway refresh-quota`（30 分钟内的快照才参与计算）。

## 与 `on/off` 的关系

两套开关管的是不同的东西，别混：

| 开关 | 管什么 | 影响 |
|---|---|---|
| `router.mjs on/off` | 进程起不起 | 网关连不上这家 → 模型目录里没有它 |
| `config.weights` | 选不选它 | 进程在跑，但调度不选 |

一个常见组合：`node router.mjs all`（九家全起）+ `weights: {"workbuddy": 0}`
（但别选 WorkBuddy）。这样随时能切回来，不用等进程冷启动。

## 加新一家供应商时

三处都要改，`gateway doctor` 会指出漏了哪边：

1. `router.mjs` 的 `PROVIDERS` —— spawn 命令、日志、端口
2. `gateway/providers.mjs` 的 `DESCRIPTORS` —— 端口、方言、key
3. `scripts/health.mjs` 的 `SOURCES` —— 体检

方言选错的表现：`/v1/messages` 返回 404 而不是 400，因为网关以为它原生支持
Anthropic，直接打 `/v1/messages` 打空了。

**如果新供应商是云端的（不需要本机进程）**，不要动上面三处，改用
`gateway/free-providers.mjs`：加一条记录即可，网关会把它当作上游。
两者不要混：`PROVIDERS` 是「spawn 什么」，`free-providers.mjs` 是「往哪发请求」。

## 免费供应商的排查

| 现象 | 真因 | 修法 |
|---|---|---|
| `providers list` 显示「待配置」 | 没 key，或 baseUrl 有 `{占位符}` | `providers key <id> <key>`；Cloudflare 要 `--base-url` |
| `providers test` 通过但调用 401 | `/models` 不校验 key，测试只证明地址通 | `providers test <id> --deep` 花一次额度真验 |
| 调用 404「没有模型 X」 | 模型列表来自官方地址，而你覆盖了 baseUrl | 覆盖 baseUrl 时会自动改拉 `<baseUrl>/models`；手动 `gateway models` 刷新 |
| 刚配好 key 仍报「所有供应商不可用」 | 网关启动时该家还不可用 | 已修：调度器会动态 `ensure`，重启也行 |
| 429 且提示「约 N 秒后恢复」 | 该家在冷却 | `gateway status` 看是哪家、什么 kind |

一个容易忽略的点：**本机三家「可用」不等于装了就绪**。`providers list` 会补一次
轻量探测，没在跑的显示「待配置」而不是「可用」——否则模型列表里会出现一堆
点了就报错的条目。
