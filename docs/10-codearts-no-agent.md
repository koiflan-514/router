# CodeArts 反代：不安装 Agent 的实现说明

> 目标：把 CodeArts Agent（华为云码道 / CodeArts Doer for Coding）的模型能力，
> 接进任意 OpenAI / Anthropic 兼容客户端，**但不下载、不安装整个 CodeArts Agent**。
>
> 结论先说：**可以做到**。不装 Agent 时，唯一缺的是“登录态”；用浏览器
> OAuth（PKCE + DPoP）就能拿到同一套 STS 凭据。之后只需要一个本地签名网关，
> 不需要 DPAPI、不需要 `state.vscdb`、不需要 `agentkernelServer.exe`。
>
> 本文是给“人 + AI”看的实现稿：把 §0 的提示词和 §2–§5 的协议事实一起交给 AI，
> 它就能从零写一个最小可用版本。完整实现（账号池、控制台、Anthropic 协议）
> 在 `E:\router\integrations\codearts2api`，本文只保留**不装 Agent 的最小路径**。

---

## 0. 直接交给 AI 的提示词

把下面这段整段复制给 AI，再附上本文 §2–§5：

```text
你要实现一个本地 CodeArts2API 网关，让 OpenAI/Anthropic 兼容客户端能用
CodeArts Agent 的模型。硬约束：

1. 不安装 CodeArts Agent，不读 state.vscdb，不使用 DPAPI。
   凭据通过浏览器 OAuth 2.0 授权码 + PKCE + DPoP 获取；授权码换 STS 后，
   用 refresh_token + DPoP 自动续期。
2. 上游是华为云 inferhub，请求必须用 SDK-HMAC-SHA256 签名。
   注意两个与官方文档不同的细节：
   - CanonicalURI 每个路径段单独 URL 编码后，强制补一个尾斜杠；
   - CanonicalHeaders 每行自带 "\n"，拼 CanonicalRequest 时又补一个 "\n"，
     所以 SignedHeaders 前会多一个空行。
3. 请求头必须带 CodeArts 插件身份头；body.model 必须与 model-id、model-name
   完全一致；不要发送 maas_type。
4. 同一份凭据要复用稳定的 x-ot-session-id（上游每账号最多 3 个并发会话）。
5. 上游可能用 HTTP 200 + error_code 表示失败，必须从 error_code 里取真实
   状态码，不能把业务错误当成功。
6. 模型名解析失败直接 404，绝不静默回落到另一个计费模型。
7. 先实现最小闭环：/health、/v1/models、/v1/chat/completions（流式+非流式）。
   /v1/messages 可选。
8. 验收必须通过本文 §4.4 的签名金标准向量，以及 §6 的实测清单。
9. 凭据文件、Authorization、X-Security-token 不得写日志；只监听 127.0.0.1。

输出要求：给出可运行的单文件服务（Node.js 或 Go 均可）、credential.json
示例、启动命令、客户端配置，以及签名自测脚本。
```

---

## 1. 总体链路

```text
┌──────────────┐   /v1/chat/completions   ┌────────────────┐   SDK-HMAC-SHA256   ┌──────────────────────────────────────┐
│ OpenAI SDK   │   /v1/models             │ 本地网关        │   + X-Security-token │ snap-access.cn-north-4.myhuaweicloud │
│ pi / opencode│ ───────────────────────▶ │ 127.0.0.1:10087│ ───────────────────▶ │ .com/api/v2/chat/completions         │
└──────────────┘   SSE / JSON             └───────┬────────┘                      └──────────────────────────────────────┘
                                                  │
                         浏览器 OAuth PKCE + DPoP  │  （不装 Agent）
                                                  ▼
                                   https://sts.cn-north-4.myhuaweicloud.com
                                        /v1/oauth2/tokens
```

和“装 Agent 再读数据库”的方案相比，区别只在**凭据来源**：

| | 装 Agent（完整方案） | 不装 Agent（本文） |
|---|---|---|
| 凭据来源 | DPAPI 解密 `state.vscdb` | 浏览器 OAuth PKCE + DPoP |
| 需要的组件 | CodeArts Agent + 网关 | 只要网关 + 浏览器 |
| 续期 | refresh_token + DPoP | 同左 |
| 平台 | 基本只能 Windows | Windows / macOS / Linux 均可 |
| 首次登录 | 在 IDE 里登录 | 网关起本地回调，浏览器登录 |

