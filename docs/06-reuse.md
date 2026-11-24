# 怎么把这套经验套到新供应商

> **适合**：想把 router 的模式套到另一家订阅或客户端上。  
> **前置**：读过 [排查清单](04-checklist.md)。  
> **相关**：[全链路拓扑](01-topology.md) · [踩坑记录](02-pitfalls.md)

目标：把新供应商（比如 GitHub Copilot、Cursor、Windsurf、某某国产 IDE）也接到 pi 与
opencode。以下是从前面几家总结出来的通用路径。

## 第 1 步：定性 —— 它属于哪种形态

| 形态 | 判据 | 要做的事 |
|---|---|---|
| **A. 已是 OpenAI 兼容** | `curl <base>/v1/models` 返回 `{data:[{id}]}` | 只写配置，10 分钟 |
| **B. 有官方反代/网关项目** | 社区有 `xxx2api` 这类 | 用它，别自己写协议 |
| **C. 私有协议** | 签名/自定义编码/非常规 SSE | 写代理（像 `qoder-proxy.js`） |
| **D. 只有客户端内置** | 无公开 API，凭证加密落盘 | **先别做**，见下方风险 |

### 关于 D 类的判断

先看有没有**解密后的可用凭证**：

- 明文 JSON（如 WorkBuddy 的 `~/.codebuddy-session.json`）→ 可做，用官方 openapi
- DPAPI/自定义加密（如 Qoder 桌面端 `auth.v1.dat`）→ 能解，但**优先走官方 PAT / 设备授权**，
  不要去解客户端落盘文件
- 需要设备指纹才能通过校验 → **放弃自动签到**，只做只读查询

**这是风险边界，不是技术边界。** 伪造设备身份调对话/签到接口随时可能失效并危及账号，
而正确的做法往往是：用官方 PAT（Qoder）或官方反代（WorkBuddy/Trae）。

## 第 2 步：找出凭证的权威来源

优先级从高到低：

1. **官方 PAT / API key 页面**（最稳，可续期）
2. **官方 OAuth / 设备授权**（次稳，refresh token 可续）
3. **本机官方反代已经处理好的 session 文件**（能用，但依赖那个反代）
4. 客户端落盘加密凭证（下策，只在上面都没有时考虑）

拿到后立刻回答三个问题：

- token 类型是什么？（PAT / device token / job token / OAuth access）
- 怎么续期？端点是什么？refresh 会不会轮换？
- 有效期多长？有没有 `expires_at` 字段？

## 第 3 步：打穿一个最小请求

**在写任何集成代码之前**，用 scripts 或 curl 打通一次。记录：

- 完整 URL（含 query）
- 必需的头（尤其是那些"看起来没用"的：`X-Product-Code`、`X-IDE-*`、`X-Conversation-*`）
- body 的精确形状（是否要 `stream: true`、是否要 `system` 作为首条消息）
- 响应格式（SSE？双层信封？非流式是否支持？）

把这次成功的请求原样存成脚本，后面所有调试都以它为基准。

## 第 4 步：区分三层错误

```
传输层 → 端口/进程    netstat、health.mjs
协议层 → 401/403/400  见 02-pitfalls.md 错误码速查
业务层 → 模型/额度     model list、quota
```

**不要跨层猜。** 端口没通就别调 token；token 401 就别改 body 编码。

## 第 5 步：写适配器（如果确实需要）

最小骨架，照 `assets/qoder-proxy.js` 的形状：

```
1. 凭据层：读 auth 文件 → 过期则续期 → 写回（让 pi 与 opencode 共用）
2. 目录层：拉模型列表 → 缓存（带 TTL）→ 找不到时用兜底表
3. 转换层：OpenAI 请求 → 上游请求（消息/工具/思考开关）
4. 流层：上游 SSE → OpenAI chunk（含 tool_calls 的 id 重组）
5. 服务层：/health、/v1/models、/v1/chat/completions
```

**只做这五个端点，别做更多。** 多做的每个端点都是维护成本。

### 三处必须小心的转换

**a) system 的位置。** 有的网关忽略顶层 `system` 字段，要求作为 `messages[0]`
（Qoder 如此；WorkBuddy 国际站甚至强制要求首条是 system）。

**b) tool_calls 的流式重组。** 上游通常只在第一个 delta 给 `id`/`name`，后续只给
`index` + `arguments` 片段。必须自己维护 `index → {id, name}` 映射，否则客户端拿不到
完整调用。

**c) 思考内容。** 两种形态都要处理：`delta.reasoning_content` 字段，或 `<thinking>`
标签包在 content 里（流式时要处理"半个标签"的边界）。

## 第 6 步：两个消费端都接

| 端 | 方式 | 注意 |
|---|---|---|
| pi | 扩展 `registerProvider`（能吃私有协议） | 模型目录可读客户端配置 |
| opencode | `opencode.json` 的 `provider`（只认 OpenAI） | 需 OpenAI 兼容端点 |

**配置写入必须合并**，只碰自己那个键，写前备份。合并逻辑收在一处（参考
`assets/opencode-config.js`），别让每家各写一份。

## 第 7 步：把坑变成检查

每踩一个坑，产出一条自动检查：

```js
// 端点字符串影响头注入
assert.match(config, /codebuddy\.ai/);
// 依赖最低版本
assert.ok(version >= '2.0.7');
// 服务跑旧二进制
if (serviceWheel !== currentWheel) warn('服务仍在跑旧反代');
```

**没有测试的坑一定会被再踩一次。**

## 第 8 步：纳入本目录

1. `scripts/health.mjs` 的 `SOURCES` 数组加一行（url / 凭证文件 / 探针模型）
2. `scripts/verify-all.sh` 的 `PAIRS` 数组加一行（provider:model）
3. `docs/01-topology.md` 的拓扑图与端口表加一行
4. 新踩的坑写进 `docs/02-pitfalls.md`，**重点写「判断依据」**
5. 如果它也有自己的一套协议，照 `docs/03-qoder-protocol.md` 补一份

## 速查：几家对比

| | Qoder CN | Qoder 国际 | Trae | WorkBuddy CN | WorkBuddy 国际 |
|---|---|---|---|---|---|
| 协议 | COSY 私有 | COSY 私有 | OpenAI | OpenAI | OpenAI |
| 要不要代理 | 要（本项目） | 要（本项目） | 否（第三方反代） | 否 | 否 |
| 凭证 | PAT / 设备授权 | 设备授权 | 反代自管 | 浏览器登录 | 浏览器登录 |
| 签到 | 有接口，当前关闭 | 无接口 | 反代里看 | 无 | 无 |
| 特殊坑 | body 编码、403 | 同 + 只有 1 个模型 | 列表要鉴权 | — | 11128、模型表 |

**共性**：几家都不约而同把「真实可用的模型清单」放在客户端落盘配置里，而不是 API
响应里。这是最值得记住的一条。

---

← [文档索引](README.md) ｜ 上一篇：[日常运维](05-operations.md) ｜ 下一篇：[选择性启停（router）](07-selective.md)
