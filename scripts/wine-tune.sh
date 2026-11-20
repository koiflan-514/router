#!/usr/bin/env bash
# wine-tune.sh — 按 Wine 社区当前的最佳实践调优一个 prefix（面向 Electron 桌面应用）。
#
# 每条设置都标了出处与理由，不做「玄学优化」。
#
# 用法：bash scripts/wine-tune.sh [prefix]
#
# 社区参考：
#   - ArchWiki/Wine（NTSync、DXVK、字体平滑、FREETYPE_PROPERTIES）
#   - DXVK wiki/Configuration（dxvk.conf 选项）
#   - Wine 10.16+ 起 NTSync 默认启用；Arch 的 wine-staging ≥11.14-2 自动加载模块

set -euo pipefail

PREFIX="${1:-${WINEPREFIX:-$HOME/.local/share/wineprefixes/lingxi}}"
export WINEPREFIX="$PREFIX"

if [ ! -d "$PREFIX/drive_c" ]; then
  echo "prefix 不存在：$PREFIX" >&2
  exit 1
fi

say() { printf '  %s\n' "$*"; }
reg() { wine reg add "$@" >/dev/null 2>&1 || true; }

echo "==> $PREFIX"

# ---------------------------------------------------------------- 1) 同步原语
#
# ArchWiki: 「Stick to NTSync unless an application behaves in a problematic way」
# 并明确写出 ESync/FSync 是 NTSync 之前的变通方案，Wine 官方不打算保留。
# Wine 10.16+ 默认启用 NTSync，所以**不要**再设 WINEESYNC/WINEFSYNC——
# 它们只会切回旧的用户态实现。
echo "==> 检查 NTSync"
if [ -e /dev/ntsync ]; then
  if lsmod | grep -q '^ntsync'; then
    say "NTSync 可用（/dev/ntsync + 模块已加载）→ 不设 esync/fsync"
  else
    say "有 /dev/ntsync 但模块没在 lsmod 里（可能已内建）"
  fi
else
  say "没有 /dev/ntsync：内核 <6.14，退回 WINEFSYNC=1（由启动脚本设置）"
fi

# ---------------------------------------------------------------- 2) CSMT
#
# ArchWiki: CSMT 自 Wine 3.2 起默认开启，把 OpenGL 调用放到独立线程。
# 只在使用 Wine 内置 wined3d 时有意义；用 DXVK 时不走这条路。
# 保留默认（1），需要时再改成 0。
reg 'HKEY_CURRENT_USER\Software\Wine\Direct3D' /v csmt /t REG_DWORD /d 1 /f
say "CSMT = 1（默认，供 wined3d 回退路径使用）"

# ---------------------------------------------------------------- 3) 字体渲染
#
# ArchWiki「Enable font smoothing」：打开 ClearType 次像素渲染（RGB），
# 这是 Windows 桌面端的默认观感，Wine 默认关闭，字会显得发虚/发灰。
reg 'HKEY_CURRENT_USER\Control Panel\Desktop' /v FontSmoothing /t REG_SZ /d 2 /f
reg 'HKEY_CURRENT_USER\Control Panel\Desktop' /v FontSmoothingType /t REG_DWORD /d 2 /f
reg 'HKEY_CURRENT_USER\Control Panel\Desktop' /v FontSmoothingOrientation /t REG_DWORD /d 1 /f
reg 'HKEY_CURRENT_USER\Control Panel\Desktop' /v FontSmoothingGamma /t REG_DWORD /d 1400 /f
say "ClearType 次像素平滑（RGB）= 开"

# DPI：1920x1200 @ scale 1 → 96 DPI，与 Wine 默认一致；显式写死免得被自动探测带偏
reg 'HKEY_CURRENT_USER\Control Panel\Desktop' /v LogPixels /t REG_DWORD /d 96 /f
say "LogPixels = 96（匹配 1x 缩放）"

# ---------------------------------------------------------------- 4) 杂项
#
# Wine 自带崩溃对话框会在应用崩时弹一个 Win32 窗口，挡住 Electron 自己的错误页。
reg 'HKEY_CURRENT_USER\Software\Wine\WineDbg' /v ShowCrashDialog /t REG_DWORD /d 0 /f
say "关闭 Wine 崩溃弹窗"

# 每次 wineboot 都会跑 winemenubuilder（往宿主菜单写 .desktop）。桌面应用不需要，
# 而且它在无 X 场景会报错拖慢启动。
reg 'HKEY_CURRENT_USER\Software\Wine\DllOverrides' /v winemenubuilder.exe /d '' /f
say "禁用 winemenubuilder"

# ---------------------------------------------------------------- 5) DXVK 配置
#
# 面向「桌面 UI」而不是游戏：要的是稳、无撕裂、少卡顿，不追求极限帧率。
# 出处：DXVK 仓库的 dxvk.conf 与 wiki/Configuration。
DXVK_CONF="$PREFIX/dxvk.conf"
cat > "$DXVK_CONF" <<'EOF'
# 由 scripts/wine-tune.sh 生成。DXVK 通过 DXVK_CONFIG_FILE 读取。

# 着色器编译线程数：0 = 按 CPU 核心自动。Chromium 的着色器很少，
# 手动开满反而抢 UI 线程，保持自动。
dxvk.numCompilerThreads = 0

# 把 D3D11 的管线编译拆成可缓存的阶段（需要驱动支持 VK_EXT_graphics_pipeline_library，
# Intel ANV 支持）。它显著降低「第一次打开某个界面」的卡顿。
dxvk.enableGraphicsPipelineLibrary = Auto

# D3D11 的屏障放宽：Intel 上能省不少同步开销。给桌面 UI 用，画面不会花
# （这条在游戏里可能出现渲染错误，UI 场景风险很低）。
d3d11.relaxedBarriers = True
d3d11.relaxedGraphicsBarriers = True

# 垂直同步：UI 有撕裂感很显眼，强制开。60Hz 屏正好。
dxgi.syncInterval = 1

# 撕裂优先还是低延迟优先：桌面窗口希望不撕裂
dxvk.tearFree = True

# 帧率不额外限制（跟随 vsync）
dxvk.maxFrameRate = 0

# 着色器状态缓存（默认开，写死在配置里便于确认）
dxvk.stateCache = True

# HUD 关掉（只用于调试）
dxvk.hud = ""

# 内存整理：桌面 UI 分配模式稳定，关掉省 CPU
dxvk.enableMemoryDefrag = False
EOF
say "写入 $DXVK_CONF"

echo
echo "完成。启动时用："
echo "  DXVK_CONFIG_FILE=$DXVK_CONF bash scripts/wine-run-lingxi.sh"
echo
echo "如需检查 DXVK 是否真的接管："
echo "  DXVK_HUD=devinfo,api,memory bash scripts/wine-run-lingxi.sh"