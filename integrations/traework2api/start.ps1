#!/usr/bin/env pwsh
# start.ps1 — Windows 一键启动 Trae 积分代理（tw2api 7864 + img-proxy 7863）
# 用法: pwsh -File .\start.ps1
# 说明:
#   - 读取 .env.local 里的 TW2A_API_KEY
#   - tw2api 已在 7864 监听时自动跳过，不重复启动
#   - img-proxy 已在 7863 监听时自动跳过
#   - 日志: tw2api.log / tw2api.err.log / img-proxy.log / img-proxy.err.log
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

function Test-Port([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

$Key = Get-DotEnvValue 'TW2A_API_KEY'
if (-not $Key) {
  throw "缺少 1-traework2api/.env.local 的 TW2A_API_KEY。可复制 .env.example 后填入随机密钥。"
}

$AuthDir = Join-Path $Root 'auths'
$DataDir = Join-Path $Root 'data'
$RunDir = Join-Path $Root '.run'
New-Item -ItemType Directory -Force -Path $AuthDir, $DataDir, $RunDir | Out-Null

$env:TW2A_API_KEY = $Key
$env:TW2A_LISTEN = ':7864'
$env:TW2A_AUTH_DIR = $AuthDir
$env:TW2A_STATE_FILE = (Join-Path $DataDir 'state.json')
$env:TW2A_CALLBACK_PORT = '18080'
$env:TW2A_DEFAULT_MODEL = 'DeepSeek-V4-Flash'

# ── tw2api (7864) ─────────────────────────────────────────
if (Test-Port 7864) {
  Write-Host '[start] 7864 已在监听，跳过 tw2api 启动'
} else {
  $exe = Join-Path $Root 'tw2api.exe'
  if (-not (Test-Path $exe)) {
    throw "找不到 tw2api.exe，请先按 README 第 0 步构建并放到 1-traework2api/。"
  }
  $p = Start-Process -FilePath $exe -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Root 'tw2api.log') `
    -RedirectStandardError (Join-Path $Root 'tw2api.err.log')
  Set-Content -Path (Join-Path $RunDir 'tw2api.pid') -Value $p.Id
  Write-Host "[start] tw2api 已启动 (PID $($p.Id))，监听 127.0.0.1:7864"
}

# ── img-proxy (7863) ──────────────────────────────────────
if (Test-Port 7863) {
  Write-Host '[start] 7863 已在监听，跳过 img-proxy 启动'
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Write-Host '[start] 未找到 node，跳过 img-proxy（不影响纯文本对话）'
  } else {
    $env:LISTEN = '127.0.0.1:7863'
    $env:UPSTREAM = 'http://127.0.0.1:7864'
    $p = Start-Process -FilePath $node -ArgumentList 'img-proxy.js' -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $Root 'img-proxy.log') `
      -RedirectStandardError (Join-Path $Root 'img-proxy.err.log')
    Set-Content -Path (Join-Path $RunDir 'img-proxy.pid') -Value $p.Id
    Write-Host "[start] img-proxy 已启动 (PID $($p.Id))，监听 127.0.0.1:7863"
  }
}

# ── 健康检查 ───────────────────────────────────────────────
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7864/healthz' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200 -and $r.Content -match 'ok') { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $ok) {
  Write-Warning "20 秒内 healthz 未通过，请查看 $(Join-Path $Root 'tw2api.err.log')"
  exit 1
}
Write-Host '[start] tw2api healthz ok'

try {
  $headers = @{ Authorization = "Bearer $Key" }
  $models = Invoke-RestMethod -Uri 'http://127.0.0.1:7863/v1/models' -Headers $headers -TimeoutSec 10
  $ids = @($models.data | ForEach-Object { $_.id })
  Write-Host ("[start] 可用模型: " + (($ids | Select-Object -First 12) -join ', ') + $(if ($ids.Count -gt 12) { ' ...' } else { '' }))
} catch {
  Write-Warning "模型列表检查失败: $($_.Exception.Message)"
}

Write-Host '[start] 完成。登录 Trae: pwsh -File .\login.ps1'
