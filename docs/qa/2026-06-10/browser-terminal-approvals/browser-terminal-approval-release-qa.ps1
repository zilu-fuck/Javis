param(
  [string]$QaRoot = $PSScriptRoot,
  [ValidateSet("pending", "pass", "fail")]
  [string]$TerminalStart = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$TerminalInput = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$BrowserWrite = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$Denial = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$StalePreview = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$OneShot = "pending",
  [string]$Operator = "",
  [string]$Build = "",
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

$qaDir = $QaRoot
$outputPath = Join-Path $qaDir "browser-terminal-approval-qa-output.txt"
$manualEvidencePath = Join-Path $qaDir "browser-terminal-approval-manual-qa-evidence.md"
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

function Assert-File($name) {
  $path = Join-Path $qaDir $name
  if (!(Test-Path -LiteralPath $path)) {
    throw "Required Browser/Terminal QA evidence file is missing: $name"
  }
}

function To-OutputStatus($value) {
  if ($value -eq "pass") { return "PASS" }
  if ($value -eq "fail") { return "FAIL" }
  return "PENDING"
}

$requiredImages = @(
  "39-terminal-start-approval-card.png",
  "40-terminal-input-approval-card.png",
  "41-browser-write-approval-card.png"
)

foreach ($name in $requiredImages) {
  Assert-File $name
}

if (!(Test-Path -LiteralPath $manualEvidencePath)) {
  throw "Completed manual evidence file is missing: browser-terminal-approval-manual-qa-evidence.md"
}

$manualEvidence = [System.IO.File]::ReadAllText($manualEvidencePath)
if ($manualEvidence -match "Result:\s*PENDING" -or $manualEvidence -match "BROWSER-TERM-QA-\d+:\s*PENDING") {
  throw "Manual evidence still contains PENDING items."
}
if ($manualEvidence -notmatch "Result:\s*PASS") {
  throw "Manual evidence must record Result: PASS before producing passing QA output."
}

$statuses = [ordered]@{
  terminalStart = To-OutputStatus $TerminalStart
  terminalInput = To-OutputStatus $TerminalInput
  browserWrite = To-OutputStatus $BrowserWrite
  denial = To-OutputStatus $Denial
  stalePreview = To-OutputStatus $StalePreview
  oneShot = To-OutputStatus $OneShot
}

$failedOrPending = @($statuses.GetEnumerator() | Where-Object { $_.Value -ne "PASS" })
$artifacts = @($requiredImages + @("browser-terminal-approval-manual-qa-evidence.md"))
$generatedAt = (Get-Date).ToUniversalTime().ToString("o")

$lines = @(
  "# Browser and Terminal Approval QA Output",
  "",
  "generatedAt: $generatedAt",
  "PackagedApp: true",
  "AppVersion: $(Get-AppVersion)",
  "QaDate: $(Get-Date -Format "yyyy-MM-dd")",
  "Artifacts: $($artifacts -join ", ")",
  "operator: $Operator",
  "build: $Build",
  "workspace: $Workspace",
  "",
  "terminal start: $($statuses.terminalStart)",
  "terminal input: $($statuses.terminalInput)",
  "browser write: $($statuses.browserWrite)",
  "denial: $($statuses.denial)",
  "stale preview: $($statuses.stalePreview)",
  "one shot: $($statuses.oneShot)",
  "",
  "json:",
  (@{
    generatedAt = $generatedAt
    PackagedApp = $true
    AppVersion = Get-AppVersion
    QaDate = Get-Date -Format "yyyy-MM-dd"
    Artifacts = $artifacts
    operator = $Operator
    build = $Build
    workspace = $Workspace
    terminalStart = $statuses.terminalStart.ToLowerInvariant()
    terminalInput = $statuses.terminalInput.ToLowerInvariant()
    browserWrite = $statuses.browserWrite.ToLowerInvariant()
    denial = $statuses.denial.ToLowerInvariant()
    stalePreview = $statuses.stalePreview.ToLowerInvariant()
    oneShot = $statuses.oneShot.ToLowerInvariant()
  } | ConvertTo-Json -Depth 8)
)

Write-Utf8NoBom $outputPath ($lines -join "`n")

if ($failedOrPending.Count -gt 0) {
  $summary = ($failedOrPending | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "
  throw "Browser/Terminal approval QA is not passing yet: $summary. Output written to $outputPath."
}

Write-Host "Browser/Terminal approval release QA evidence is complete. Output: $outputPath"
