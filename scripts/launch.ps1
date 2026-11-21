# Launch Mx. Dee: start the gateway in the background (if not already running),
# then open it in the browser. Started by MxDee.vbs, which hides the console.
#
# ASCII only: Windows PowerShell parses .ps1 files without a UTF-8 BOM as ANSI.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch.ps1
#   powershell ... -File scripts\launch.ps1 -Port 8317
#   powershell ... -File scripts\launch.ps1 -NoBrowser     # start only

param(
  [int]$Port = 0,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# 脚本位于 scripts\，项目根目录是它的上一级
$root = Split-Path -Parent $PSScriptRoot

# config/app.json 里的端口是界面可改的默认值，命令行参数优先
$appConfig = $null
try {
  $appConfig = Get-Content (Join-Path $root 'config\app.json') -Raw -ErrorAction Stop | ConvertFrom-Json
} catch {
  $appConfig = $null
}
if ($Port -le 0) {
  $Port = if ($appConfig -and $appConfig.port) { [int]$appConfig.port } else { 8090 }
}

$url = "http://127.0.0.1:$Port/"
$logDir = Join-Path $root 'logs'
$logOut = Join-Path $logDir 'gateway.log'
$logErr = Join-Path $logDir 'gateway.err.log'
$logLaunch = Join-Path $logDir 'launch.log'

function Write-LaunchLog([string]$Text) {
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    "[$(Get-Date -Format o)] $Text" | Out-File -FilePath $logLaunch -Encoding utf8 -Append
  } catch { }
}

function Show-Message([string]$Text) {
  Write-LaunchLog "MESSAGE: $Text"
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'Mx. Dee')
  } catch {
    Write-Host $Text
  }
}

function Open-Client {
  # 优先用 Chromium 的应用模式打开：独立窗口、没有地址栏，与覆盖式标题栏布局一致
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
  $candidates = @()
  foreach ($root in $roots) {
    $candidates += Join-Path $root 'Microsoft\Edge\Application\msedge.exe'
    $candidates += Join-Path $root 'Google\Chrome\Application\chrome.exe'
  }
  # 不按下标取：单元素管道结果会被当成字符串，$x[0] 会变成首字符
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) {
    Start-Process -FilePath $exe -ArgumentList "--app=$url"
    return
  }
  Start-Process $url
}

function Test-Gateway {
  try {
    $response = Invoke-WebRequest -Uri ($url + 'api/health') -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200 -and $response.Content -match '"ok"\s*:\s*true')
  } catch {
    return $false
  }
}

function Start-Gateway {
  if (Test-Gateway) {
    Write-LaunchLog 'gateway already running'
    return $true
  }

  $distIndex = Join-Path $root 'chat-demo\dist\index.html'
  if (-not (Test-Path $distIndex)) {
    Show-Message "Build output not found:`n$distIndex`n`nRun this first:`n  bash scripts/build.sh"
    return $false
  }

  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Show-Message 'node.exe not found on PATH.'
    return $false
  }

  # Keys missing from the process environment are taken from the User scope
  foreach ($name in @('DEEPSEEK_API_KEY', 'OCGO_API_KEY')) {
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
      $value = [Environment]::GetEnvironmentVariable($name, 'User')
      if ($value) { Set-Item -Path "env:$name" -Value $value }
    }
  }

  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

  Write-LaunchLog "starting $node server.mjs --port $Port"
  Start-Process -FilePath $node `
    -ArgumentList @((Join-Path $root 'server.mjs'), '--port', "$Port") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr | Out-Null

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Gateway) {
      Write-LaunchLog 'gateway ready'
      return $true
    }
  }

  $detail = ''
  if (Test-Path $logErr) { $detail = (Get-Content $logErr -Tail 15) -join "`n" }
  Show-Message "Gateway did not start on port $Port.`n`n$detail`n`nLogs: $logDir"
  return $false
}

try {
  if (Start-Gateway) {
    if (-not $NoBrowser) { Open-Client }
    exit 0
  }
  exit 1
} catch {
  Show-Message ("launch failed: " + $_.Exception.Message)
  exit 1
}
