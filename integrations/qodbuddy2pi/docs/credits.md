# 积分与签到

在 pi 里一眼看到各家 AI 编程工具还剩多少额度、今天签到了没有。

```text
/credits              # 一张表：Qoder / Trae / WorkBuddy
/credits checkin      # 顺手把能签的都签了
/credits trae         # 只看某个来源
```

也可以直接问模型（它有一个 `credits` 工具）：

> 我还剩多少积分？今天签到领了吗？

## 装了什么

| 文件 | 位置 | 作用 |
|---|---|---|
| `assets/credits.ts` | `~/.pi/agent/extensions/qodbuddy2pi/index.ts` | pi 扩展：`/credits` 命令、`credits` 工具、状态栏余额 |
| `assets/quota.js` | `~/.pi/agent/extensions/qodbuddy2pi/quota.js` | 取数层，也被 `qoder2pi credits` 复用 |

安装器会把两者一起部署（`pi` 只认目录里的 `index.ts` 作入口，所以 `credits.ts`
装成 `index.ts`；扩展用 `createRequire` 加载同目录的 `quota.js`）。

命令行也能用同一份数据：

```bash
qoder2pi credits            # 余额与签到状态
qoder2pi credits checkin    # 签到
qoder2pi credits json       # JSON，适合脚本
qoder2pi credits cn         # 只看国内版
qoder2pi credits trae       # 只看 Trae
```

## 数据从哪来

这三家都没有公开的「查余额」API，但答案都在本地：

| 来源 | 怎么拿 | 为什么这样拿 |
|---|---|---|
| Qoder | 官方 openapi 的 `/api/v2/quota/usage`、`/api/v2/user/plan`、`/sash/api/v1/me/daily-check-in/*` | 凭证已经在 pi 的 `auth.json` 里，这些接口是纯 Bearer、不需要签名，也是 pi 扩展自己算 usage 用的同一个 |
| Trae | 本机 `trae2api` 反代的控制台 `/admin/api/credits` | 直接调官方要伪造设备指纹，风险不值得；反代已经处理了解密与指纹 |
| CodeArts | 本机 `codearts2api` 网关的 `/admin/api/credits`、`/admin/api/claim` | 华为云要 `SDK-HMAC-SHA256` 签名 + STS 续期，网关已经做了；它顺带给出总量/已用/剩余/到期日/即将过期 |
| WorkBuddy | 本机反代端口是否在跑 + `~/.codebuddy-session.json` 的到期时间 | WorkBuddy 的「余额」就是凭证还剩几天 |

**刻意不做的事**：不伪造设备身份、不解密客户端落盘的加密凭证、不改动任何登录态文件。
Trae 的每日签到因此只能提示你去反代控制台或客户端点——这是安全性上的取舍，
不是没做完。

Qoder 的签到是**真的会领**的：`/credits checkin` 会调官方的 claim 接口。已领过时
服务端返回 409，这里归一成「今日已签到」，不算失败；活动没开时什么都不发。

## 状态栏

pi 的 TUI 里，状态栏**只显示你当前正在用的那一家**：

```
CodeArts Agent 6599.09        ← 当前模型是 codearts/* 时
Trae 652                      ← 当前模型是 trae-local/* 时
Qoder 国内版 0                 ← 当前模型是 qoder-cn/* 时
```

为什么不是把所有家都堆上去：状态栏只有一行，而你此刻在用的只有一个。堆四五个数字
既挤又没用。「当前 provider」取自 `ctx.model.provider`（pi 的当前模型）；取不到时
退回第一个能查到余额的。

只在 `session_start` 时算一次：查余额要发网络请求，不该在每次渲染时跑。想看最新的
就 `/credits`。查不到时状态栏留空，不占地方也不误报。

## 输出长什么样

```text
积分余额与签到
────────────────────────────────────────────────
[Qoder 国内版] 加购额度 96/800 credits　（套餐 Free · 账号 01a12e31…）
  签到：该区域当前没有每日签到活动
[Qoder 国际版] 未登录（qoder2pi login 或 pi 里 /login）
[Trae（免费积分）] 1 个账号（2026-11-03 19:06:28）
  用户40793816282：剩 1078 / 共 1500 / 72% / 11 个权益包  ·  今日已签到
[CodeArts Agent] 1 个账号
  GT-demo：剩 6599.25 / 共 6600 / 体验版 / 即将过期 99.25 / 2026-11-24 重置
[WorkBuddy 国内版] 服务未运行（127.0.0.1:8787）且没有凭证文件
────────────────────────────────────────────────
可查 2 个来源　·　合计剩 1174 credits
```

查不到的来源会**显示原因**而不是静默省略——「未登录」和「服务没起」是两种不同的
问题，都需要用户去处理。

## 排错

**Qoder 显示未登录 / 凭证过期。** 重新登录即可，插件会自动用新凭证：

```bash
qoder2pi login cn pt-xxxxxx
```

**Qoder 说「该区域当前没有每日签到活动」。** 这是服务端的事实（`status: DISABLED`），
不是插件的问题。活动是否开放由 Qoder 决定，国内版与国际版各自独立。

**Qoder 国际版说「该区域没有签到接口」。** 国际站的 `/sash/api/v1/me/daily-check-in/*`
目前返回 404，活动只挂在网页里、没有可调用的领取接口。这与「活动未开放」是两件事，
所以分别显示。国内版有接口但当前活动是 DISABLED，因此显示的是「没有每日签到活动」。

**Qoder 国际版显示「额度已用尽」。** 免费账号的 `userQuota` 是 0 且
`isQuotaExceeded: true`，但部分模型（如 `Qwen3.8-Flash`）仍然可以调用——额度为 0
不等于不能用。插件会把这点写出来，避免被误读成「账号废了」。

**Trae 显示「没找到本机反代」。** 说明 `trae2api` 之类的东西没在跑，或者端口不是
常见的那几个。插件会先读 pi 的 `models.json` 里 trae 相关 provider 的 `baseUrl`，
再兜底试 7863–7866。

**Trae 的积分和我看到的不一样。** 数字来自本机反代的缓存，它有 `fetched_at`
时间戳。以客户端/官网为准。

**CodeArts 显示「本机网关未运行」。** 它依赖第三方 Go 网关 codearts2api（:10087），
本项目不负责启动它：

```bash
cd ~/codearts2api && ./codearts2api.exe -port 10087
```

**CodeArts 的积分是真实扣费的吗？** 是。免费权益通道 2026-10 已下线，所有模型按
`credit[].ratio_display` 倍率真实扣积分。`/credits` 里的「剩」就是还能用多少，
不是「还能领多少」。

**CodeArts 显示「即将过期 N」。** 那部分积分在 `reset_date` 那天会作废，建议先用掉。

**WorkBuddy 一直显示「服务未运行」。** 用 `workbuddy2pi` 装服务或起服务：

```bash
workbuddy2pi status
workbuddy2pi restart
```