---

## 2. 不装 Agent 怎么拿凭据

### 2.1 浏览器 OAuth：授权码 + PKCE + DPoP

这是 CodeArts 桌面端登录时走的同一条 OAuth 链路，只是把回调从 IDE 换成
网关自己的 `127.0.0.1` 本地 HTTP 服务。

**第一步：生成 PKCE 与 DPoP 密钥**

```text
code_verifier  = 32 字节随机数的 hex（64 个字符）
code_challenge = base64url(sha256(code_verifier))         // S256
DPoP key       = EC P-256 密钥对，导出为 JWK
                 private: {kty:"EC", crv:"P-256", x, y, d}
                 public:  {kty:"EC", crv:"P-256", x, y}
```

`code_verifier` 和 DPoP 私钥要**和 refresh_token 一起保存**。之后每次续期都要用
同一个 DPoP 公钥做 proof，丢了就只能重新登录。

**第二步：在 127.0.0.1 起回调服务器**

- 端口取 `>= 10000`（门户侧要求；可固定一个端口方便 SSH 隧道）。
- 回调路径固定为 `/oauth/callback`。
- 只绑定 `127.0.0.1`，不要 `0.0.0.0`。

**第三步：打开授权页**

```text
https://codearts.huaweicloud.com/portal/authorize
  ?theme=2
  &locale=zh-cn
  &uri_scheme=codearts-agent
  &client_id=codearts-agent
  &port=<回调端口>
  &code_challenge=<S256>
  &code_challenge_method=SHA-256
  &ticket_id=<32 字节随机 hex>
  &plugin-name=snap_AIIDE
  &plugin-version=26.9.902
```

注意：授权页只收 `port`，`redirect_uri` 由门户按 `uri_scheme` 自己拼成
`http://127.0.0.1:<port>/oauth/callback`。这是 OAuth native app 的 loopback
重定向（RFC 8252），**不接受自定义域名**。

**第四步：处理两次回调**

与 IDE 行为一致，浏览器会回调两次：

```text
GET /oauth/callback?secret=<...>&redirect=<...>
  → 返回 307，Location 指向 redirect

GET /oauth/callback?code=<authorizationCode>
  → 拿到授权码，进入换 token
```

如果用户不在同一台机器上，或者浏览器打不开 `127.0.0.1`，让用户把地址栏里
最终停下的完整 URL 粘贴回来，由网关自己跟随重定向链取出 `code`。
跟随目标只允许华为云域名和本机回环地址，避免 SSRF。

### 2.2 用授权码换 STS 凭据

```http
POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
Content-Type: application/x-www-form-urlencoded
DPoP: <ES256 JWS>

client_id=codearts-agent
&code=<authorizationCode>
&code_verifier=<code_verifier>
&grant_type=authorization_code
&redirect_uri=http://127.0.0.1:<port>/oauth/callback
```

DPoP proof 的构造：

```jsonc
// protected header
{"alg":"ES256","typ":"dpop+jwt","jwk":{/* 公钥 JWK，不能带 d */}}

// payload
{"htm":"POST","htu":"https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens",
 "iat":<unix 秒>,"jti":"<64 位随机 hex>"}
```

签名：`ES256`（P-256 + SHA-256），JWS 紧凑格式
`base64url(header) + "." + base64url(payload) + "." + base64url(r||s)`。
注意 r、s 各 32 字节，不要用 DER。

成功响应（字段位置可能多包一层 `result`，要兼容）：

```jsonc
{
  "credentials": {
    "access_key_id": "HSTA...",
    "secret_access_key": "...",
    "security_token": "...",
    "expiration": "2026-11-05T12:00:00Z"
  },
  "refresh_token": "eyJ0eXAi..."
}
```

### 2.3 续期

STS 临时凭据约 2 小时有效。过期前用 refresh_token 换新的：

```http
POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
Content-Type: application/x-www-form-urlencoded
DPoP: <ES256 JWS，htu 同上>

client_id=codearts-agent
&code_verifier=<code_verifier>
&grant_type=refresh_token
&refresh_token=<refresh_token>
```

