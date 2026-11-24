# 本机限流：别让上游把你当套流

## 为什么要有这一层

这些反代的上游**按「像不像人在用」判流量**，而不是按你的额度多少。真实约束往往比
想象的低得多：

| 供应商 | 上游约束 | 依据 |
|---|---|---|
| Qoder 国内/国际 | 免费账号按并发排队 | `10605 isQueued`（[02-pitfalls](02-pitfalls.md) P16） |
| ZCode | 计划通道**串行**计量 | `ZCODE_LANE_WIDTH=1`，并发 2 就吃 `3009` |
| CodeArts | **每账号 3 个并发会话** | `TM.00001041`（[08-codearts](08-codearts.md)） |
| Trae | `soft_rate` 冷却 60 秒 | `config.example.json` 的 `cooldown` |
| WorkBuddy | 浏览器会话，多路并发像异常 | 实测：同账号并发 4 路开始排队 |
| Loomy / 小浣熊 | 订阅积分，无公开并发数 | 按「一个人开几个标签页」估 |
| 千问办公 | 云端 MaaS 按会话计量 | 代理 `QWENWORK_LIMITS=off` 可临时关掉 |
| 百度搭子 | 订阅积分，桌面端与反代共用一份额度 | 代理 `DUMATE_LIMITS=off` 可临时关掉 |
| WPS 灵犀 | 订阅智点，桌面端与反代共用一份额度 | 反代内部 RPC 串行；并发 2 与「开两个窗口」相当 |

问题在于客户端：opencode / Claude Code 会并行跑工具、开子代理；CI 里并发跑用例；
一次重试风暴能在 2 秒内打出十几路。上游看到的是**同一个账号的十几路并发**——
这不是「一个人在用」，是「有人在套流」。

**所以限流必须做在本地、做在请求出去之前。** 等上游 429 再退避已经晚了一步：
那次可疑请求已经发出去了，而且冷却期内整家不可用。

## 四个维度

只做并发不够。四个闸门一起判断，缺一个都挡不住：

| 维度 | 挡什么 | 为什么需要 |
|---|---|---|
| `concurrency` | 同时在飞的请求数 | 最容易被判定为套流的那一项 |
| `rpm` | 最近 60 秒的请求数（滑动窗口） | 挡「慢速但持续」的刷量 |
| `minIntervalMs` | 相邻两次请求的最小间隔（令牌桶） | 挡「一瞬间连发 10 个」 |
| `burst` | 令牌桶容量 | 允许短促并发，不是一律串行 |
| `dailyCap` | 每日请求上限（0 = 不限） | 挡「挂机刷量」 |

实现见 `integrations/limits/limiter.js`（零依赖，纯内存）。

## 四档预设

数值是「一个人正常用」的量级，**不是上游的硬上限**：

| 档位 | 并发 | rpm | 最小间隔 | 突发 | 适合 |
|---|---|---|---|---|---|
| `safe` | 1 | 20 | 3000ms | 1 | 上游按串行计量 / 免费账号 |
| `balanced` | 2 | 40 | 1500ms | 2 | 一般订阅 |
| `fast` | 4 | 90 | 700ms | 4 | 已确认宽松的上游 |
| `max` | 64 | 600 | 0ms | 64 | 明确要最宽；配合 `overrideHardCaps` 才突破硬约束 |

> **rpm 为什么给到 20/40 而不是更低**：agent 循环里每一步只隔几百毫秒（模型回完
> 就发下一个工具调用），一轮复杂任务 30~50 步很常见。把 rpm 压到 12 会把**正常
> 使用**误伤成 429。真正的套流特征是**并发**与**无间隔连发**，所以那两项收紧，
> rpm 放宽到能容纳一次完整任务。

### 最宽配置

本仓库当前的 `limits.json` 就是最宽配置：全局 `tier: "max"`、每家 `tier: "max"`，
并显式写 `"overrideHardCaps": true`。生效值是 64 路并发 / 600 rpm / 无最小间隔 /
突发 64，且不再按下面的 `HARD_CAPS` 封顶。

