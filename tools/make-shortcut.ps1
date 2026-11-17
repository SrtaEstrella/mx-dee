# Create Windows shortcuts for DS-Chat.
#
#   -Startup  also place a shortcut in the Startup folder, so the gateway is up
#             after logon and the installed PWA opens instantly.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
#   powershell ... -File tools\make-shortcut.ps1 -Startup

param([switch]$Startup)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'DS-Chat.vbs'
$icon = Join-Path $root 'assets\ds-chat.ico'

if (-not (Test-Path $target)) { throw "Missing $target" }
if (-not (Test-Path $icon)) { throw "Missing $icon (run the icon generator first)" }

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut([string]$LinkPath) {
  $link = $shell.CreateShortcut($LinkPath)
  $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $link.Arguments = '"' + $target + '"'
  $link.WorkingDirectory = $root
  $link.IconLocation = $icon + ',0'
  $link.Description = 'DS-Chat - local DeepSeek web client'
  $link.WindowStyle = 1
  $link.Save()
  Write-Host "Created $LinkPath"
}

New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DS-Chat.lnk')

if ($Startup) {
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'DS-Chat.lnk')
  Write-Host 'The gateway will start automatically after logon.'
}
