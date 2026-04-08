#!/bin/bash
# 把 omo-src 构建产物同步到 opencode 缓存，让修改立即生效
# 首次运行会自动备份原版 dist
# 用法: ./sync-to-opencode.sh [--build]  (加 --build 参数会先重新构建)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OMO_SRC="$SCRIPT_DIR/omo-src"
CACHE_OMO="$HOME/.cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent"
BACKUP_DIR="$SCRIPT_DIR/.omo-dist-backup"

if [ ! -d "$CACHE_OMO" ]; then
  echo "错误: opencode 缓存不存在: $CACHE_OMO"
  echo "请先启动一次 opencode 让它自动安装插件。"
  exit 1
fi

# 首次运行时备份原版 dist
if [ ! -d "$BACKUP_DIR" ]; then
  echo ">>> 首次运行，备份原版 dist 到 .omo-dist-backup/ ..."
  cp -r "$CACHE_OMO/dist" "$BACKUP_DIR"
  echo "    备份完成，之后可随时用 restore-omo.sh 恢复。"
fi

# 可选：重新构建
if [ "$1" = "--build" ]; then
  echo ">>> 重新构建 omo-src ..."
  cd "$OMO_SRC"
  bun run build
fi

echo ">>> 同步 omo-src/dist/ → opencode 缓存 ..."
cp -r "$OMO_SRC/dist/" "$CACHE_OMO/dist/"

echo ">>> 完成！重启 opencode 即可生效（源码构建版）。"