代价是上游重新变成唯一的风控方：Qoder 的 `10605 isQueued`、ZCode 的 `3009`、
CodeArts 的 `TM.00001041` 都会比默认档更容易出现。自用且额度充足时没问题；
要恢复保守值，把 `overrideHardCaps` 改成 `false`，再把 `tier` 调回 `fast` / `balanced`。

## 硬约束默认不可覆盖

`HARD_CAPS` 里的值在**所有档位之后**生效，普通配置压不过；只有 `limits.json`
显式写 `"overrideHardCaps": true` 才会跳过这一步（即上面的「最宽配置」）：

```js
const HARD_CAPS = {
  'qoder-cn': { concurrency: 1 },
  qoder: { concurrency: 1 },
  'trae-local': { concurrency: 2 },
  codearts: { concurrency: 3 },
  zcode: { concurrency: 1 },
  workbuddy: { concurrency: 2 },
  'workbuddy-global': { concurrency: 2 },
  loomy: { concurrency: 2 },
  raccoon: { concurrency: 2 },
  qwenwork: { concurrency: 2 },
  dumate: { concurrency: 2 },
  // WPS 灵犀：订阅智点，反代内部 RPC 串行，并发 2 与「开两个窗口」相当
  lingxi: { concurrency: 2 },
  // 有道龙虾：与桌面端 tokenProxy 共用同一账号额度，并发 2 与「编码 agent + 对话窗口」相当
  lobster: { concurrency: 2 },
};
```

写 `zcode: { concurrency: 8 }` 会被压回 1——否则用户会把一个必然 `3009` 的配置
当成「自己的选择」放过。

### Qoder 的排队限制

Qoder 国内/国际版的免费账号由**上游按并发排队**：并发超过 1 就可能收到
`403 + 10605 isQueued`（见 [02-pitfalls](02-pitfalls.md) P16）。本机把
`qoder-cn` / `qoder` 的并发硬压到 1、档位设为 `safe`（20/分钟、间隔 3 秒），
只能保证「不主动制造并发」，**不能消除上游队列**——服务端忙时，单路请求也会排。

遇到排队时：

- 不要靠调大 `concurrency` 解决，那只会让排队更严重；
- 客户端会收到 `429` + `Retry-After`（代理从上游的 `retryAfterSeconds` 抄来，
  缺省 30 秒），等它重试即可；
- 如果 `queueCount` 一直不为 0、重试很久仍失败，才是真的被限流，换号或换供应商；
- 需要稳定并行时用统一网关的降级链，把 Qoder 只当其中一跳，而不是唯一来源。

## 配置

`limits.json`（仓库根，可提交）：

```json
{
  "tier": "max",
  "overrideHardCaps": true,
  "providers": {
    "zcode": { "tier": "max" },
    "raccoon": { "tier": "max" }
  },
  "free": { "concurrency": 64, "rpm": 600, "minIntervalMs": 0, "burst": 64, "dailyCap": 0 }
}
```

- `tier` 全局默认档；`providers.<id>` 按家覆盖
- `overrideHardCaps: true` 跳过 `HARD_CAPS` 封顶（最宽配置；默认 `false`）
- `free` 是**免费供应商**（云端 API-Key 直连）的限额——它们的免费额度风控
  往往比订阅更敏感
- 单项也能覆盖：`{ "raccoon": { "rpm": 6 } }` 只改速率，其余继承档位

## 命令

```bash
node router.mjs limits                  # 看全部（显示生效值，含封顶）
node router.mjs limits raccoon          # 只看一家
node router.mjs limits raccoon safe     # 改档位
node router.mjs limits raccoon rpm 6    # 改单项
node router.mjs limits raccoon reset    # 恢复继承全局档
node router.mjs limits --check          # 体检：有没有被硬约束压掉/形同虚设的配置
node router.mjs limits --apply          # 下发给自带限流器的反代（目前只有 CodeArts）
```

