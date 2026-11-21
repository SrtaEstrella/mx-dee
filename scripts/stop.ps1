# Stop the Mx. Dee gateway started by launch.ps1.
#
# Only processes whose command line contains server.mjs are stopped; another
# program listening on the same port is left alone.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1
#         powershell ... -File stop.ps1 -Port 8317

param([int]$Port = 8090)

$ErrorActionPreference = 'Stop'

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$stopped = 0

foreach ($listener in $listeners) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -match 'server\.mjs') {
    Stop-Process -Id $listener.OwningProcess -Force
    Write-Host "Stopped Mx. Dee gateway (PID $($listener.OwningProcess))"
    $stopped++
  }
}

if ($stopped -eq 0) {
  Write-Host "No Mx. Dee gateway found on port $Port."
}
