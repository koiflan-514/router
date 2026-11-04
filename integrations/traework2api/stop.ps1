#!/usr/bin/env pwsh
# stop.ps1 — 停止 start.ps1 启动的 tw2api 与 img-proxy
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunDir = Join-Path $Root '.run'

foreach ($name in @('img-proxy', 'tw2api')) {
  $pidFile = Join-Path $RunDir "$name.pid"
  if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile | Select-Object -First 1
    try {
      Stop-Process -Id ([int]$procId) -Force -ErrorAction Stop
      Write-Host "[stop] 已停止 $name (PID $procId)"
    } catch {
      Write-Host "[stop] $name (PID $procId) 已不在运行"
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}
