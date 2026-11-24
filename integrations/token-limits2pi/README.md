# token-limits2pi

pi 版的「上下文 / 输出限额 + 自动压缩」扩展，对应 opencode 的
`~/.config/opencode/plugins/token-limits/`。

- 默认所有模型：上下文 **300k**、输出 **32k**
- 压缩阈值与 opencode 一致：`context - max(16k, 15% × context)`（300k → 255k）
- 覆盖值存在 `~/.pi/agent/token-limits.json`，重启仍在
- 输出上限在 `before_provider_request` 里兜底；上下文在 `turn_end` 检查后调用
  pi 原生 `ctx.compact()`

## 安装

```bash
node router.mjs pi install --limits     # 只装这个扩展
node router.mjs pi install --force      # 重装全部 pi 扩展
node router.mjs pi sync                 # 刷新模型表 + 部署扩展
```

装到 `~/.pi/agent/extensions/token-limits/index.ts`。

## 命令

```text
/limits                       # 当前模型生效值与压缩阈值
/limits 200k 16k              # 当前模型
/limits provider 300k 32k     # 当前供应商的所有模型
/limits all 300k 32k          # 默认值（所有模型，含以后新增的）
/limits reset                 # 当前模型回默认
/limits reset all             # 清空所有单项覆盖
```

`scripts/lib/pi-sync.mjs` 在写 `~/.pi/agent/models.json` 时会统一补
`contextWindow: 300000` / `maxTokens: 32000`；扩展直连的 Qoder / WorkBuddy
模型用 `models.json` 的 `modelOverrides` 套同一组值，所以 `pi --list-models`
里也是 300K / 32K。