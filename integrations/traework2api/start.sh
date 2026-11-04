#!/usr/bin/env bash
# start.sh — TRAE 免费积分代理：依赖自检 + 启动 + 日志
# 用法:
#   ./start.sh          启动（若 7864 已被占用则直接退出，不重复启动）
# 说明:
#   - 自检 pi-ai 的 openai 依赖（App 升级会覆盖，缺失时自动补装）
#   - 以 nohup 方式后台运行，日志写到 tw2api.log
#   - 配合 ~/Library/LaunchAgents/com.traework2api.plist 实现登录自启 + 崩溃自愈
set -uo pipefail
cd "$(dirname "$0")" || exit 1

PORT=7864
LOG="$PWD/tw2api.log"
NODE_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node/bin/node"

# ─── 0. 端口占用检查：已有实例直接退出（launchd SuccessfulExit=false 不会重启它）───
if lsof -iTCP:$PORT -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  echo "[start] 端口 $PORT 已被占用，已有代理实例在运行，退出"
  exit 0
fi

# ─── 1. 依赖自检：pi-ai 的 openai 包缺失时自动补装 ───
if [ ! -d "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/host/node_modules/@earendil-works/pi-ai/node_modules/openai" ]; then
  echo "[start] openai 依赖缺失，开始补装（可能需数十秒，仅首次/App升级后）..."
  if [ -x "$NODE_BIN" ]; then
    "$NODE_BIN" "$PWD/ensure-deps.js" >> "$LOG" 2>&1 || echo "[start] 依赖补装失败，查看 $LOG"
  else
    NODE_BIN=$(command -v node || true)
    if [ -n "$NODE_BIN" ]; then
      "$NODE_BIN" "$PWD/ensure-deps.js" >> "$LOG" 2>&1 || echo "[start] 依赖补装失败，查看 $LOG"
    else
      echo "[start] 找不到 node，跳过依赖自检（trae-local 调用可能失败）"
    fi
  fi
else
  echo "[start] openai 依赖正常"
fi

# ─── 2. 取 API Key 并启动 ───
KEY=""
if [ -f "$PWD/.env.local" ]; then
  KEY=$(grep -o 'TW2A_API_KEY=.*' "$PWD/.env.local" | head -1 | cut -d= -f2)
fi
if [ -z "$KEY" ]; then
  echo "[start] 错误：.env.local 里没有 TW2A_API_KEY"
  exit 1
fi

echo "[start] 启动 traework2api 监听 127.0.0.1:$PORT ..."

# launchd 托管模式（plist 设置 LAUNCHD=1）：exec 前台运行，
# 让 launchd 直接管理 tw2api 进程（崩溃自动拉起，见 KeepAlive）。
if [ "${LAUNCHD:-0}" = "1" ]; then
  exec env TW2A_API_KEY="$KEY" "$PWD/tw2api" >> "$LOG" 2>&1
fi

# 手动模式：nohup 后台运行
export TW2A_API_KEY="$KEY"
nohup "$PWD/tw2api" >> "$LOG" 2>&1 &

# ─── 3. 等待健康检查 ───
for i in $(seq 1 20); do
  if curl -s --max-time 2 http://127.0.0.1:$PORT/healthz 2>/dev/null | grep -q ok; then
    echo "[start] 代理已就绪 (healthz ok)"
    exit 0
  fi
  sleep 1
done
echo "[start] 警告：20 秒内 healthz 未通过，检查 $LOG"
exit 0