`--apply` 存在的原因：CodeArts2API 是 Go 网关，自带 `rate_limit_*` 设置，默认
5 QPS / 突发 10 / 并发 8。不改它，客户端**直连 :10087** 时 router 侧限额管不到。

## 生效范围（三层都要有）

| 层 | 谁执行 | 挡得住什么 |
|---|---|---|
| 反代自身（`raccoon-proxy` / `loomy-proxy` / `dumate-proxy`） | 各自的 `LIMITER` | 客户端**直连反代端口**时的并发/速率 |
| 网关（`gateway/server.mjs`） | `scheduler.limiterFor(id)` | 经网关的跨供应商调度 |
| 第三方反代内置限流 | `limits --apply` | 只有 CodeArts 可下发 |

**为什么反代自己也要限**：客户端可以绕过网关直连 `:8793`。那时只有反代这一层
能挡住「开 10 个子代理并行打上游」。

> **Qoder 是例外**：`qoder-proxy` 是第三方脚本，本身没有接本机限流器。直连
> `:8789` / `:8790` 时，`HARD_CAPS` 的并发 1 不会生效；只有经统一网关
> （`:8785`）才会被 `scheduler.limiterFor` 挡住。所以 Qoder 更容易撞上上游
> `10605`，尤其是在客户端开子代理并行时。

## 一个容易搞错的点：执行位要占到流结束

流式对话能持续几十秒。如果响应头一到就释放并发位，等于**没有并发限制**——
上游看到的仍是 N 路并行。所以 `pipeUpstream` 必须等到流真正写完才 resolve，
`gateway/server.mjs` 的 `finishAttempt()` 也要放在 `relay()` 的 `finally` 里。

判断依据：流式请求进行中查 `/health`，`limits.inFlight` 应该 ≥ 1。

```bash
curl -s http://127.0.0.1:8793/health | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).limits))"
```

## 被限流时看到什么

反代直连：

```json
HTTP 429
Retry-After: 2
{"ok":false,"error":{"message":"本地限流：2 秒后重试（40/分钟，并发 2）","type":"raccoon_rate_limited","code":429}}
```

经网关：

```json
HTTP 429
Retry-After: 1
{"error":{"message":"本地限流：本机限额已满（并发或速率），约 1 秒后恢复","type":"rate_limit_error"}}
```

网关对「全被本地限流挡住」会**先让限流器排队最多 5 秒**再决定是否 429——
只对应一家供应商的模型（`raccoon/xxx`），用户不该每次都被自己重试。

## 排查

| 症状 | 看什么 |
|---|---|
| 客户端频繁 429，但上游额度充足 | `node router.mjs limits` + `node router.mjs gateway status` 的速率列 |
| `gateway status` 里速率列带 `*` | 那家此刻被本地限流挡住（`limit.throttled`） |
| 想确认限流真生效 | 并发打 6 个请求，看是否分批完成而不是 6 路齐发 |
| 觉得限得太死 | 先 `limits <id> max` 试；要连上游硬约束一起放开就设 `overrideHardCaps: true`（最宽配置）；别直接删配置 |
| 想临时关掉（调试） | 反代支持 `RACCOON_LIMITS=off` / `LOOMY_LIMITS=off`，**别长期关** |

## 和「上游 429 冷却」的区别

两者都会回 429，但成因完全不同：

| | 本地限流 | 上游限流/冷却 |
|---|---|---|
| 谁拒绝的 | 本机（请求没发出去） | 上游（已经发出去了） |
| 代价 | 多等几秒 | 产生一次可疑请求 + 冷却期整家不可用 |
| 文案 | 以「本地限流：」开头 | 上游原文（`exceed quota` / `10605`） |
| 调什么 | `limits.json` | 等冷却，或查账号/额度 |
