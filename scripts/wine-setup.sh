#!/usr/bin/env bash
# wine-setup.sh — 给 Windows-only 桌面端准备一个可用的 Wine prefix。
#
# 为什么需要它：商汤小浣熊、WPS 灵犀、有道龙虾里有几家的 Linux 方案缺失或不可靠，
# 官方只发 Windows 包。要让反代拿到登录态，必须在 Linux 上把桌面端跑起来。
#
# 这个脚本做三件事（都是实测踩过的坑）：
#   1. 建专用 prefix（不污染 ~/.wine，可整目录备份）
#   2. 灌字体：Windows Server 默认缺中日韩字体，中文全是方框
#   3. 修 FontLink：Wine 预置的回退链引用了 Meiryo/Mincho/Batang 这些
#      Server 版没有的字体，回退断在半路
#
# 用法：
#   bash scripts/wine-setup.sh                 # 用默认 prefix
#   WINEPREFIX=/path/to/prefix bash scripts/wine-setup.sh
#   bash scripts/wine-setup.sh --fonts-from "/run/media/$USER/Windows/Windows/Fonts"
#
# 依赖：wine（wine-staging 即可）、fontconfig（fc-scan）、node

set -euo pipefail

PREFIX="${WINEPREFIX:-$HOME/.local/share/wineprefixes/lingxi}"
FONT_SRC=""
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --fonts-from) FONT_SRC="$2"; shift 2 ;;
    -h|--help) sed -n '1,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少依赖：$1" >&2; exit 1; }; }
need wine
need node

# 找一个能读字体的 Windows 分区
if [ -z "$FONT_SRC" ]; then
  for cand in /run/media/*/*/Windows/Fonts /mnt/*/Windows/Fonts /media/*/*/Windows/Fonts; do
    [ -d "$cand" ] && { FONT_SRC="$cand"; break; }
  done
fi

echo "==> prefix: $PREFIX"
export WINEPREFIX="$PREFIX"
mkdir -p "$PREFIX"

# 1) 初始化 prefix（已存在则升级）
echo "==> 初始化 Wine prefix"
wineboot -u >/dev/null 2>&1 || true
wineserver -w || true

# 2) 灌字体
FONT_DST="$PREFIX/drive_c/windows/Fonts"
mkdir -p "$FONT_DST"
if [ -n "$FONT_SRC" ] && [ -d "$FONT_SRC" ]; then
  echo "==> 复制字体：$FONT_SRC"
  cp -n "$FONT_SRC"/*.ttf "$FONT_SRC"/*.ttc "$FONT_SRC"/*.otf "$FONT_DST"/ 2>/dev/null || true
  echo "    得到 $(ls "$FONT_DST" | grep -ciE '\.(ttf|ttc|otf)$') 个字体文件"
else
  echo "!! 没找到 Windows 字体目录，跳过（中文会显示成方框）"
  echo "   用 --fonts-from /path/to/Windows/Fonts 指定"
fi

# 3) 补中日韩回退字体（Noto CJK 通常随系统已装）
for f in /usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc \
         /usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc; do
  [ -f "$f" ] && cp -n "$f" "$FONT_DST/$(basename "$f" | tr 'A-Z' 'a-z')" 2>/dev/null || true
done
# FontLink 里引用的是大写文件名，补一份同名的
if [ -f "$FONT_DST/notosanscjk.ttc" ]; then
  cp -n "$FONT_DST/notosanscjk.ttc" "$FONT_DST/NOTOSANSCJK.TTC" 2>/dev/null || true
fi
if [ -f "$FONT_DST/notoserifcjk.ttc" ]; then
  cp -n "$FONT_DST/notoserifcjk.ttc" "$FONT_DST/NOTOSERIFCJK.TTC" 2>/dev/null || true
fi

# 4) 生成并导入字体注册表
echo "==> 生成字体注册表"
node "$HERE/fonts-register.mjs" "$PREFIX"
REG_PATH="$PREFIX/drive_c/router-installers/fonts.reg"
if [ -f "$REG_PATH" ]; then
  wine regedit /S "$(echo "$REG_PATH" | sed "s|$PREFIX/drive_c|C:|; s|/|\\\\|g")" >/dev/null 2>&1 || true
  echo "    已导入"
fi

# 5) 修 FontLink 里指向不存在字体的条目
echo "==> 修正 FontLink"
wineserver -k >/dev/null 2>&1 || true
node "$HERE/fontlink-fix.mjs" "$PREFIX"

# 6) 自检
echo "==> 自检"
node "$HERE/fontlink-check.mjs" "$PREFIX"
node "$HERE/fonts-verify.mjs" "$PREFIX" || true

echo
echo "完成。prefix = $PREFIX"
echo "装桌面端示例："
echo "  WINEPREFIX=$PREFIX wine /path/to/setup.exe"
echo "让 router 用它：export WINEPREFIX=$PREFIX"