响应结构与 2.2 相同。**refresh_token 可能是单次使用 + 轮转的**：每次响应里的
新 `refresh_token` 必须覆盖旧值；同一账号的续期必须串行，否则并发续期会互相作废
（上游可能报 `STS5.1806` / `invalid_grant`）。

### 2.4 落盘格式

只需要保存这些字段，**不需要**保存 Agent 的任何文件：

```jsonc
{
  "account": "demo",
  "access_key": "HSTA...",
  "secret_key": "...",
  "security_token": "...",          // 永久 IAM AK/SK 时为空
  "expires_at": "2026-11-05T12:00:00Z",
  "refresh_token": "eyJ0eXAi...",
  "code_verifier": "<PKCE verifier>",
  "dpop_private_jwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "d": "..." },
  "dpop_public_jwk":  { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
  "region": "cn-north-4"
}
```

文件权限设为 `0600`。这份文件等价于账号登录态，不能进 Git、不能贴聊天。

### 2.5 三种备选凭据

| 方式 | 是否需装 Agent | 适用 |
|---|---|---|
| 浏览器 OAuth PKCE + DPoP | **否** | 推荐；本文主路径 |
| 从已装 Agent 的机器导出 session JSON | 导出时需要 | 跨机器迁移；带 refresh_token，导入后仍可续期 |
| 手工录入永久 IAM AK/SK | 否 | 不过期、不续期；签名时不带 `X-Security-token` |

> 只有“读 `state.vscdb`”才需要 Windows + DPAPI。本文的主路径完全绕开它。

---

## 3. 上游协议事实

### 3.1 端点

| 用途 | 方法 + 路径 | 主机 |
|---|---|---|
| 对话（OpenAI 兼容） | `POST /api/v2/chat/completions` | `https://snap-access.cn-north-4.myhuaweicloud.com` |
| 备用域名 | 同上 | `https://snap-access.cn-north-4.myhuaweicloud.cn` |
| 可用模型 | `GET /v1/model/builtin` | 同上，需 `Agent-Type: PromptCenter` |
| 积分套餐/用量 | `GET /snap-manager/v1/statistics/plugin` | 同上 |
| 运营活动清单 | `GET /v1/ops/delivery` | 同上，需 `Agent-Type: PromptCenter` |
| 运营活动领取 | `POST /v1/ops/claim` | 同上，需 `Agent-Type: PromptCenter`，幂等 |
| 邀请码 | `POST /v1/ops/invite/generate` | 同上 |
| OAuth 授权页 | `GET https://codearts.huaweicloud.com/portal/authorize` | — |
| 换 token / 续期 | `POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` | — |

免费权益（benefit）通道已于 2026-10 下线：
`/api/v1/gateway/config`、`/api/v1/benefit/claim`、`/api/v1/user/tokens/balance`
都会返回 `4000: invalid channel, group not found`。**不要实现这条通道**。

### 3.2 请求头

| 头 | 值 | 说明 |
|---|---|---|
| `Authorization` | `SDK-HMAC-SHA256 Access=..., SignedHeaders=..., Signature=...` | 每请求现算 |
| `X-Security-token` | STS token | 仅临时凭据；永久 AK/SK 不带 |
| `X-Sdk-Date` | `20261105T120000Z` | UTC |
| `content-type` | `application/json` | |
| `host` | `snap-access.cn-north-4.myhuaweicloud.com` | 参与签名 |
| `plugin-name` | `codemate_vscode` | |
| `plugin-version` | `26.9.902` | |
| `ide-name` | `VSCode` | |
| `ide-version` | `26.9.902` | |
| `app-id` | `CodeAgent3.0` | |
| `X-Language` | `zh-cn` | |
| `x-ot-client-type` | `IDE` | |
| `x-ot-function` | `agent-general` | |
| `x-ot-session-id` | `ses_<hash>` | 按凭据复用，不要每请求随机 |
| `user-session-id` | 同上 | 与 `x-ot-session-id` 一致 |
| `x-ot-trace-id` / `x-ot-span-id` / `x-snap-traceid` | 随机 | 链路追踪 |
| `user-msg-id` | `msg_<random>` | |
| `created-time` | `2026-11-05T12:00:00Z` | UTC |
| `model-id` / `model-name` | 最终模型名 | **必须与 body.model 完全一致** |
| `maas_type` | **不要发送** | benefit 通道已下线 |

`x-ot-session-id` 建议：

