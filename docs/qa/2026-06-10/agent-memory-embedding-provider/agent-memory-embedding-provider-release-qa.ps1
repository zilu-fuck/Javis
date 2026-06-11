param(
  [string]$QaRoot = $PSScriptRoot,
  [ValidateSet("pending", "pass", "fail")]
  [string]$LocalEmbedding = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$NativeOpenAiCompatible = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$SecretReference = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$VectorSearch = "pending",
  [string]$Operator = "",
  [string]$Build = ""
)

$ErrorActionPreference = "Stop"

$qaDir = $QaRoot
$outputPath = Join-Path $qaDir "agent-memory-embedding-provider-live-qa-output.txt"
$manualEvidencePath = Join-Path $qaDir "agent-memory-embedding-provider-manual-qa-evidence.md"
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

$settingsScreenshot = "44-agent-memory-embedding-settings.png"
if (!(Test-Path -LiteralPath (Join-Path $qaDir $settingsScreenshot))) {
  throw "Missing required screenshot: $settingsScreenshot"
}
if (!(Test-Path -LiteralPath $manualEvidencePath)) {
  throw "Completed manual evidence file is missing: agent-memory-embedding-provider-manual-qa-evidence.md"
}

$manualEvidence = [System.IO.File]::ReadAllText($manualEvidencePath)
if ($manualEvidence -match "Result:\s*PENDING" -or $manualEvidence -match "EMBEDDING-QA-\d+:\s*PENDING") {
  throw "Manual evidence still contains PENDING items."
}
if ($manualEvidence -notmatch "Result:\s*PASS") {
  throw "Manual evidence must record Result: PASS before producing passing QA output."
}

$statuses = [ordered]@{
  localEmbedding = To-OutputStatus $LocalEmbedding
  nativeOpenAiCompatible = To-OutputStatus $NativeOpenAiCompatible
  secretReference = To-OutputStatus $SecretReference
  vectorSearch = To-OutputStatus $VectorSearch
}
$failedOrPending = @($statuses.GetEnumerator() | Where-Object { $_.Value -ne "PASS" })
$artifacts = @($settingsScreenshot, "agent-memory-embedding-provider-manual-qa-evidence.md")
$generatedAt = (Get-Date).ToUniversalTime().ToString("o")

$lines = @(
  "# Agent Memory Embedding Provider Live QA Output",
  "",
  "generatedAt: $generatedAt",
  "PackagedApp: true",
  "AppVersion: $(Get-AppVersion)",
  "QaDate: $(Get-Date -Format "yyyy-MM-dd")",
  "Artifacts: $($artifacts -join ", ")",
  "operator: $Operator",
  "build: $Build",
  "",
  "local embedding: $($statuses.localEmbedding)",
  "native OpenAI-compatible: $($statuses.nativeOpenAiCompatible)",
  "secret reference: $($statuses.secretReference)",
  "vector search: $($statuses.vectorSearch)",
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
    localEmbedding = $statuses.localEmbedding.ToLowerInvariant()
    nativeOpenAiCompatible = $statuses.nativeOpenAiCompatible.ToLowerInvariant()
    secretReference = $statuses.secretReference.ToLowerInvariant()
    vectorSearch = $statuses.vectorSearch.ToLowerInvariant()
  } | ConvertTo-Json -Depth 8)
)

Write-Utf8NoBom $outputPath ($lines -join "`n")

if ($failedOrPending.Count -gt 0) {
  $summary = ($failedOrPending | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "
  throw "Agent memory embedding provider QA is not passing yet: $summary. Output written to $outputPath."
}

Write-Host "Agent memory embedding provider QA evidence is complete. Output: $outputPath"
