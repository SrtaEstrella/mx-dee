#!/usr/bin/env bash
# 构建 chat-demo 的静态产物。
#
# 上游 build 脚本是 `rm -rf dist && NODE_ENV=production rspack build -c rspack.config.ts`。
# pnpm 在 Windows 上用 cmd.exe 执行 package.json 的 scripts，因此 `pnpm build` 在
# PowerShell 与 Git Bash 下都会失败（cmd.exe 不认 `rm -rf`，也不认 `VAR=value cmd` 前缀）。
# 这里改用 `pnpm exec`，它不经 package script 执行器，由当前 bash 直接执行。
#
# 用法：
#   bash scripts/build.sh                                    # 连官方 API（上游默认）
#   DS_CHAT_API_ORIGIN=/api bash scripts/build.sh            # 连本地网关（见 server.mjs）
#
# Git Bash 会把以斜杠开头的环境变量值当路径转换（/api → C:/Program Files/Git/api），
# 传这类值时需要 MSYS_NO_PATHCONV=1：
#   MSYS_NO_PATHCONV=1 DS_CHAT_API_ORIGIN=/api bash scripts/build.sh

set -euo pipefail

# 脚本位于 scripts/，项目根目录是它的上一级
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
repo="$root/chat-demo"

if [ ! -d "$repo" ]; then
  echo "找不到 $repo" >&2
  echo "请先执行: git clone https://github.com/deepseek-ai/chat-demo.git" >&2
  exit 1
fi

cd "$repo"

if [ ! -d node_modules ]; then
  echo "未安装依赖，先执行 pnpm install ..."
  pnpm install
fi

echo "清理 dist ..."
rm -rf dist

echo "构建中 ..."
NODE_ENV=production pnpm exec rspack build -c rspack.config.ts

echo
echo "构建完成：$repo/dist"
if [ -f dist/index.html ]; then
  files="$(find dist -type f | wc -l | tr -d ' ')"
  size="$(du -sh dist | cut -f1)"
  echo "  文件数 $files / 体积 $size"
  echo "  注入的 API 地址 $(grep -o 'let [a-zA-Z]*="[^"]*",[a-zA-Z]*=`' dist/static/js/main.*.js 2>/dev/null | head -1 || echo '(未能读出)')"
  echo
  echo "启动："
  echo "  PowerShell  .\\scripts\\start.ps1   （会自动注入用户环境变量里的 Key）"
  echo "  Git Bash    ./scripts/start.sh"
fi
