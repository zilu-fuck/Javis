param(
  [string]$QaRoot = $PSScriptRoot,
  [ValidateSet("pending", "pass", "fail")]
  [string]$QaEvidence = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$LiveEvidence = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$EvidenceRefs = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$RecentFailureRate = "pending",
  [string[]]$EvidenceReference = @(),
  [double]$RecentFailureRateValue = -1,
  [string]$Operator = "",
  [string]$Build = ""
)

$ErrorActionPreference = "Stop"

$qaDir = $QaRoot
$outputPath = Join-Path $qaDir "capability-scoring-evidence-ingestion-qa-output.txt"
$manualEvidencePath = Join-Path $qaDir "capability-scoring-evidence-ingestion-manual-qa-evidence.md"
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

function To-OutputStatus($value) {
  if ($value -eq "pass") { return "PASS" }
  if ($value -eq "fail") { return "FAIL" }
  return "PENDING"
}

$screenshot = "45-capability-scoring-evidence-ingestion.png"
if (!(Test-Path -LiteralPath (Join-Path $qaDir $screenshot))) {
  throw "Missing required screenshot: $screenshot"
}
if (!(Test-Path -LiteralPath $manualEvidencePath)) {
  throw "Completed manual evidence file is missing: capability-scoring-evidence-ingestion-manual-qa-evidence.md"
}

$manualEvidence = [System.IO.File]::ReadAllText($manualEvidencePath)
if ($manualEvidence -match "Result:\s*PENDING" -or $manualEvidence -match "CAPABILITY-QA-\d+:\s*PENDING") {
  throw "Manual evidence still contains PENDING items."
}
if ($manualEvidence -notmatch "Result:\s*PASS") {
  throw "Manual evidence must record Result: PASS before producing passing QA output."
}

$statuses = [ordered]@{
  qaEvidence = To-OutputStatus $QaEvidence
  liveEvidence = To-OutputStatus $LiveEvidence
  evidenceRefs = To-OutputStatus $EvidenceRefs
  recentFailureRate = To-OutputStatus $RecentFailureRate
}

$cleanEvidenceReferences = @($EvidenceReference | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
if ($statuses.evidenceRefs -eq "PASS" -and $cleanEvidenceReferences.Count -eq 0) {
  throw "EvidenceRefs is PASS, but no -EvidenceReference value was provided."
}
if ($statuses.recentFailureRate -eq "PASS" -and ($RecentFailureRateValue -lt 0 -or $RecentFailureRateValue -gt 1)) {
  throw "RecentFailureRate is PASS, but -RecentFailureRateValue must be between 0 and 1."
}

$failedOrPending = @($statuses.GetEnumerator() | Where-Object { $_.Value -ne "PASS" })
$artifacts = @($screenshot, "capability-scoring-evidence-ingestion-manual-qa-evidence.md")
$generatedAt = (Get-Date).ToUniversalTime().ToString("o")

$lines = @(
  "# Capability Scoring Evidence Ingestion QA Output",
  "",
  "generatedAt: $generatedAt",
  "PackagedApp: true",
  "AppVersion: $(Get-AppVersion)",
  "QaDate: $(Get-Date -Format "yyyy-MM-dd")",
  "Artifacts: $($artifacts -join ", ")",
  "operator: $Operator",
  "build: $Build",
  "",
  "QA evidence: $($statuses.qaEvidence)",
  "live evidence: $($statuses.liveEvidence)",
  "evidence refs: $($statuses.evidenceRefs)",
  "recent failure rate: $($statuses.recentFailureRate)",
  "evidence references: $($cleanEvidenceReferences -join ", ")",
  "recent failure rate value: $RecentFailureRateValue",
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
    qaEvidence = $statuses.qaEvidence.ToLowerInvariant()
    liveEvidence = $statuses.liveEvidence.ToLowerInvariant()
    evidenceRefs = $statuses.evidenceRefs.ToLowerInvariant()
    recentFailureRate = $statuses.recentFailureRate.ToLowerInvariant()
    EvidenceReferences = $cleanEvidenceReferences
    RecentFailureRateValue = $RecentFailureRateValue
  } | ConvertTo-Json -Depth 8)
)

Write-Utf8NoBom $outputPath ($lines -join "`n")

if ($failedOrPending.Count -gt 0) {
  $summary = ($failedOrPending | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "
  throw "Capability scoring evidence ingestion QA is not passing yet: $summary. Output written to $outputPath."
}

Write-Host "Capability scoring evidence ingestion QA is complete. Output: $outputPath"