```text
ses_ + hex( sha256( domainID + "|" + accessKey ) )[0:16]
```

AK 轮换后自然换新 ID；同一 AK 的并发请求复用同一个 ID。上游按它统计并发会话，
**每账号上限 3 个**，超过会报 `TM.00001041`。

### 3.3 模型清单

运行时以 `GET /v1/model/builtin` 为准，不要硬编码。2026-11 实测 13 个
（全部走积分通道，真实扣费）：

| model_id | 积分倍率 |
|---|---|
| `glm-5.3-flash` | 0.08x |
| `deepseek-v4.1-flash` | 0.18x |
| `deepseek-v4.1-flash-1017` | 0.18x |
| `speed` | 0.18x |
| `openpangu-2.0-flash` | 0.32x |
| `GLM-5.2` / `glm-5.2-sft-harmony` / `openpangu-2.0-pro` | 0.7x |
| `glm-5.3` | 0.79x |
| `kimi-k3.1-pro` | 1.63x |
| `kimi-k3` | 2.38x |
| `Qwen3-VL-235B` / `kimi-k2.6-vl` | 图片理解，倍率未公布 |

规则：

- 只返回 `enable:true` 的模型。
- 请求的模型名不在清单里 → **404**，不要回落到默认模型；每个模型都真实扣积分。
- 模型名大小写敏感，`model-id` 与 `model-name` 要和 body 里的 `model` 逐字一致，
  不能有尾随空格，否则上游报 `406 The model not equals requestHeader's Model-Id`。
- `glm-5.3` **只支持流式**：`stream:false` 会得到 `400` + 空 body。网关应自动改用
  流式并在本地聚合，或者把这个模型标记为 stream-only。

### 3.4 请求 / 响应

请求体就是标准 OpenAI Chat Completions；上游额外支持 `reasoning_content`。
响应也是标准 OpenAI `chat.completion` / `chat.completion.chunk`，**不需要协议转换**。

最小请求：

```json
{
  "model": "glm-5.3-flash",
  "stream": false,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "你好" }
  ]
}
```

> 上游不认 `developer` 角色。客户端如果默认发 `developer`，要改成 `system`
> 或让客户端关闭该兼容项（pi：`compat.supportsDeveloperRole: false`）。

### 3.5 上游错误用 HTTP 200 表达

这是最容易踩的坑。上游经常返回：

```json
{"error_code":"InferHub.001001005.400",
 "details":[{"error_code":"RANGE_VALIDATOR",
             "error_msg":"temperature -> temperature should be between 0 and 2"}]}
```

HTTP 状态码可能是 200，**真实状态码在 `error_code` 里**：

| 形态 | 例子 | 取法 |
|---|---|---|
| 纯数字状态码 | `"400"` / `"422"` | 直接用 |
| 纯数字业务码 | `"4005"` | 不在 400–599 → 兜底 `400` |
| 复合码 | `InferHub.002002009.404` | 取最后一段 → `404` |

取不到一律兜底 `400`，**绝不返回 200 当成功**。

分类与处置：

| 情况 | 判定 | 处置 |
|---|---|---|
| 客户端请求错误 | 400/413/422，且不是空 body、不是凭据错误码 | 直接返回 400，不换号、不计账号故障 |
| 临时故障 | 429 / 5xx / `TM.00001041` | 退避重试；对外 429 |
| 凭据失效 | `APIG.*` / `STS5.*` / `invalid_grant` | 502 credentials_error / authentication_error，提示重新登录 |
| 空 body 的 4xx | 模型只支持流式 | 改用流式重试一次 |
| 未知模型 | 不在清单 | 404，不回落 |

---

## 4. 签名：SDK-HMAC-SHA256

### 4.1 算法

```text
CanonicalRequest =
  METHOD \n
  CanonicalURI \n
  CanonicalQuery \n
  CanonicalHeaders \n          // 注意：CanonicalHeaders 自身已以 \n 结尾
  SignedHeaders \n
  sha256Hex(payload)

StringToSign =
  "SDK-HMAC-SHA256" \n
  X-Sdk-Date \n
  sha256Hex(CanonicalRequest)

Signature = hex( HMAC-SHA256( SecretKey, StringToSign ) )

Authorization = SDK-HMAC-SHA256 Access=<AK>,
                SignedHeaders=<按字典序以 ; 连接>,
                Signature=<hex>
```

