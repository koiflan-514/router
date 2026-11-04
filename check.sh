#!/usr/bin/env bash
# check.sh — 一键体检 + 全量验证（Windows 上用 Git Bash 跑）。
#
#   ./check.sh          体检 + pi/opencode 各 5 项
#   ./check.sh quick    只体检（不过真实对话，省额度）
#   ./check.sh tools    额外测工具调用

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-full}"

# opencode 不一定在 PATH 上（本机是 F:\OpenCode\opencode.exe）
if ! command -v opencode >/dev/null 2>&1; then
  for c in "/f/OpenCode/opencode.exe" "/c/Program Files/opencode/opencode.exe"; do
    [ -x "$c" ] && export OPENCODE_BIN="$c" && break
  done
fi

case "$MODE" in
  quick)
    node "$HERE/scripts/health.mjs" --no-probe
    ;;
  tools)
    node "$HERE/scripts/health.mjs"
    bash "$HERE/scripts/verify-all.sh" all
    bash "$HERE/scripts/verify-all.sh" tools
    ;;
  *)
    node "$HERE/scripts/health.mjs"
    bash "$HERE/scripts/verify-all.sh" all
    ;;
esac
