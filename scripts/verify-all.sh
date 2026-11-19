#!/usr/bin/env bash
# verify-all.sh — 九个 provider × 两个客户端全量实测（ZCode 未列入默认配对）。
#
# 只发极短的请求（"Say only: ok"），成本可忽略；但能覆盖最容易坏的一环：
# 端到端 → 协议转换 → 凭证 → 模型 id 是否真的存在。
#
#   ./verify-all.sh            # 全部
#   ./verify-all.sh pi         # 只测 pi
#   ./verify-all.sh opencode   # 只测 opencode
#   ./verify-all.sh tools      # 只测工具调用（最慢但最有用）
#
# 需要：pi、opencode 在 PATH 上（opencode 可用 OPENCODE_BIN 指定）。

set -uo pipefail

WHICH="${1:-all}"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
PASS=0
FAIL=0
FAILED_NAMES=()

# provider:model 配对。换默认模型就改这里。
PAIRS=(
  "codearts:deepseek-v4.1-flash"
  "qoder-cn:Qwen3.8-Flash"
  "qoder:Qwen3.8-Flash"
  "trae-local:glm-5.3-flash"
  "workbuddy:deepseek-v4-flash"
  "workbuddy-global:deepseek-v4.1-flash"
  "loomy:spark-x2.6"
  "raccoon:sn-glm-5-3-flash"
  "qwenwork:qwen4-max"
)

GREEN=$'\033[1;32m'
RED=$'\033[1;31m'
YELLOW=$'\033[1;33m'
DIM=$'\033[2m'
RST=$'\033[0m'

ok()  { printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; PASS=$((PASS+1)); }
bad() { printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); }
note() { printf '%s       %s%s\n' "$DIM" "$1" "$RST"; }

# 跑一次并判断是否成功。
#
# 对「排队中」（code 10605 / isQueued）重试一次：那是免费账号的并发上限，
# 隔十几秒再发通常就成功，不该报成失败（见 docs/02-pitfalls.md P16）。
run_check() {
  local label="$1"
  shift
  local out=""
  local attempt

  # 排队重试给 4 次：Qoder 国际版（免费号额度为 0）实测约 1/4 概率能排上，
  # 两次往往不够，会把「能用」误报成「坏了」。
  for attempt in 1 2 3 4; do
    out="$("$@" 2>&1 | tail -n 3)"
    if printf '%s' "$out" | grep -qiE '\bok\b|pong'; then
      ok "$label"
      return 0
    fi
    # 只有排队才值得重试；其它错误重试也是白等
    if printf '%s' "$out" | grep -qE '10605|isQueued'; then
      note "$label：排队中（第 ${attempt} 次），20 秒后重试"
      sleep 20
      continue
    fi
    break
  done

  bad "$label"
  note "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
  return 1
}

echo "AI 路由全量验证"
echo "──────────────────────────────────────────────"

if [ "$WHICH" = "all" ] || [ "$WHICH" = "pi" ]; then
  echo "[pi]"
  for pair in "${PAIRS[@]}"; do
    p="${pair%%:*}"
    m="${pair##*:}"
    run_check "pi $p/$m" pi --provider "$p" --model "$m" --no-session -p "Say only: ok"
  done
fi

if [ "$WHICH" = "all" ] || [ "$WHICH" = "opencode" ]; then
  echo "[opencode]"
  for pair in "${PAIRS[@]}"; do
    p="${pair%%:*}"
    m="${pair##*:}"
    run_check "opencode $p/$m" "$OPENCODE_BIN" run -m "$p/$m" "Say only: ok"
  done
fi

if [ "$WHICH" = "tools" ]; then
  echo "[工具调用]"
  tmpdir="$(mktemp -d)"
  printf 'hello from router\n' >"$tmpdir/probe.txt"
  for pair in "${PAIRS[@]}"; do
    p="${pair%%:*}"
    m="${pair##*:}"
    # 不要在管道里 tail：opencode 输出行数不定，截断后可能切掉要找的那行
    out="$(cd "$tmpdir" && "$OPENCODE_BIN" run -m "$p/$m" "Read probe.txt and reply with its exact contents" 2>&1)"
    if printf '%s' "$out" | grep -q 'hello from router'; then
      ok "tools $p/$m"
    else
      bad "tools $p/$m"
    fi
  done
  rm -rf "$tmpdir"
fi

echo "──────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf '%s全部通过%s（%d 项）\n' "$GREEN" "$RST" "$PASS"
  exit 0
fi
printf '%s%d 通过，%d 失败%s\n' "$YELLOW" "$PASS" "$FAIL" "$RST"
for n in "${FAILED_NAMES[@]}"; do printf '  失败：%s\n' "$n"; done
cat <<'TIP'

排查顺序（见 docs/04-checklist.md）：
  1. 先跑 node scripts/health.mjs --no-probe   看端口与凭证
  2. 再跑 node scripts/health.mjs               看端到端试打
  3. 两者都过但这里失败 → 问题在客户端配置（provider/模型 id 写错、配置没生效）
  4. 错误码 10605/isQueued → 排队限流，等一下重试（P16）
TIP
exit 1
