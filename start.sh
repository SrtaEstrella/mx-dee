#!/usr/bin/env bash
# 启动 DS-Chat 网关
#
# Git Bash / WSL 会继承 Windows 用户环境变量，可直接读到 Key。
# DSH 内启动的 shell 不继承密钥变量，那种环境下用 start.ps1。
#
# 用法：
#   ./start.sh                 # 默认 127.0.0.1:8090
#   ./start.sh --port 8317
#   ./start.sh --route ocgo

set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here" || exit 1

missing=0
for name in DEEPSEEK_API_KEY OCGO_API_KEY; do
  val="${!name:-}"
  if [ -n "$val" ]; then
    echo "  $name 已就绪 (len=${#val})"
  else
    echo "  $name 未设置 —— 该轨道将不可用" >&2
    missing=1
  fi
done

if [ ! -d "chat-demo/dist" ]; then
  echo "找不到 chat-demo/dist，请先执行: bash build.sh" >&2
  exit 1
fi

[ "$missing" -eq 1 ] && echo "提示：DSH 内的 shell 会过滤密钥，请改用 PowerShell 运行 start.ps1" >&2

echo
exec node server.mjs "$@"
