#!/usr/bin/env bash
# wine-run-app.sh — 用社区最佳实践启动 Windows-only 桌面端（Wine 版）。
#
# 支持的 app：
#   lingxi   WPS 灵犀   （登录态 → AppData\Roaming\WPS 灵犀）
#   lobster  有道龙虾   （登录态 → AppData\Roaming\LobsterAI）
#
# 为什么需要这些参数（每条都对应一个实测问题或社区文档）：
#
#   WINEDEBUG=-all                 Electron 会打几万行 fixme，格式化字符串有真实开销
#   NTSync                         Wine 10.16+ 默认；内核 6.14+ 有 /dev/ntsync。
#                                  **不要**再设 WINEESYNC/WINEFSYNC——那是旧方案，
#                                  且三者互斥（ArchWiki）。
#   DXVK_CONFIG_FILE               D3D→Vulkan；配置由 scripts/wine-tune.sh 生成
#   --disable-direct-composition   Chromium 用 DirectComposition 建交换链，
#                                  DXVK 未实现 CreateSwapChainForComposition → 不加会崩
#   FREETYPE_PROPERTIES            字更锐利（ArchWiki）
#
# 用法：
#   bash scripts/wine-run-app.sh lingxi
#   bash scripts/wine-run-app.sh lobster
#   bash scripts/wine-run-app.sh lingxi --wayland     # 强制 Wine 的 Wayland 驱动
#   bash scripts/wine-run-app.sh lingxi --no-dxvk     # 退回 Wine 内置 wined3d
#   bash scripts/wine-run-app.sh lingxi --hud         # 确认 DXVK 接管（日常别开）

set -euo pipefail

APP="${1:-lingxi}"
shift || true

PREFIX="${WINEPREFIX:-$HOME/.local/share/wineprefixes/lingxi}"
USE_DXVK=1
WAYLAND=0
HUD=""
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --no-dxvk) USE_DXVK=0; shift ;;
    --wayland) WAYLAND=1; shift ;;
    --hud) HUD="devinfo,api,memory,fps"; shift ;;
    --angle-gl) EXTRA+=(--use-angle=gl); shift ;;
    --angle-vulkan) EXTRA+=(--use-angle=vulkan); shift ;;
    --no-gpu) EXTRA+=(--disable-gpu); shift ;;
    --gpu-compositing-off) EXTRA+=(--disable-gpu-compositing); shift ;;
    -h|--help) sed -n '1,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

case "$APP" in
  lingxi)
    EXE='C:\users\'"${USER}"'\AppData\Local\Programs\lingxi-desktop\WPS 灵犀.exe'
    ;;
  lobster)
    EXE='C:\users\'"${USER}"'\AppData\Local\Programs\LobsterAI\LobsterAI.exe'
    ;;
  *)
    echo "未知 app: $APP（可选 lingxi / lobster）" >&2
    exit 2
    ;;
esac

# 基础渲染参数。两个都是实测必需的：
#
#   --disable-direct-composition   Chromium 用 DirectComposition 建交换链，
#                                  而 DXVK 没实现 CreateSwapChainForComposition →
#                                  不加会直接崩（DxgiFactory 报 Not implemented）
#
#   --disable-gpu-compositing      只关「显示合成器」，**保留 GPU 光栅**。
#                                  不加的话灵犀的页面会出现「背景模糊层在、
#                                  内容层不绘制」——看着像白屏/糊屏，但按钮仍能点
#                                  （命中测试走的是渲染树，不受合成影响）。
#                                  加上之后 GPU 光栅照常，合成退回软件路径，
#                                  内容就正常画出来了。
BASE_FLAGS=(--disable-direct-composition --disable-gpu-compositing)

export WINEPREFIX="$PREFIX"
export WINEDEBUG="${WINEDEBUG:--all}"

# 同步原语：有 NTSync 就交给它（Wine 默认行为），没有才退回 FSync。
# 两者互斥，所以是二选一而不是都设上。
if [ ! -e /dev/ntsync ]; then
  export WINEFSYNC=1
fi

export FREETYPE_PROPERTIES="${FREETYPE_PROPERTIES:-truetype:interpreter-version=35}"
export mesa_glthread=true

if [ "$USE_DXVK" = "1" ]; then
  [ -f "$PREFIX/dxvk.conf" ] && export DXVK_CONFIG_FILE="$PREFIX/dxvk.conf"
  [ -n "$HUD" ] && export DXVK_HUD="$HUD"
  if [ ! -f "$PREFIX/drive_c/windows/system32/d3d11.dll" ]; then
    echo "提示：DXVK 未安装，将使用 Wine 内置 wined3d（可能较卡）" >&2
  fi
fi

if [ "$WAYLAND" = "1" ]; then
  unset DISPLAY
  export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
fi

# Wine 下 Node 的 chmod 对 SQLite WAL 的 -shm 必返回 EBUSY，会让 openclaw
# 这类「开库后收紧权限」的应用启动失败。预加载 shim 把这类 EBUSY 降级为无操作
# （只影响权限位，Wine 下本就不生效）。必须在进程启动前用 --require 注入。
#
# 注意：龙虾的网关走 Electron 的 ELECTRON_RUN_AS_NODE 模式，会忽略 NODE_OPTIONS，
# 所以它还要额外跑 scripts/wine-patch-openclaw.mjs（wrapper + 动态 import）。
SHIM_DIR="$PREFIX/drive_c/router-shims"
SHIM="$SHIM_DIR/wine-node-shim.js"
if [ -f "$(dirname "${BASH_SOURCE[0]}")/wine-node-shim.js" ]; then
  mkdir -p "$SHIM_DIR"
  cp -n "$(dirname "${BASH_SOURCE[0]}")/wine-node-shim.js" "$SHIM"
  export NODE_OPTIONS="${NODE_OPTIONS:-} --require C:\\router-shims\\wine-node-shim.js"
fi

exec wine "$EXE" "${BASE_FLAGS[@]}" "${EXTRA[@]}"