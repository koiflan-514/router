# 新供应商接入排查清单

按顺序走。**每一步都有明确的「通过判据」，不要跳步**——跳过中间步骤会让你在最后
面对一个不知道哪层坏的结果。

## 阶段 0：先搞清楚「要不要写代理」

| 问题 | 判据 |
|---|---|
| 它说 OpenAI 吗？ | `curl <base>/v1/models` 能返回 `{data:[{id:...}]}` → 不用代理 |
| 只是 baseURL 不同吗？ | 换个 `baseUrl` 就能用 → 不用代理，只写配置 |
| 有私有签名/编码吗？ | 请求带 `Authorization: Bearer COSY.<a>.<b>`、body 不是明文 JSON → 要写代理 |

三种消费端形态：

- **pi**：原生扩展直接注册 provider（能吃私有协议）
- **opencode**：只会说 OpenAI，必须 OpenAI 兼容端点
- **其它客户端**（Cursor/Continue…）：同上

## 阶段 1：拿到一个能通的裸请求

**不要先写集成，先用 curl / 几十行脚本打穿一次。**

1. 从**官方客户端**或**现成反代**里找到凭证
2. 找到最小的对话请求（`messages: [{role:user, content:"hi"}]`）
3. 打通它，记录**完整可复现**的 curl 或脚本

通过判据：拿到 `200` 和一个真实的模型回复。

> 如果这一步过不了，后面所有工作都是猜。此时应该去读上游反代的源码，而不是继续试。

## 阶段 2：分清 401 与 403

| 码 | 含义 | 方向 |
|---|---|---|
| 401 | 凭证不对/过期 | 续期、重新登录、检查 token 类型 |
| 403 | 请求被拒（WAF/格式/签名） | 检查签名、编码、头族、端点字符串 |
| 400 + 业务码 | 业务层拒绝 | 读业务码（模型未授权/参数不合法/渠道校验） |
| 500 | 服务端解不出你的 body | 编码问题 |

**这一步能省掉一半时间。** 403 时不要碰凭证，401 时不要碰编码。

## 阶段 3：逐个消条件（关键手法）

当报错含糊（如「request illegal」），**不要一次补齐所有猜测**。逐个加，观察报错是否
变成更具体的下一个：

```
加 X-Conversation-*        → "first message is not system prompt"   ✓ 头生效了
再加 system prompt         → 200                                    ✓ 闸门在第二层
```

如果一次全加，你只会看到「还是 400」，无法判断哪个没生效。

## 阶段 4：确认清单的权威来源

接入后第一件事：**别信反代/网关自带的模型清单**。

| 来源可信度 | 说明 |
|---|---|
| 客户端落盘的产品配置 | 最准，是客户端真正在用的 |
| 网关的 model list 接口 | 准，但注意 `enable: false` |
| 反代自带的静态 json | 最不可信，可能是作者猜的 |

验证方法：拿 3~5 个 id 直接打对话接口，记录哪些 200、哪些报什么码。

## 阶段 5：一次接通两个消费端

| 端 | 怎么接 | 验证 |
|---|---|---|
| pi | 扩展 `registerProvider`，或 `models.json` | `pi --list-models \| grep <provider>` |
| opencode | 写 provider 到 `opencode.json` | `opencode models \| grep <provider>` |

**两端都要做「真实对话 + 工具调用」的验证**，不只是列模型：

```bash
pi --provider X --model Y -p "Say only: ok"
pi --provider X --model Y -p "Read <file> and tell me its contents"    # 验证工具调用
```

工具调用是最容易坏的一环（流式 tool_calls 的 id 重组、`index` 映射、`finish_reason`）。

## 阶段 5.5：登录态也要能自动补齐

新设备上最容易漏的是「反代能启动，但没有凭证」。把登录做成显式流程：

| 检查 | 判据 |
|---|---|
| 能判断「未登录」 | 读凭证文件而不是猜端口：Qoder `auth.json`、Trae `auths/`、CodeArts 账号池、WorkBuddy session |
| 登录会打开浏览器 | `router.mjs login <id>` 有明确 URL / 回调；失败时链接仍打印出来 |
| 非交互环境不会卡住 | 管道/计划任务只提示，不等待浏览器；用 `--login` 才强制 |
| 登录后凭证生效 | 正在跑的反代自动重启；`list` 的登录态和 `/v1/models` 都恢复 |

```bash
node E:/router/router.mjs login <id>
node E:/router/router.mjs list --json   # providers[].auth
```

## 阶段 6：做成常驻，并验证「跑的是新代码」

- 本机代理 → 加进 `router.mjs` 的 `PROVIDERS`，由 router 直接 spawn
- 启动命令、工作目录、环境变量、日志都写在 `processes` 里
- 如果仍走系统服务（launchd / systemd / 旧计划任务），注意服务定义通常**写死二进制
  路径** → 升级后必须重装服务
- 加一个「服务引用的版本 vs 当前应使用的版本」检查

验证判据：

```bash
node E:/router/router.mjs status        # PID、端口、模型数
node E:/router/router.mjs logs <id> 40  # 进程实际输出
```

不要只看磁盘上放了什么；要看进程实际加载的版本（旧计划任务用
`grep -o "<pkg>-[0-9.]*" <service-definition>` 或
`wmic process where "name='python.exe'" get commandline`）。

## 阶段 7：把判断依据写成代码

踩过的坑要变成**自动检查**，否则下一个人（或三个月后的你）会再踩一次：

| 坑 | 变什么检查 |
|---|---|
| 端点字符串影响头注入 | 测试断言端点必须是特定值 |
| 依赖最低版本 | 测试断言 wheel 版本 >= x.y.z |
| 服务跑旧二进制 | `status` 里比较版本并警告 |
| 模型表不可信 | 优先取可信来源，退路要明说 |
| 签到接口 404 vs 活动关闭 | 分成不同状态显示 |

## 反检查清单（这些是浪费时间的方向）

- ❌ 伪造设备指纹去调官方签到/对话接口 —— 风险高、随时失效，优先用现成反代
- ❌ 反复改 model id 试 500 —— 500 通常是 body 编码问题
- ❌ 403 时反复重登 —— 403 不是凭证问题
- ❌ 相信 `displayTips` 的字面意思 —— 它常把人引向错误方向
- ❌ 一次补齐所有猜测再测 —— 无法定位是哪个没生效
- ❌ 看磁盘上的版本判断「升级成功」 —— 要看进程加载的版本
