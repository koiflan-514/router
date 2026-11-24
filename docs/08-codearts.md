# CodeArts Agent（华为云码道）

> **适合**：使用或部署 CodeArts Agent（华为云码道）反代。  
> **前置**：有 CodeArts 账号；自行构建需要 Go 1.22+。  
> **相关**：[不装 Agent 的 CodeArts](10-codearts-no-agent.md) · [日常运维](05-operations.md)

CodeArts 接入。与前面几家最大的不同：**没有自己写代理，而是复用了一个成熟的第三方
Go 网关**（[2951461586/CodeArts2API](https://github.com/2951461586/CodeArts2API)）。

## 为什么用别人的实现

先尝试自己实现（照 Qoder 的路子写一个 `codearts-proxy.js`），失败在签名这一步：

> 只想“不装 Agent 也能用”的最小实现，见
> [10-codearts-no-agent.md](10-codearts-no-agent.md)：浏览器 OAuth + 签名网关，
> 不需要 DPAPI、`state.vscdb` 或 `agentkernelServer.exe`。

华为云用的是 **`SDK-HMAC-SHA256`**，它的 CanonicalRequest 有两处**和官方文档不一致**
的实现细节（见下面 P17）。我按文档写出来的签名一直返回 `APIG.0301 Unauthorized`，
修正这两处后变成 400/401 —— 但还要复刻一整套 `x-ot-*` 身份头、DPoP 续期、PKCE，
成本已经超过「用现成的」。

判断依据：**当逆向成本超过复用成本时，停下来找现成实现。** 这一步省了两天。

## 架构

```
pi / opencode
    ↓ OpenAI /v1/chat/completions（Bearer sk-ca-...）
CodeArts2API（Go 单文件，:10087）
    ↓ SDK-HMAC-SHA256 + X-Security-Token
snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
    ↑
本机 IDE 的 state.vscdb（DPAPI + AES-GCM 加密的 AK/SK/STS + refresh_token）
```

网关直接读 `%APPDATA%\codearts-agent\User\globalStorage\state.vscdb` 里那条
`secret://{"extensionId":"huaweicloud.authentication","key":"HuaweiCloudSession"}`，
解密出 AK/SK/securitytoken/refresh_token，**过期时用 refresh_token + DPoP 自动续期，
并回写 state.vscdb**（IDE 下次启动直接复用新凭据）。

## 部署

源码已经在 `integrations/codearts2api`（Apache-2.0），二进制按许可证
构建后本地使用、不入库：

```bash
# 1. 构建（Go 1.22+，零第三方依赖）
cd integrations/codearts2api
go build -o codearts2api.exe .

# 2. 首次使用：优先复用 IDE 登录态；没有 IDE 就用浏览器 OAuth
./codearts2api.exe -import
cd ../..                    # 回到仓库根目录
node router.mjs login codearts

# 3. 常驻交给 router（它会带 -data/-port 参数）
node router.mjs up codearts
node router.mjs status
```

启动日志会显示续期结果：

```
账号 GT-demo 凭据已过期，尝试用 refresh_token 续期
账号 GT-demo 续期成功，新凭据有效期至 2026-11-04 01:05:41
账号 GT-demo 新凭据已回写 state.vscdb，IDE 下次启动可直接复用
```

## 接入 pi

签发 API 密钥（未签发时 `/v1/*` 只允许本机直连）：

```bash
curl -X POST http://127.0.0.1:10087/admin/api/keys -H 'Content-Type: application/json' \
  -d '{"name":"pi-opencode"}'
# → {"key":"sk-ca-...","ok":true}
```

写进 `~/.pi/agent/models.json`：

```jsonc
{
  "providers": {
    "codearts": {
      "baseUrl": "http://127.0.0.1:10087/v1",
      "name": "CodeArts Agent（华为云）",
      "api": "openai-completions",
      "apiKey": "sk-ca-...",
      // ★ 必须：pi 默认用 developer 角色，CodeArts 上游不认（见 P18）
      "compat": { "supportsDeveloperRole": false },
      "models": [ { "id": "deepseek-v4.1-flash", "reasoning": true, ... } ]
    }
  }
}
```

## 接入 opencode

`codearts` 已纳入 router，所以：

```bash
node router.mjs on codearts        # 只开 CodeArts，其余关掉
node router.mjs up codearts         # 按当前开关启动（不改变开关）
node router.mjs down codearts       # 停止
node router.mjs logs codearts 80    # 日志尾部
node router.mjs all                # 全开
```

重启和收尸都由 router 负责：它带
`-data integrations\codearts2api\codearts2api-data.json -port 10087`
启动，PID 记在 `<repo>\.run\processes.json`，停止时按 PID 树 + 端口双重清理。
router 还会从 `/v1/models` 拉目录并写进 `opencode.json`（带 `Authorization` 头，
签发密钥后列表接口也要鉴权）。

## 可用模型（2026-11 实测，13 个）

全部走**积分通道，真实扣费**（免费权益通道已于 2026-10 下线）。

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
| `Qwen3-VL-235B` / `kimi-k2.6-vl` | —（图片理解，无公布倍率）|

> ⚠️ **每个模型都真实扣积分**。控制台有「允许真实消耗积分」开关，关掉后 `/v1/*`
> 一律 403（只用于排障）。

## 已知上游限制

| 限制 | 表现 | 处理 |
|---|---|---|
| 每账号 3 个并发会话 | `TM.00001041 并发会话数已达上限(3个)` | 网关识别为临时故障，退避重试且**不熔断账号** |
| `glm-5.3` 只支持流式 | 非流式返回 400 + 空 body | 网关自动改用流式并在本地聚合，且记住该模型 |
| 不认 `developer` 角色 | `Message role cannot empty` | 客户端侧设 `supportsDeveloperRole: false`（P18） |

## 与其它几家的对比

| | Qoder | Trae | WorkBuddy | CodeArts |
|---|---|---|---|---|
| 协议 | COSY 私有 | OpenAI | OpenAI | OpenAI |
| 代理 | 本项目写的 JS | 第三方 | 第三方 Python wheel | 第三方 Go |
| 签名 | COSY（RSA+MD5） | — | — | **SDK-HMAC-SHA256** |
| 凭证 | PAT/设备授权 | 反代自管 | 浏览器登录 | **DPAPI 加密的 AK/SK/STS** |
| 续期 | openapi refresh | 反代 | 反代 | **DPoP + refresh_token** |
| 计费 | 积分（部分免费） | 免费 | 订阅 | **全部扣积分** |
| 并发 | 排队限流 | — | — | **每账号 3 会话** |

---

← [文档索引](README.md) ｜ 上一篇：[选择性启停（router）](07-selective.md) ｜ 下一篇：[反代进程生命周期（router 直管）](09-lifecycle.md)
