# Start the Profunda gateway (static site + dual-track API router).
#
# DEEPSEEK_API_KEY / OCGO_API_KEY live only in the "User" environment scope, and
# shells launched from DSH do not inherit them. This script reads them from that
# scope and injects them into the child process; nothing is written to disk.
#
# Kept ASCII-only: a .ps1 without a UTF-8 BOM is parsed as ANSI by Windows
# PowerShell, which corrupts non-ASCII string literals.
#
# Usage:
#   .\scripts\start.ps1                  # 127.0.0.1:8090
#   .\scripts\start.ps1 -Port 8317
#   .\scripts\start.ps1 -Route ocgo      # force everything to OpenCode Go
#   .\scripts\start.ps1 -Route official  # force everything to the official API

param(
  [int]$Port = 0,
  [string]$Route = 'auto',
  [string]$Root = 'chat-demo/dist'
)

$ErrorActionPreference = 'Stop'
# 脚本位于 scripts\，切到项目根目录再启动
Set-Location (Split-Path -Parent $PSScriptRoot)

function Resolve-Key([string]$Name) {
  $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'User') }
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'Machine') }
  return $v
}

foreach ($name in @('DEEPSEEK_API_KEY', 'OCGO_API_KEY')) {
  $v = Resolve-Key $name
  if ($v) {
    Set-Item -Path "env:$name" -Value $v
    Write-Host ("  {0,-18} OK (len={1})" -f $name, $v.Length)
  } else {
    Write-Host ("  {0,-18} MISSING - that track will be unavailable" -f $name) -ForegroundColor Yellow
  }
}

if (-not (Test-Path $Root)) {
  Write-Host ("Build output not found: {0}" -f $Root) -ForegroundColor Red
  Write-Host "Run first:  bash scripts/build.sh" -ForegroundColor Red
  exit 1
}

Write-Host ""
# 未指定 -Port 时不传该参数，由服务端读 config/app.json 里的端口
$nodeArgs = @('--root', $Root, '--route', $Route)
if ($Port -gt 0) {
  $nodeArgs = @('--port', $Port) + $nodeArgs
}
node server.mjs @nodeArgs
