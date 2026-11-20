#!/usr/bin/env bash
# wine-run-lingxi.sh — 兼容入口，等价于 `wine-run-app.sh lingxi`。
#
# 逻辑都在 wine-run-app.sh（两个应用共用同一套参数与理由），这里只做转发，
# 避免两份脚本慢慢漂移。
exec bash "$(dirname "${BASH_SOURCE[0]}")/wine-run-app.sh" lingxi "$@"