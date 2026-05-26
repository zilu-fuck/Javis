param(
  [string]$QaRoot = (Join-Path $PSScriptRoot "..\..\docs\qa"),
  [switch]$AllowKnownBlockers
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingPath($Path) {
  if (!(Test-Path -LiteralPath $Path)) {
    throw "Path not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function ConvertTo-RepoRelativePath($Path) {
  $fullPath = (Resolve-Path -LiteralPath $Path).Path
  if ($fullPath.StartsWith($script:RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath.Substring($script:RepoRoot.Length).TrimStart("\", "/")
  }
  return $fullPath
}

function New-FileRequirement($Label, [string[]]$Names) {
  return [ordered]@{
    Kind = "file"
    Label = $Label
    Names = $Names
  }
}

function New-TextRequirement($Label, [string]$Pattern, [string[]]$Names = @()) {
  return [ordered]@{
    Kind = "text"
    Label = $Label
    Pattern = $Pattern
    Names = $Names
  }
}

function Find-Artifact([string[]]$Names) {
  foreach ($name in $Names) {
    $match = $script:AllQaFiles |
      Where-Object { $_.Name -ieq $name } |
      Sort-Object FullName |
      Select-Object -First 1
    if ($match) {
      return $match.FullName
    }
  }
  return $null
}

function Find-TextEvidence([string]$Pattern, [string[]]$Names) {
  $files = $script:TextQaFiles
  if ($Names.Count -gt 0) {
    $files = @(
      foreach ($name in $Names) {
        $script:TextQaFiles | Where-Object { $_.Name -ieq $name }
      }
    )
  }
  foreach ($file in $files) {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    if ($text -match $Pattern) {
      return $file.FullName
    }
  }
  return $null
}

function Test-Requirement($Requirement) {
  if ($Requirement.Kind -eq "file") {
    $path = Find-Artifact $Requirement.Names
    return [ordered]@{
      Label = $Requirement.Label
      Passed = [bool]$path
      Evidence = if ($path) { ConvertTo-RepoRelativePath $path } else { "missing: $($Requirement.Names -join ' | ')" }
    }
  }

  if ($Requirement.Kind -eq "text") {
    $path = Find-TextEvidence $Requirement.Pattern $Requirement.Names
    $scope = if ($Requirement.Names.Count -gt 0) { " in $($Requirement.Names -join ' | ')" } else { "" }
    return [ordered]@{
      Label = $Requirement.Label
      Passed = [bool]$path
      Evidence = if ($path) { ConvertTo-RepoRelativePath $path } else { "missing text evidence$($scope): $($Requirement.Pattern)" }
    }
  }

  throw "Unknown requirement kind: $($Requirement.Kind)"
}

$script:RepoRoot = Resolve-ExistingPath (Join-Path $PSScriptRoot "..\..")
$qaRootPath = Resolve-ExistingPath $QaRoot
if (!$AllowKnownBlockers) {
  $qaLeafName = Split-Path -Leaf $qaRootPath
  $notesPath = Join-Path $qaRootPath "notes.md"
  if ($qaLeafName -notmatch "^\d{4}-\d{2}-\d{2}$" -or !(Test-Path -LiteralPath $notesPath)) {
    throw "Strict product workflow QA requires -QaRoot to point at one dated evidence folder with notes.md, for example docs/qa/2026-05-26. Use -AllowKnownBlockers for cross-folder inventory."
  }
}
$script:AllQaFiles = @(Get-ChildItem -LiteralPath $qaRootPath -Recurse -File)
$script:TextQaFiles = @(
  $script:AllQaFiles |
    Where-Object { $_.Extension -in @(".md", ".txt", ".json") }
)

$scenarios = @(
  [ordered]@{
    Id = "mvp-baseline"
    Title = "MVP baseline still passes"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "Idle workbench screenshot" @("01-idle-workbench.png", "01-native-idle-workbench.png")
      New-FileRequirement "Markdown scan completed" @("02-markdown-scan-completed.png")
      New-FileRequirement "Project inspection completed" @("03-project-inspection-completed.png")
      New-FileRequirement "URL research completed" @("04-research-report-completed.png")
      New-FileRequirement "PDF approval card" @("05-pdf-permission-card.png")
      New-FileRequirement "PDF approved result" @("06-pdf-approved-result.png")
      New-FileRequirement "PDF denied result" @("07-pdf-denied-result.png")
      New-FileRequirement "Failed verification state" @("08-failed-verification-state.png", "11-search-weak-evidence-failed.png")
    )
  }
  [ordered]@{
    Id = "search-backed-research"
    Title = "Search-backed research success and failure paths"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "github-cli fixture search success" @("09-search-github-cli-completed.png")
      New-FileRequirement "Agent Chrome fallback search success" @("10-search-agent-chrome-fallback-completed.png")
      New-FileRequirement "Weak evidence failure" @("11-search-weak-evidence-failed.png")
      New-FileRequirement "Fetch failure state" @("12-search-failed-fetch-state.png")
      New-FileRequirement "No-results state" @("13-search-no-results-state.png")
      New-FileRequirement "Live github-cli smoke" @("14-search-live-github-cli-smoke.png")
      New-FileRequirement "Live Agent Chrome smoke" @("15-search-live-agent-chrome-smoke.png")
      New-FileRequirement "Repeatable search QA output" @("research-search-qa-output.txt")
      New-FileRequirement "Live search smoke output" @("research-live-smoke-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "workspace-management"
    Title = "Workspace selection and restart persistence"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "Workspace before restart" @("01-workspace-recent-before-restart.png")
      New-FileRequirement "Workspace after restart" @("02-workspace-recent-after-restart.png")
      New-FileRequirement "Workspace restart QA output" @("workspace-restart-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "code-agent-fixture"
    Title = "Code Agent fixture deny/apply safety"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "Code Agent proposal before deny" @("16-code-agent-proposal-before-deny.png")
      New-FileRequirement "Code Agent denied result" @("16-code-agent-denied-before-deny.png")
      New-FileRequirement "Code Agent proposal before approve" @("18-code-agent-proposal-before-approve.png")
      New-FileRequirement "Code Agent approved result" @("18-code-agent-approved-before-approve.png")
      New-FileRequirement "Code Agent fixture QA output" @("code-agent-opencode-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "code-agent-live-provider"
    Title = "Code Agent live provider proposal/apply"
    KnownBlocker = $true
    Requirements = @(
      New-TextRequirement "Live provider is configured" '"LiveProviderConfigured"\s*:\s*true' @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Live credential storage is enabled" '"LiveCredentialStorageEnabled"\s*:\s*true' @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Live provider approved apply passed" '(?s)"LiveResult"\s*:\s*\{.*"Scenario"\s*:\s*"live-approved".*"Status"\s*:\s*"pass"' @("code-agent-opencode-qa-output.txt")
      New-FileRequirement "Live proposal before write approval" @("20-code-agent-live-proposal-before-approve.png")
      New-FileRequirement "Live approved apply result" @("20-code-agent-live-approved.png", "20-code-agent-live-apply-approved.png")
    )
  }
  [ordered]@{
    Id = "pdf-durable-approval"
    Title = "Durable PDF approval restore"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "PDF durable approval restored" @("21-pdf-durable-approval-restored.png")
      New-FileRequirement "PDF durable approval approved" @("22-pdf-durable-approval-approved.png")
      New-FileRequirement "PDF durable deny restored" @("23-pdf-durable-approval-deny-restored.png")
      New-FileRequirement "PDF durable denied" @("24-pdf-durable-approval-denied.png")
      New-FileRequirement "PDF durable expired" @("25-pdf-durable-approval-expired.png")
      New-FileRequirement "PDF durable QA output" @("pdf-durable-approval-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "code-patch-durable-approval"
    Title = "Durable Code Patch approval restore"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "Code Patch durable approval restored" @("26-code-patch-durable-approval-restored.png")
      New-FileRequirement "Code Patch durable approved" @("27-code-patch-durable-approval-approved.png")
      New-FileRequirement "Code Patch durable deny restored" @("28-code-patch-durable-approval-deny-restored.png")
      New-FileRequirement "Code Patch durable denied" @("29-code-patch-durable-approval-denied.png")
      New-FileRequirement "Code Patch durable expired" @("30-code-patch-durable-approval-expired.png")
      New-FileRequirement "Code Patch durable QA output" @("code-patch-durable-approval-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "task-history-persistence"
    Title = "Task history restore and delete"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Task history restored after restart" @("task-history-restored-after-restart.png")
      New-FileRequirement "Task history delete after restart" @("task-history-deleted-after-restart.png")
      New-FileRequirement "Task history QA output" @("task-history-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "model-secret-handling"
    Title = "Model settings and secret redaction"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Secret redaction scan output" @("model-secret-redaction-qa-output.txt", "secret-scan-output.txt")
      New-TextRequirement "Secret scan reports no API keys" 'PASS|No API keys found|No secrets found|0 findings' @("model-secret-redaction-qa-output.txt", "secret-scan-output.txt")
      New-TextRequirement "Secret storage is exercised by QA output" '"LiveCredentialStorageEnabled"\s*:\s*true|save_model_api_key_secret' @("code-agent-opencode-qa-output.txt", "model-secret-redaction-qa-output.txt", "secret-scan-output.txt")
    )
  }
  [ordered]@{
    Id = "error-recovery"
    Title = "Actionable product failure states"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "Search failure screenshot" @("12-search-failed-fetch-state.png")
      New-FileRequirement "No-results screenshot" @("13-search-no-results-state.png")
      New-FileRequirement "Code Agent provider failure screenshot" @("20-code-agent-live-proposal-failed.png", "18-code-agent-approved-failed-before-approve.png")
      New-FileRequirement "Expired approval fail-closed screenshot" @("25-pdf-durable-approval-expired.png", "30-code-patch-durable-approval-expired.png")
    )
  }
  [ordered]@{
    Id = "release-and-rollback"
    Title = "Signed release evidence and rollback notes"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Release rollback notes" @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "Previous known-good build is recorded" 'Previous known-good build:\s*\S+'
      New-TextRequirement "Installer hashes are recorded" 'MSI SHA-256:\s*\S+|NSIS SHA-256:\s*\S+'
    )
  }
)

$results = @()
$missingDetails = @()

foreach ($scenario in $scenarios) {
  $requirementResults = @($scenario.Requirements | ForEach-Object { Test-Requirement $_ })
  $missing = @($requirementResults | Where-Object { !$_.Passed })
  $status = if ($missing.Count -eq 0) {
    "PASS"
  } elseif ($scenario.KnownBlocker) {
    "BLOCKED"
  } else {
    "FAIL"
  }

  $results += [pscustomobject]@{
    Status = $status
    Scenario = $scenario.Id
    Title = $scenario.Title
    Missing = $missing.Count
  }

  foreach ($item in $missing) {
    $missingDetails += [pscustomobject]@{
      Status = $status
      Scenario = $scenario.Id
      Requirement = $item.Label
      Evidence = $item.Evidence
    }
  }
}

Write-Host "Product workflow QA evidence root: $(ConvertTo-RepoRelativePath $qaRootPath)"
Write-Host ""
$results | Format-Table -AutoSize

if ($missingDetails.Count -gt 0) {
  Write-Host ""
  Write-Host "Missing or blocked evidence:"
  foreach ($detail in $missingDetails) {
    Write-Host ("[{0}] {1} / {2}: {3}" -f $detail.Status, $detail.Scenario, $detail.Requirement, $detail.Evidence)
  }
}

$failed = @($results | Where-Object { $_.Status -eq "FAIL" })
$blocked = @($results | Where-Object { $_.Status -eq "BLOCKED" })

if ($failed.Count -gt 0) {
  throw "Product workflow QA evidence has $($failed.Count) failing scenario(s)."
}

if ($blocked.Count -gt 0 -and !$AllowKnownBlockers) {
  throw "Product workflow QA evidence has $($blocked.Count) known blocker(s). Re-run with -AllowKnownBlockers only for development inventory."
}

if ($blocked.Count -gt 0) {
  Write-Host ""
  Write-Host "Known blockers are allowed for this development inventory run."
}