### 4.2 两个必须复刻的“坑”

1. **CanonicalURI 每个路径段单独 URL 编码，然后强制补尾斜杠。**

   ```text
   /api/v2/chat/completions  →  /api/v2/chat/completions/
   ```

2. **CanonicalHeaders 每行自带 `\n`，拼 CanonicalRequest 时又补一个 `\n`。**

   于是 `SignedHeaders` 前面会多一个空行：

   ```text
   content-type:application/json\n
   host:snap-access...\n
   \n
   content-type;host;...
   ```

其他细节：

- URL 编码只保留 `A-Za-z0-9-._~`，其余一律 `%XX`（大写）。
  **不要用 Go 的 `url.PathEscape`**，它会放过 `$&+,:;=@`。
- 查询串：键、值各自排序后再编码。
- 只有 `PUT` / `PATCH` / `POST` 的 body 参与签名；其他方法按空 body。
- Header 名统一小写后参与签名；**只对值 `trim`，不对名字 `trim`**。
- `host` 由 URL 推导，必须参与签名。

### 4.3 参考实现（Node.js，零依赖）

```js
import crypto from 'node:crypto';

const UNRESERVED = /[A-Za-z0-9\-._~]/;

function jsEncode(s) {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch)
      ? ch
      : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalUri(pathname) {
  const segs = pathname.split('/').map((seg) => jsEncode(decodeURIComponent(seg)));
  let out = segs.join('/');
  if (!out.endsWith('/')) out += '/';
  return out;
}

function canonicalQuery(searchParams) {
  const groups = new Map();
  for (const [k, v] of searchParams) {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const parts = [];
  for (const k of [...groups.keys()].sort()) {
    for (const v of groups.get(k).sort()) {
      parts.push(`${jsEncode(k)}=${jsEncode(v)}`);
    }
  }
  return parts.join('&');
}

export function signRequest({
  ak, sk, securityToken, method, url, body = Buffer.alloc(0), headers = {},
}) {
  const u = new URL(url);
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v);
  out.host = u.host;
  if (!out['x-sdk-date']) {
    out['x-sdk-date'] = new Date().toISOString()
      .replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }
  if (securityToken) out['x-security-token'] = securityToken;

  const payload = ['PUT', 'PATCH', 'POST'].includes(method) ? body : Buffer.alloc(0);
  const names = Object.keys(out).sort();
  const canonicalHeaders = names.map((k) => `${k}:${out[k].trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join('\n');

  const stringToSign = [
    'SDK-HMAC-SHA256',
    out['x-sdk-date'],
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  const signature = crypto.createHmac('sha256', sk)
    .update(stringToSign).digest('hex');

  out.authorization =
    `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
```

DPoP proof（Node.js，零依赖）：

```js
import crypto from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64url');

export function makeDpop({ privateKey, publicJwk, htm, htu }) {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomBytes(32).toString('hex'),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363', // r||s 各 32 字节，不是 DER
  });
  return `${input}.${b64url(sig)}`;
}

// 生成密钥对
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });
```

### 4.4 签名金标准向量

写完签名器先跑这个，**不要先打真实上游**。

**向量 A：GET + 查询串排序 + body 不参与签名**

```text
AK  = AKID
SK  = SECRET
方法 = GET
URL = https://opengw.developer.huaweicloud.com/api/v1/user/tokens/balance?b=2&a=1&a=0
body = {"ignored":true}          // GET 不参与签名
headers = { X-Sdk-Date: 20260203T040506Z }
期望 Authorization:
SDK-HMAC-SHA256 Access=AKID, SignedHeaders=host;x-sdk-date, Signature=0acd5e903f49fd4e91d71aee6188d446d6f76863c5d8f13a4d428c0af017af45
```

**向量 B：POST + STS + header 值 trim + 强制尾斜杠**

```text
AK  = HSTAAAAAAAAAAAAAAAAAAA
SK  = sk-secret-0123456789abcdef
STS = sts-token-abc123
方法 = POST
URL = https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
body = {"model":"glm-5.3-flash","stream":false}
headers = {
  Content-Type: application/json,
  X-Sdk-Date: 20260101T000000Z,
  maas_type: benefit,             // 仅为固定测试输入；生产不要发
  model-id: glm-5.3-flash,
  X-Ot-Function: "  agent-general  "
}
期望 Authorization:
SDK-HMAC-SHA256 Access=HSTAAAAAAAAAAAAAAAAAAA, SignedHeaders=content-type;host;maas_type;model-id;x-ot-function;x-sdk-date;x-security-token, Signature=d74d70f38c5d7e69b73c728740a2c7397a4191737d93f207d1a6f5fce49e99c4
```

> 向量 B 里的 `maas_type` 只是为了让签名输入固定；生产请求不要再带它。
> 两个向量都显式传 `X-Sdk-Date`，所以结果不依赖当前时间。

---

## 5. 最小网关实现

### 5.1 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 返回 `{ok:true, account:"..."}`，不调上游 |
| GET | `/v1/models` | 签名调用 `/v1/model/builtin`，转成 OpenAI 列表 |
| POST | `/v1/chat/completions` | 主入口；支持流式 / 非流式 |
| POST | `/v1/messages` | 可选；Anthropic 兼容需要额外做消息映射 |

只监听 `127.0.0.1`。对外用一个本地 API key（自己签发即可，和上游凭据无关），
避免同机其它程序随便消耗积分。

### 5.2 请求流程

```text
1. 读取客户端 JSON，校验 messages 非空。
2. 解析模型：用 /v1/model/builtin 的清单 + 可选的别名表。
   解析失败 → 404，绝不回落。
3. 改写 body：model = 最终模型名；stream 保持客户端要求。
4. 组装上游头：
   - 身份头（§3.2）
   - model-id / model-name = 最终模型名
   - x-ot-session-id / user-session-id = 按凭据推导的稳定值
   - X-Security-token（仅 STS）
5. 用 §4 的签名器加上 Authorization。
6. POST 上游 /api/v2/chat/completions。
7. 上游 200 但 body 有 error_code → 按 §3.5 取真实状态码并返回错误。
8. 流式：逐行转发 `data: ...`；非流式：原样返回 JSON。
9. 如果模型是 glm-5.3 且非流式返回 400 空 body → 改 stream=true 重试，
   本地聚合后按非流式返回。
```

### 5.3 模型解析

- 启动时或懒加载调用 `GET /v1/model/builtin`，缓存 `model_id` 集合。
- 别名表可选；别名最终必须落到一个真实 `model_id`。
- 客户端传空 model 时，如果配置了默认模型就用默认；否则 400。
- 不要因为“名字看起来像”就猜一个模型。

### 5.4 错误映射

对外建议保持 OpenAI 语义：

| 内部情况 | HTTP | `error.type` |
|---|---|---|
| 本地限流 | 429 | `rate_limit_error` |
| 上游 429 / 并发满 | 429 | `rate_limit_error` |
| 参数 / 模型名不合法 | 400 | `invalid_request_error` |
| 模型不存在 | 404 | `invalid_request_error` |
| 上游 5xx / 网络 | 502 | `upstream_error` |
| 凭据失效 / 无法续期 | 502 | `credentials_error` |
| 账号池为空 | 503 | `server_error` |

Anthropic 侧对应：`authentication_error` / `rate_limit_error` /
`invalid_request_error` / `overloaded_error`。

### 5.5 客户端配置

**OpenAI SDK / 任意 OpenAI 兼容客户端**

```text
base_url = http://127.0.0.1:10087/v1
api_key  = <本地 key，随便设一个，只要网关校验通过>
model    = glm-5.3-flash
```

**pi（`~/.pi/agent/models.json`）**

```jsonc
{
  "providers": {
    "codearts": {
      "baseUrl": "http://127.0.0.1:10087/v1",
      "name": "CodeArts Agent（华为云）",
      "api": "openai-completions",
      "apiKey": "<本地 key>",
      "compat": { "supportsDeveloperRole": false },
      "models": [
        { "id": "deepseek-v4.1-flash", "reasoning": true },
        { "id": "glm-5.3", "reasoning": true }
      ]
    }
  }
}
```

**opencode（`~/.config/opencode/opencode.json`）**

```jsonc
{
  "provider": {
    "codearts": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "CodeArts Agent",
      "options": {
        "baseURL": "http://127.0.0.1:10087/v1",
        "apiKey": "<本地 key>"
      },
      "models": {
        "glm-5.3-flash": { "name": "GLM-5.3-Flash" },
        "deepseek-v4.1-flash": { "name": "DeepSeek-V4.1-Flash" }
      }
    }
  }
}
```

---

## 6. 验收清单

按顺序做，前一步不过不要进下一步：

- [ ] **签名器**：§4.4 向量 A、B 的 `Authorization` 完全一致。
- [ ] **凭据**：OAuth 登录成功，`credential.json` 有 access/secret/securitytoken/
      refresh_token/DPoP 私钥/code_verifier。
- [ ] **模型清单**：签名 `GET /v1/model/builtin`（带 `Agent-Type: PromptCenter`）
      返回 `builtinModels`，至少 1 个 `enable:true`。
- [ ] **非流式对话**：`POST /v1/chat/completions`，`glm-5.3-flash`，`stream:false`，
      返回标准 `chat.completion`。
- [ ] **流式对话**：`stream:true`，能持续收到 `data: {...}`，最后 `data: [DONE]`。
- [ ] **未知模型**：传 `not-a-model` → 404，且没有回落到别的模型。
- [ ] **模型头一致性**：把 body.model 加一个尾随空格 → 上游应报 406；
      说明你的 `model-id`/`model-name` 与 body 确实一致（正常实现不会触发）。
- [ ] **续期**：把 `expires_at` 改到过去，再发请求，应自动 refresh 并把新的
      refresh_token 落盘；重启后仍能工作。
- [ ] **并发**：同一凭据同时发 4 个请求，确认没有因为每次换 session id 而
      持续撞 `TM.00001041`。
- [ ] **错误语义**：构造 `temperature=99`，应返回 400，且账号不被标记故障。

---

## 7. 安全

- 凭据文件 `0600`；`Authorization`、`X-Security-token`、refresh_token 不写日志。
- 回调服务器只绑 `127.0.0.1`；只接受本机回调路径；跟随重定向时限制域名。
- 网关默认只监听 `127.0.0.1`。如果确实要暴露，必须加本地 API key、TLS 和反代鉴权。
- session JSON / credential.json 等同于账号登录态，不能提交到 Git、不能贴聊天。
- 只用于复用自己已授权的账号权益，遵守华为云服务条款。

---

## 8. 常见失败对照

| 现象 | 大概率原因 | 处理 |
|---|---|---|
| `APIG.0301 Unauthorized` | 签名 canonical 拼装不对 | 先跑 §4.4 向量；检查尾斜杠、空行、URL 编码 |
| `406 The model not equals requestHeader's Model-Id` | body.model 与 model-id/model-name 不一致 | 两处写同一个最终模型名，去尾随空格 |
| `TM.00001041` 并发会话数已达上限 | `x-ot-session-id` 每请求随机 | 按凭据复用稳定 session id |
| `400` + 空 body | 模型只支持流式（如 `glm-5.3`） | 改 stream=true，本地聚合 |
| `4000 invalid channel, group not found` | 还在调已下线的 benefit 接口 | 删除 benefit 通道，只走积分 |
| `Message role cannot empty` / 400 | 客户端发了 `developer` 角色 | 改 `system`，或客户端关闭 developer 兼容 |
| 401 / 403 | STS 过期、AK/SK 错、X-Security-token 缺失 | 续期；STS 必须带 security token |
| `STS5.1806` / `invalid_grant` | refresh_token 被并发续期作废 | 同一账号续期串行；用最新 refresh_token |
| 浏览器回调打不开 | 网关不在浏览器同一台机器 | SSH 端口转发，或粘贴回调 URL |
| 429 但额度充足 | 上游并发/限流 | 退避重试；多账号轮换 |

---

## 9. 与完整 CodeArts2API 的关系

本文是“**不装 Agent 的最小实现**”。如果还需要：

- 多账号池 / 轮换 / 失败退避
- 每日自动领取活动福利
- Web 控制台、密钥管理、积分与模型测活
- Anthropic `/v1/messages` 与 `thinking` / `tool_use` 映射
- Prometheus `/metrics`

直接复用 `E:\router\integrations\codearts2api`（Apache-2.0）即可；它已经实现了
上面全部内容，并且本文的 OAuth、签名、错误分类都来自同一套代码与测试。
本文的价值是：**把“必须知道的上游事实”压缩到一页，让 AI 不必先读完整个项目**。
