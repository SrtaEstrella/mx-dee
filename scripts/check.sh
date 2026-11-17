#!/usr/bin/env bash
# 类型检查 + 构建，改完前端代码后跑一次。
#
# 用法：
#   bash scripts/check.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root" || exit 1

echo "=== 类型检查 ==="
if (cd chat-demo && npx tsc -p tsconfig.json --noEmit); then
  echo "  ✓ 通过"
else
  echo "  ✗ 失败"
  exit 1
fi

echo
echo "=== 构建 ==="
MSYS_NO_PATHCONV=1 DS_CHAT_API_ORIGIN=/api bash "$here/build.sh" 2>&1 | head -5
