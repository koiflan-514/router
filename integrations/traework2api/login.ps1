#!/usr/bin/env pwsh
# login.ps1 — Windows 浏览器登录 Trae，自动回调 18080 并落盘 auths/
# 前置: 先运行 .\start.ps1
# 用法: pwsh -File .\login.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Get-DotEnvValue([string]$Name) {
  $file = Join-Path $Root '.env.local'
  if (-not (Test-Path $file)) { return '' }
  foreach ($line in Get-Content $file) {
    $t = $line.Trim()
    if ($t -and -not $t.StartsWith('#') -and $t.Contains('=')) {
      $i = $t.IndexOf('=')
      if ($t.Substring(0, $i).Trim() -eq $Name) {
        return $t.Substring($i + 1).Trim().Trim('"').Trim("'")
      }
    }
  }
  return ''
}

$Key = Get-DotEnvValue 'TW2A_API_KEY'
if (-not $Key) { throw '缺少 .env.local 的 TW2A_API_KEY' }

try {
  $null = Invoke-WebRequest -Uri 'http://127.0.0.1:7864/healthz' -UseBasicParsing -TimeoutSec 3
} catch {
  throw 'tw2api 未启动，请先运行 .\start.ps1'
}

$headers = @{ Authorization = "Bearer $Key" }
$body = @{ callback_port = '18080' } | ConvertTo-Json
$start = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:7864/admin/api/login' `
  -Headers $headers -ContentType 'application/json' -Body $body

Write-Host ''
Write-Host '============================================================'
Write-Host '  请在弹出的浏览器里用手机号 + 验证码登录 Trae'
Write-Host '  登录成功后会自动跳回 127.0.0.1:18080，无需复制链接'
Write-Host '============================================================'
Write-Host ''
Write-Host $start.login_url
Write-Host ''
try { Start-Process $start.login_url } catch { Write-Host '（浏览器未自动打开，请手动复制上面的链接）' }

$deadline = (Get-Date).AddMinutes(10)
$lastState = ''
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:7864/admin/api/login/result?pending_id=" + $start.pending_id) -TimeoutSec 10
    if ($r.state -ne $lastState) {
      $lastState = $r.state
      Write-Host "[login] 状态: $lastState"
    }
    if ($r.state -eq 'success') {
      Write-Host ''
      Write-Host "[login] 登录成功: uid=$($r.uid) nickname=$($r.nickname)"
      $authFile = Join-Path $Root ("auths\trae-" + $r.uid + '.json')
      if (Test-Path $authFile) { Write-Host "[login] 凭证已落盘: $authFile" }
      try {
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:7864/status' -Headers $headers -TimeoutSec 15
        Write-Host ("[login] 账号池: " + (($status.accounts | ForEach-Object { "$($_.uid)($($_.nickname))" }) -join ', '))
      } catch { }
      exit 0
    }
    if ($r.state -eq 'failed') {
      throw "登录失败: $($r.error)"
    }
    if ($r.state -eq 'canceled') {
      throw '登录已取消'
    }
  } catch {
    if ($_.Exception.Message -match '登录失败|已取消') { throw }
  }
  Start-Sleep -Seconds 2
}
throw '登录超时（10 分钟），请重新运行 login.ps1'
