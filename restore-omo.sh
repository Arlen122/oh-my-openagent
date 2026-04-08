#!/bin/bash
# 恢复原版 omo dist（从首次备份中还原）
# 用法: ./restore-omo.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_OMO="$HOME/.cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent"
BACKUP_DIR="$SCRIPT_DIR/.omo-dist-backup"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "错误: 没有找到备份 (.omo-dist-backup/)。"
  echo "请先运行一次 sync-to-opencode.sh，它会在首次运行时自动备份原版。"
  exit 1
fi

echo ">>> 还原原版 dist ..."
cp -r "$BACKUP_DIR/" "$CACHE_OMO/dist/"

echo ">>> 完成！重启 opencode 即可恢复原版 oh-my-openagent。"
