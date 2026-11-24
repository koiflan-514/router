# raccoon2api — 商汤小浣熊（Raccoon Work）的 OpenAI 兼容反代

本仓库自写，零依赖（只用 `node:` 内建模块），单文件 `raccoon-proxy.js`。

## 为什么几乎不用转换

桌面端 box-agent 的 `config.yaml` 里写着：

```yaml
provider: "openai"
api_base: "https://xiaohuanxiong.com/api/web/llm/v2"
model: "raccoon-090dd3"
```

也就是说**上游本来就吐 OpenAI 格式**，连 `reasoning_content` 和流式 `tool_calls`
的增量形状都与 OpenAI 一致。所以这个代理只做四件事：

1. 读桌面端落盘的 IAM token（`~/.office-raccoon/agent/config/auth.json`）；
2. `/v1/chat/completions` 原样透传到上游 `/chat/completions`（不改 body）；
3. `model_catalog` → `/v1/models`（含逐模型倍率、vision/reasoning 标记）；
4. `points/v1/balance` → `/v1/quota`（积分余额）。

## 端点

| 本机 | 上游 | 说明 |
|---|---|---|
| `GET /health` | — | 进程与登录态（不输出 token，只给到期时间） |
| `GET /v1/models` | `GET /api/web/llm/v2/model_catalog` | `?refresh=1` 跳过缓存 |
| `POST /v1/chat/completions` | `POST /api/web/llm/v2/chat/completions` | 原样透传 |
| `POST /v1/images/generations` | `POST /api/web/llm/v2/images/gen` | 返回 `b64_json`，约 20–30 秒 |
| `GET /v1/quota` | `GET /api/web/points/v1/balance` | 积分 + 倍率（别名 `/v1/credits`） |

其余 `/v1/*` 一律去掉 `/v1` 前缀后透传到 `api/web/llm/v2/*`。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `RACCOON_PORT` / `--port` | `8793` | 监听端口 |
| `RACCOON_HOST` | `127.0.0.1` | 监听地址（只绑回环） |
| `RACCOON_AUTH_FILE` | 自动探测 | 显式指定 auth.json |
| `RACCOON_ACCESS_TOKEN` | — | 直接给 token（不落盘） |
| `RACCOON_UPSTREAM_BASE` | `https://xiaohuanxiong.com/api/web/llm/v2` | 上游根地址 |
| `RACCOON_CHAT_TIMEOUT_MS` | `1200000` | 对话超时（20 分钟） |
| `RACCOON_CACHE_MS` | `60000` | 模型目录缓存 |

## 运行

```bash
node integrations/raccoon2api/raccoon-proxy.js            # 127.0.0.1:8793
node integrations/raccoon2api/raccoon-proxy.js --port 8793
```

router 里的用法：

```bash
node router.mjs up raccoon
node router.mjs login raccoon      # 拉起桌面端并等它写回 token
node router.mjs account raccoon
node router.mjs logs raccoon 80
```

## 已知行为

- **未知模型 id 不报错**：上游会静默回落到默认模型 `raccoon-090dd3`。所以模型名
  写错时表现是「答得像另一个模型」，不是 404。
- **`visible: false` 的模型也能调**：`raccoon-090dd3` / `raccoon-19b265` /
  `raccoon-405a1c` 在目录里是隐藏的，但桌面端默认就用第一个。
- **生图不能走 chat/completions**：走 `/v1/images/generations`。
- **token 30 天**：IAM JWT 由桌面端自动 refresh；反代只读文件，不写回。

---

← 返回 [integrations 索引](../README.md) ｜ [文档索引](../../docs/README.md)
