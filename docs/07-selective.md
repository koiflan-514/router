# 选择性启停（router）

> **适合**：想按需开关某几家、省内存，或避免同时跑太多反代。  
> **前置**：知道 `on/off/all/none` 会同时改开关、进程与客户端配置。  
> **相关**：[日常运维](05-operations.md) · [进程生命周期](09-lifecycle.md)

十三家反代全常驻会同时挂着 13 组进程。多数时候你只用一两个，所以 router 把「开哪几个」
变成一个显式选择，并且由 router 自己启动/停止进程（生命周期细节见
[09-lifecycle.md](09-lifecycle.md)）。

```bash
cd <repo>
node router.mjs list                # 看状态
node router.mjs on qoder-cn         # 只开 Qoder 国内版，其余关掉
node router.mjs off workbuddy       # 只关这一家，其余不动
node router.mjs all / none          # 全开 / 全关
node router.mjs restart trae-local   # 单独重启
node router.mjs logs codearts 80     # 看日志
```

## 一个开关要改三处

这是本命令存在的唯一理由。只改一处就会出现「以为关了其实还在跑」或「以为开了但客户端
看不到」：

| 层 | 不改会怎样 |
|---|---|
| **后端进程** | 内存白占，端口白开 |
| **opencode 的 provider** | 进程停了但配置还在 → 模型选择器里一堆点了报错的条目 |
| **pi 的可见性** | 由 provider 扩展决定，停服务后模型仍在列表里但请求失败 |

`on` / `off` / `all` / `none` 都是三处一起改的。

## 命令

| 命令 | 作用 |
|---|---|
| `list` / `status` | 表格：开关 / 进程 / PID / opencode / 端口 / 模型数，并提示不一致 |
| `on <id...>` | **只留这几家**，其余关掉（立刻生效） |
| `off <id...>` | 从当前开启的里面去掉这几家 |
| `all` / `none` | 全开 / 全关 |
| `up [id...]` | 按当前开关启动；带 id 只启动这几家（不改开关） |
| `down [id...]` | 停止；不带 id 停全部。`--keep-oc` 只停进程、保留 provider |
| `restart [id...]` | 重启；不带 id 重启当前开启的 |
| `logs <id> [行数]` | 看某家的日志尾部 |
| `reload` | down + up，用来「改完开关后重放」 |
| `sync` | 只同步 opencode 配置 |
| `doctor` | 自检命令、文件、端口、opencode |

供应商 id：`qoder-cn`、`qoder`、`trae-local`、`codearts`、`workbuddy`、
`workbuddy-global`。解析规则是**先精确匹配，再前缀匹配**；前缀命中多个会报歧义。
所以 `qoder` 现在指国际版，不会再被 `qoder-cn` 抢先匹配。

## Trae / CodeArts 也是 router 拉起

早期 Trae 和 CodeArts 被标成「外部服务」，router 只探活不启停。现在两家都有
`processes` 定义：

- Trae 是两段式：`tw2api`(:7864) → `img-proxy`(:7863)
- CodeArts 是单个 Go 网关：`codearts2api.exe`(:10087)

`up trae-local` / `up codearts` 会真正 spawn；`down` / `none` 会真正收进程。
Trae 如果还没在 opencode 里，router 会从 `/v1/models` 拉目录写一份；如果它在你自己
手写的 `opencode.jsonc` 里，router **不会改**那个文件（会把注释吃掉），而是提示你
手动注释。

## 状态存在哪

`<repo>\router.json`：

```json
{
  "enabled": ["qoder-cn", "trae-local"],
  "updatedAt": "2026-11-03T12:30:00.000Z"
}
```

没写过这个文件时默认**全开**——避免第一次用的人以为坏了。

运行时的 PID 不在这个文件里，而在 `<repo>\.run\processes.json`。它只是加速定位；
即使删掉，`down` 也会按监听端口找到进程。

## 常见组合

```bash
# 只想用 Qoder，省内存
node router.mjs on qoder-cn

# 写代码时用 WorkBuddy 双区域
node router.mjs on workbuddy workbuddy-global

# 临时全关（比如跑游戏）
node router.mjs none

# 恢复常规
node router.mjs all
```

## 踩到的三个坑（都会导致「关了但没关掉」）

### 1. uv 是三层链，从里往外杀无效

```
uv.exe  →  uv 缓存里的 builds python  →  真正的 cpython
```

只有最内层在监听端口，但**外层的 uv 会在子进程死掉后把它重新拉起来**。
所以必须把整条链（含 uv）一起收。router 现在记录外层 uv 的 PID，停止时先
`taskkill /T` 整棵树，再按端口找监听者兜底。

### 2. `.cmd` 的 keep-alive 会重启进程

旧版计划任务用 `:loop` + `timeout /t 15` 做保活。`schtasks /End` 之后那个 `timeout`
结束还会 `goto loop` 再拉起一次。router 直管后不再生成这种循环；启动前如果发现老任务
还在，会先 `/End` 它，避免两个实例抢端口。停止时仍然「杀 → 等端口真空 → 没空就再来
一轮」，因为旧任务留下的进程可能正好在重启窗口里。

### 3. 改了运维命令要确认调用的是哪份

router 的**启动/停止、`ocAdd`、浏览器登录**现在都优先用
`integrations/qodbuddy2pi/assets/` 里的源码，不再经过 `~/.local/bin`。只有你手工在
shell 里敲 `workbuddy2pi` / `qoder2pi` 时，才会用到安装副本：

```bash
cp integrations/qodbuddy2pi/assets/{workbuddy2pi,qoder2pi,quota.js,opencode-config.js,tui.js} ~/.local/bin/
```

这个坑排查了两轮才定位到——因为直接跑源码里的脚本是好的。现在判断依据是
`node router.mjs list` 显示的 PID 对应 CommandLine，而不是猜。

## 不动用户的文件

`opencode.jsonc` 通常是用户手写的、带注释的。共享模块 `opencode-config.js` 的约定：

- **写**：只写 `opencode.json`
- **读**：`.json` 与 `.jsonc` 都读（否则会误判「没配」而重复添加）
- **删**：只删 `.json` 里的；在 `.jsonc` 里的报给调用方，由用户自己处理

早期版本会重写 `.jsonc`，结果把 Trae 的配置从用户文件里挪走了、注释也丢了。已修。

---

← [文档索引](README.md) ｜ 上一篇：[怎么把这套经验套到新供应商](06-reuse.md) ｜ 下一篇：[CodeArts Agent（华为云码道）](08-codearts.md)
