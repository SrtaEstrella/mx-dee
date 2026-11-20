# Create Windows shortcuts for Profunda.
#
#   -Startup  also place a shortcut in the Startup folder, so the gateway is up
#             after logon and the installed PWA opens instantly.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
#   powershell ... -File scripts\make-shortcut.ps1 -Startup

param([switch]$Startup)

$ErrorActionPreference = 'Stop'

# 脚本位于 scripts\，项目根目录是它的上一级
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $PSScriptRoot 'Profunda.vbs'
$icon = Join-Path $root 'assets\profunda.ico'

if (-not (Test-Path $target)) { throw "Missing $target" }
if (-not (Test-Path $icon)) { throw "Missing $icon (run the icon generator first)" }

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut([string]$LinkPath) {
  $link = $shell.CreateShortcut($LinkPath)
  $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $link.Arguments = '"' + $target + '"'
  $link.WorkingDirectory = $root
  $link.IconLocation = $icon + ',0'
  $link.Description = 'Profunda - local chat client'
  $link.WindowStyle = 1
  $link.Save()
  Write-Host "Created $LinkPath"
}

New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Profunda.lnk')

if ($Startup) {
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Profunda.lnk')
  Write-Host 'The gateway will start automatically after logon.'
}
