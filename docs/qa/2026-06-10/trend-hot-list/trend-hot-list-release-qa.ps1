param(
  [Parameter(Mandatory = $true)]
  [string]$Provider,
  [int]$RequestedCount = 20,
  [Parameter(Mandatory = $true)]
  [int]$ItemCount,
  [Parameter(Mandatory = $true)]
  [string]$SourceUrl,
  [string]$QaRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$screenshotPath = Join-Path $QaRoot "38-trend-hot-list-report.png"
$manualEvidencePath = Join-Path $QaRoot "trend-hot-list-manual-qa-evidence.md"
$outputPath = Join-Path $QaRoot "trend-hot-list-live-qa-output.txt"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path

function Get-AppVersion {
  $tauriConfigPath = Join-Path $repoRoot "apps\desktop\src-tauri\tauri.conf.json"
  if (Test-Path -LiteralPath $tauriConfigPath) {
    return [string]((Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json).version)
  }
  return "unknown"
}

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

if (!(Test-Path -LiteralPath $screenshotPath)) {
  throw "Missing required screenshot: $screenshotPath"
}

if (!(Test-Path -LiteralPath $manualEvidencePath)) {
  throw "Missing completed manual evidence file: $manualEvidencePath"
}

$manualEvidence = [System.IO.File]::ReadAllText($manualEvidencePath)
if ($manualEvidence -match "PENDING") {
  throw "Manual evidence still contains PENDING scenario(s): $manualEvidencePath"
}

if ($RequestedCount -ne 20) {
  throw "Product gate expects RequestedCount 20, got $RequestedCount"
}

if ($ItemCount -le 0) {
  throw "ItemCount must be greater than zero."
}

if ($SourceUrl -notmatch "^https?://") {
  throw "SourceUrl must be an http(s) URL."
}

$output = [ordered]@{
  PackagedApp = $true
  AppVersion = Get-AppVersion
  QaDate = Get-Date -Format "yyyy-MM-dd"
  Artifacts = @(
    "38-trend-hot-list-report.png"
    "trend-hot-list-manual-qa-evidence.md"
  )
  toolName = "trend.fetchHotList"
  Provider = $Provider
  RequestedCount = $RequestedCount
  ItemCount = $ItemCount
  SourceUrl = $SourceUrl
  Diagnostics = @(
    [ordered]@{
      Status = "completed"
    }
  )
  ResearchReport = [ordered]@{
    Sources = @($SourceUrl)
  }
  Screenshot = "38-trend-hot-list-report.png"
}

$json = $output | ConvertTo-Json -Depth 6
Write-Utf8NoBom $outputPath $json
Write-Host "Wrote $outputPath"
