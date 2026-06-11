param(
  [string]$QaRoot = $PSScriptRoot,
  [ValidateSet("pending", "pass", "fail")]
  [string]$Stage = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$Commit = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$Push = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$PrCreate = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$PrComment = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$Denial = "pending",
  [ValidateSet("pending", "pass", "fail")]
  [string]$Restore = "pending",
  [string]$Operator = "",
  [string]$Build = "",
  [string]$Remote = "",
  [string]$Branch = ""
)

$ErrorActionPreference = "Stop"

$qaDir = $QaRoot
$outputPath = Join-Path $qaDir "git-remote-pr-qa-output.txt"
$manualEvidencePath = Join-Path $qaDir "git-remote-pr-manual-qa-evidence.md"
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
    throw "Required Git/PR QA evidence file is missing: $name"
  }
}

function To-OutputStatus($value) {
  if ($value -eq "pass") { return "PASS" }
  if ($value -eq "fail") { return "FAIL" }
  return "PENDING"
}

$requiredImages = @(
  "31-git-review-status-pr-list.png",
  "32-git-stage-approval-card.png",
  "33-git-commit-approval-card.png",
  "34-git-push-approval-card.png",
  "35-git-create-pr-approval-card.png",
  "36-git-comment-pr-approval-card.png",
  "37-git-restored-approval-after-restart.png"
)

foreach ($name in $requiredImages) {
  Assert-File $name
}

if (!(Test-Path -LiteralPath $manualEvidencePath)) {
  throw "Completed manual evidence file is missing: git-remote-pr-manual-qa-evidence.md"
}

$manualEvidence = [System.IO.File]::ReadAllText($manualEvidencePath)
if ($manualEvidence -match "Result:\s*PENDING" -or $manualEvidence -match "GIT-QA-\d+:\s*PENDING") {
  throw "Manual evidence still contains PENDING items."
}
if ($manualEvidence -notmatch "Result:\s*PASS") {
  throw "Manual evidence must record Result: PASS before producing passing QA output."
}

$statuses = [ordered]@{
  stage = To-OutputStatus $Stage
  commit = To-OutputStatus $Commit
  push = To-OutputStatus $Push
  prCreate = To-OutputStatus $PrCreate
  prComment = To-OutputStatus $PrComment
  denial = To-OutputStatus $Denial
  restore = To-OutputStatus $Restore
}

$failedOrPending = @($statuses.GetEnumerator() | Where-Object { $_.Value -ne "PASS" })
$artifacts = @($requiredImages + @("git-remote-pr-manual-qa-evidence.md"))
$generatedAt = (Get-Date).ToUniversalTime().ToString("o")

$lines = @(
  "# Git Remote and PR Write QA Output",
  "",
  "generatedAt: $generatedAt",
  "PackagedApp: true",
  "AppVersion: $(Get-AppVersion)",
  "QaDate: $(Get-Date -Format "yyyy-MM-dd")",
  "Artifacts: $($artifacts -join ", ")",
  "operator: $Operator",
  "build: $Build",
  "remote: $Remote",
  "branch: $Branch",
  "",
  "stage: $($statuses.stage)",
  "commit: $($statuses.commit)",
  "push: $($statuses.push)",
  "pr create: $($statuses.prCreate)",
  "pr comment: $($statuses.prComment)",
  "denial: $($statuses.denial)",
  "restore: $($statuses.restore)",
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
    remote = $Remote
    branch = $Branch
    stage = $statuses.stage.ToLowerInvariant()
    commit = $statuses.commit.ToLowerInvariant()
    push = $statuses.push.ToLowerInvariant()
    prCreate = $statuses.prCreate.ToLowerInvariant()
    prComment = $statuses.prComment.ToLowerInvariant()
    denial = $statuses.denial.ToLowerInvariant()
    restore = $statuses.restore.ToLowerInvariant()
  } | ConvertTo-Json -Depth 8)
)

Write-Utf8NoBom $outputPath ($lines -join "`n")

if ($failedOrPending.Count -gt 0) {
  $summary = ($failedOrPending | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "
  throw "Git/PR QA is not passing yet: $summary. Output written to $outputPath."
}

Write-Host "Git/PR release QA evidence is complete. Output: $outputPath"
