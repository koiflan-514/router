# Qoder 网关协议要点

> **适合**：要改 Qoder 代理，或排查签名 / 编码 / SSE 问题。  
> **前置**：读过 [全链路拓扑](01-topology.md)，了解 OpenAI 兼容层。  
> **相关**：[踩坑记录](02-pitfalls.md) · [复用经验](06-reuse.md)

从 `pi-provider-qoder` 与实测反推出来的最小可复现知识。做第三方接入时按这份复制即可。

## 端点

| 用途 | 国内版 | 国际版 |
|---|---|---|
| 网关基址 | `https://gateway.qoder.com.cn/` | `https://api3.qoder.sh/` |
| 只读 openapi | `https://openapi.qoder.com.cn` | `https://openapi.qoder.sh` |
| 模型目录 | `<网关>algo/api/v2/model/list?Encode=1` | 同 |
| 对话 | `<网关>algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | 同 |
| 额度 | `<openapi>/api/v2/quota/usage` | 同 |
| 套餐 | `<openapi>/api/v2/user/plan` | 同 |
| 签到状态 | `<openapi>/sash/api/v1/me/daily-check-in/status` | **404**（无此接口） |
| 签到领取 | `POST <openapi>/sash/api/v1/me/daily-check-in/claim` | 不存在 |
| 设备授权轮询 | — | `<openapi>/api/v1/deviceToken/poll` |
| 设备 token 续期 | — | `POST <openapi>/api/v1/deviceToken/refresh` |
| PAT 换 job token | `POST <openapi>/api/v1/jobToken/exchange` | 同 |
| 用户信息 | `<openapi>/api/v1/userinfo` | 同 |

**注意**：网关的 `algo/*` 路径需要 COSY 签名；`openapi/*` 是纯 Bearer，不需要签名。
**能走 openapi 就走 openapi**，省掉整个签名实现。

## COSY 签名

网关只认带这套头的请求：

```
Authorization: Bearer COSY.<payloadB64>.<sig>
Cosy-Key / Cosy-User / Cosy-Date / Cosy-Version
Cosy-Machineid / Cosy-Machinetoken / Cosy-Machinetype / Cosy-Machineos
Cosy-Clienttype / Cosy-Clientip / Cosy-Bodyhash / Cosy-Bodylength / Cosy-Sigpath
Cosy-Data-Policy / Cosy-Organization-Id / Cosy-Organization-Tags
Login-Version: v2
X-Request-Id
```

构造过程：

```js
const aesKey = randomUUID().replace(/-/g,'').slice(0,16);        // 16 字符
const info = { uid, security_oauth_token: authToken, name, aid:'', email };
const infoB64 = aes128cbc(JSON.stringify(info), aesKey);          // key 与 iv 都是 aesKey
const cosyKey = rsa_pkcs1(aesKey);                                // 用内置公钥

const payload = { version:'v1', requestId, info: infoB64,
                  cosyVersion:'1.1.38', ideVersion:'' };
const payloadB64 = base64(JSON.stringify(payload));

const sigPath = pathname.startsWith('/algo') ? pathname.slice(5) : pathname;
const sig = md5([payloadB64, cosyKey, timestamp, bodyBytes, sigPath].join('\n'));
```

**三个必踩的坑**：

1. `sigPath` 要去掉 `/algo` 前缀
2. `bodyBytes` 必须是**实际发出的字节**（编码后的），见 P4
3. `Cosy-Bodyhash` 同理，`Cosy-Bodylength` 是字节数

内置 RSA 公钥（1024 位，PKCS#1 v1.5）：

```
-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----
```

## body 编码

```js
const CUSTOM = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD    = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeQoderBody(buf) {
  const std = buf.toString('base64');
  const n = std.length, a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let d = 0;
  for (let i = n - a; i < n;     i++) out[d++] = table[std.charCodeAt(i)];  // 后 1/3 提到最前
  for (let i = a;     i < n - a; i++) out[d++] = table[std.charCodeAt(i)];  // 中间不动
  for (let i = 0;     i < a;     i++) out[d++] = table[std.charCodeAt(i)];  // 前 1/3 放最后
  return out;
}
// table: 先把 0..255 映射成自身，再让 STD 的每个字符映射到 CUSTOM 对应位置，
//        最后 '=' → '$'
```

## 对话请求体

```jsonc
{
  "request_id": "<uuid>",
  "chat_record_id": "<稳定哈希>",   // 同样的对话前缀要同一个 id，服务端据此命中缓存
  "session_id": "<uuid>",
  "stream": true,                    // 网关只支持流式；非流式由代理自己聚合
  "chat_task": "FREE_INPUT",
  "source": 1, "version": "3",
  "session_type": "qodercli",
  "agent_id": "agent_common", "task_id": "common",
  "system": "",                      // 顶层 system 会被忽略，见下
  "messages": [
    { "role": "system", "content": "..." },   // ← system 必须作为首条消息塞进来
    { "role": "user", "content": "..." }
  ],
  "tools": [ { "type":"function", "function": { "name", "description", "parameters" } } ],
  "parameters": { "max_tokens": 131072, "enable_thinking": true, "reasoning_effort": "high" },
  "model_config": { "key": "qmodel", "is_reasoning": false, "source": "system" },
  "chat_context": { "chatPrompt":"", "imageUrls":null,
                    "extra": { "context": [], "modelConfig": {...}, "originalContent": "<最后一条用户文本>" },
                    "features": [], "text": "<最后一条用户文本>" },
  "business": { "product":"cli", "version":"1.0.0", "type":"agent", "stage":"start",
                "id":"<uuid>", "name":"<前 30 字>", "begin_at": 0 }
}
```

**要点**：

- `system` 顶层字段服务端**不读**，必须作为 `messages[0]` 塞进去
- `model_config.key` 是上游模型 key（`qmodel`/`dmodel`/`qmodel_38max`…），不是
  display name
- `parameters.enable_thinking` 默认可能要显式给，否则会白烧 reasoning token
- `reasoning_effort` 只在模型 `thinking_config.enabled.efforts` 里有该档位时才发

## SSE 格式

```
data:{"headers":{"Content-Type":["application/json"]},"body":"{\"choices\":[{\"delta\":{\"reasoning_content\":\"...\"}}],\"id\":\"chatcmpl-...\"}","statusCodeValue":200,"statusCode":"OK"}

data:{"headers":{...},"body":"[DONE]","statusCodeValue":200}

event:finish
data:{"firstTokenDuration":1105,"totalDuration":3340,"serverDuration":507}
```

解析要点见 P6：

- 外层 `statusCodeValue !== 200` 要当错误抛，别当空回复
- `[DONE]` 内外两层都可能出现
- 末尾的 `event:finish` 是非 `data:` 行，忽略即可

## tool_calls 的流式形态

```
delta.tool_calls[0] = { index:0, id:"call_xxx", type:"function", function:{ name:"get_weather", arguments:"" } }
delta.tool_calls[0] = { index:0, function:{ arguments:"{\"city\": \"Be" } }      // 只给 index
delta.tool_calls[0] = { index:0, function:{ arguments:"ijing\"}" } }
finish_reason: "tool_calls"
```

**只有第一个 delta 给 `id` 与 `name`**，后续只给 `index` + `arguments` 片段。代理必须
自己记住 `index → {id, name}` 的映射，否则客户端拿不到完整调用。

## 模型目录（`model/list`）

```jsonc
{"chat":[{
  "key":"qmodel_38max", "display_name":"Qwen3.8-Max",
  "enable": true,                 // ← 只有 true 的才真的能用
  "is_reasoning": true, "is_vl": true,
  "context_config": { "1M": {"token_count":1000000}, "200K": {"token_count":200000,"is_default":true} },
  "thinking_config": { "enabled": {"efforts":{"low":{},"high":{}}}, "disabled": {} }
}]}
```

- 客户端 id 惯例是 `display_name` 去空白：`Qwen3.8-Max` → `Qwen3.8-Max`
- 上下文窗口取 `context_config` 里最大的 `token_count`
- **`enable: false` 的模型即使列出来也不能用**（见 P10）

## 凭证结构与续期

pi 的 `~/.pi/agent/auth.json`：

```jsonc
{
  "qoder-cn": {
    "type": "oauth",
    "access": "dt-...",                    // device token（浏览器登录）或 job token（PAT）
    "refresh": "drt-...|userID|machineID", // 或 "pat|pat|jobRefresh|userID|machineID"
    "expires": 1796171519793,
    "userID": "...", "name": "...", "email": "...", "machineID": "..."
  }
}
```

两种 `refresh` 前缀对应两条续期路径：

| 前缀 | 路径 | 说明 |
|---|---|---|
| `pat\|` | `POST <openapi>/api/v1/jobToken/exchange` | 拿 PAT 再换一次 job token |
| 其它（`drt-…`） | `POST <openapi>/api/v1/deviceToken/refresh` | 浏览器登录产生的凭证 |

**坑**：网关的 `/algo/api/v3/user/refresh_token` 对直接调用返回
`403 Request discarded`——那条路走不通，别在上面浪费时间。真正能用的是 openapi 的
`deviceToken/refresh`。

```js
// 续期成功
POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh
{"refresh_token":"drt-..."}
→ {"device_token":"dt-...","refresh_token":"drt-...(轮换)","expires_at":"...","refresh_token_expires_at":"..."}
```

**refresh token 会轮换**，续期后必须把新的写回去，否则下次失败。

## 设备授权流程

```
1. 生成 PKCE: verifier = base64url(random32), challenge = S256(verifier)
2. nonce = uuid, machineID 取本机已有的
3. 浏览器打开：
   https://qoder.com/device/selectAccounts?challenge=<c>&challenge_method=S256&machine_id=<m>&nonce=<n>
4. 轮询（每 2 秒，最多 10 分钟）：
   GET <openapi>/api/v1/deviceToken/poll?nonce=<n>&verifier=<v>&challenge_method=S256
   → 202/404 继续等；200 + token 成功
5. 成功响应里有 token / refresh_token / user_id / expires_at
6. 存进 auth.json：refresh 编码成 "refreshToken|userID|machineID"
```

国内版**不支持设备授权**（只支持 PAT），国际版两者都支持。

---

← [文档索引](README.md) ｜ 上一篇：[踩坑记录](02-pitfalls.md) ｜ 下一篇：[新供应商接入排查清单](04-checklist.md)
