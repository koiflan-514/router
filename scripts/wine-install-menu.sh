#!/usr/bin/env bash
# wine-install-menu.sh — 把 Wine 里的「WPS 灵犀」「有道龙虾」加入应用菜单。
#
# 做三件事：
#   1. 从各自安装目录取图标，缩到 256x256 放进 hicolor（.desktop 里用 Icon=名字）
#   2. 在 ~/.local/share/applications 写 .desktop（Exec 指向 wine-run-app.sh）
#   3. 刷新 desktop database
#
# 重装桌面端不会影响这里；只有 prefix 换了（比如删了重建）才需要重跑。
set -euo pipefail

PREFIX="${WINEPREFIX:-$HOME/.local/share/wineprefixes/lingxi}"
PROGRAMS="$PREFIX/drive_c/users/$(id -un)/AppData/Local/Programs"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/256x256/apps"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -d "$PROGRAMS" ] || { echo "找不到 $PROGRAMS（先装好桌面端）" >&2; exit 1; }
mkdir -p "$APPS" "$ICONS"

resize() {
  local src="$1" dst="$2"
  [ -f "$src" ] || { echo "缺图标：$src" >&2; return 1; }
  if command -v magick >/dev/null 2>&1; then
    magick "$src" -resize 256x256 "$dst"
  else
    cp "$src" "$dst"
  fi
}

resize "$PROGRAMS/lingxi-desktop/resources/icon.png" "$ICONS/lingxi.png"
resize "$PROGRAMS/LobsterAI/resources/app-icon/512x512.png" "$ICONS/lobsterai.png"

cat > "$APPS/lingxi.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=WPS 灵犀
Name[zh_CN]=WPS 灵犀
GenericName=AI 办公助手
Comment=WPS 灵犀桌面端（Wine 运行）
Exec=$REPO/scripts/wine-run-app.sh lingxi
Icon=lingxi
Terminal=false
Categories=Office;
Keywords=WPS;灵犀;AI;Wine;
StartupNotify=true
StartupWMClass=wps 灵犀.exe
EOF

cat > "$APPS/lobsterai.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=LobsterAI（有道龙虾）
Name[zh_CN]=LobsterAI（有道龙虾）
GenericName=AI 办公助手
Comment=有道龙虾桌面端（Wine 运行）
Exec=$REPO/scripts/wine-run-app.sh lobster
Icon=lobsterai
Terminal=false
Categories=Office;
Keywords=LobsterAI;有道;龙虾;AI;Wine;
StartupNotify=true
StartupWMClass=lobsterai.exe
EOF

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPS/lingxi.desktop" "$APPS/lobsterai.desktop"
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true

echo "已加入应用菜单："
echo "  WPS 灵犀          → $APPS/lingxi.desktop"
echo "  LobsterAI（龙虾） → $APPS/lobsterai.desktop"