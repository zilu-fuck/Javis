param(
  [string]$QaRoot = "",
  [switch]$AllowMissingLocalVision,
  [switch]$RequireManualScenarioPass
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

function ConvertTo-DisplayPath($Path) {
  if (Test-Path -LiteralPath $Path) {
    return ConvertTo-RepoRelativePath $Path
  }
  return $Path
}

function Add-Check($Id, $Passed, $Detail) {
  $script:Checks.Add([ordered]@{
    Id = $Id
    Passed = [bool]$Passed
    Detail = [string]$Detail
  }) | Out-Null
}

function Get-CheckById($Evidence, [string]$Id) {
  return @($Evidence.checks | Where-Object { $_.id -eq $Id })[0]
}

function Assert-JsonHasNoImageDataUrl($Path) {
  $text = [System.IO.File]::ReadAllText($Path)
  return $text -notmatch "data:image"
}

function Get-ManualEvidenceArtifactRefs([string]$Text) {
  $artifactLineMatch = [regex]::Match($Text, "(?im)^\s*Artifacts:\s*(.+)$")
  if (!$artifactLineMatch.Success) {
    return @()
  }
  $line = $artifactLineMatch.Groups[1].Value
  $matches = [regex]::Matches($line, "(?i)([^,\s`"']+\.(?:png|md|json))\b")
  return @($matches | ForEach-Object {
    $_.Groups[1].Value -replace '^[\s`''"]+|[\s`''"]+$', ''
  })
}

function Test-ManualEvidenceArtifactsExist([string[]]$ArtifactRefs, [string]$QaRootPath) {
  if ($ArtifactRefs.Count -eq 0) {
    return $false
  }
  foreach ($artifactRef in $ArtifactRefs) {
    if (!$artifactRef -or $artifactRef -match "data:image") {
      return $false
    }
    $normalizedRef = $artifactRef -replace "/", "\"
    if ($normalizedRef -match "(^|\\)\.\.(\\|$)") {
      return $false
    }
    if ([System.IO.Path]::IsPathRooted($normalizedRef)) {
      return $false
    }
    $artifactPath = Join-Path $QaRootPath $normalizedRef
    if (!(Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
      return $false
    }
  }
  return $true
}

function Test-ManualScenarioEvidenceDetail([string]$Text, [string]$ScenarioId) {
  $lines = $Text -split "\r?\n"
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    $line = $lines[$index]
    if ($line -notmatch "(?i)\b$([regex]::Escape($ScenarioId))\b" -or $line -notmatch "(?i)\bPASS\b") {
      continue
    }
    if ($line -match "(?i)\bEvidence:\s*\S") {
      return $true
    }
    if (($index + 1) -lt $lines.Count -and $lines[$index + 1] -match "(?i)^\s+Evidence:\s*\S") {
      return $true
    }
    return $false
  }
  return $false
}

$script:RepoRoot = Resolve-ExistingPath (Join-Path $PSScriptRoot "..\..")
if (!$QaRoot.Trim()) {
  $QaRoot = Join-Path $script:RepoRoot "docs\qa\2026-06-09\computer-use"
}
$qaRootPath = Resolve-ExistingPath $QaRoot
$reportPath = Join-Path $qaRootPath "computer-use-release-qa-report.md"
$jsonPath = Join-Path $qaRootPath "computer-use-release-qa-output.json"
$screenshotPath = Join-Path $qaRootPath "01-computer-use-release-app.png"
$scenarioPath = Join-Path $qaRootPath "computer-use-qa-scenarios.md"
$manualEvidencePath = Join-Path $qaRootPath "computer-use-manual-qa-evidence.md"
$script:Checks = [System.Collections.Generic.List[object]]::new()

Add-Check "report-exists" (Test-Path -LiteralPath $reportPath) (ConvertTo-DisplayPath $reportPath)
Add-Check "json-exists" (Test-Path -LiteralPath $jsonPath) (ConvertTo-DisplayPath $jsonPath)
Add-Check "screenshot-exists" ((Test-Path -LiteralPath $screenshotPath) -and (Get-Item -LiteralPath $screenshotPath).Length -gt 0) (ConvertTo-DisplayPath $screenshotPath)
Add-Check "scenario-checklist-exists" (Test-Path -LiteralPath $scenarioPath) (ConvertTo-DisplayPath $scenarioPath)

if (!(Test-Path -LiteralPath $reportPath) -or !(Test-Path -LiteralPath $jsonPath)) {
  throw "Computer Use QA evidence is missing required report or JSON output."
}

$reportText = [System.IO.File]::ReadAllText($reportPath)
$jsonText = [System.IO.File]::ReadAllText($jsonPath)
$evidence = $jsonText | ConvertFrom-Json

Add-Check "report-pass" ($reportText -match "Result:\s+PASS") "report contains Result: PASS"
Add-Check "report-no-image-data-url" ($reportText -notmatch "data:image") "report does not persist screenshot data URLs"
Add-Check "json-no-image-data-url" ($jsonText -notmatch "data:image") "JSON output does not persist screenshot data URLs"
Add-Check "json-no-raw-window-text" ($jsonText -notmatch "foregroundTitle|bodyTextSample") "JSON output does not persist raw foreground titles or body text samples"

if (Test-Path -LiteralPath $scenarioPath) {
  $scenarioText = [System.IO.File]::ReadAllText($scenarioPath)
  foreach ($scenarioId in @("CU-QA-01", "CU-QA-02", "CU-QA-03", "CU-QA-04", "CU-QA-05", "CU-QA-06", "CU-QA-07", "CU-QA-08")) {
    Add-Check "scenario-$scenarioId-documented" ($scenarioText -match $scenarioId) "$scenarioId appears in the 8-scenario checklist"
    if ($RequireManualScenarioPass) {
      $rowPattern = "\|\s*$scenarioId\s*\|[^\r\n]*\|\s*PASS\s*\|"
      Add-Check "scenario-$scenarioId-pass" ($scenarioText -match $rowPattern) "$scenarioId row status is PASS"
    }
  }
  if ($RequireManualScenarioPass) {
    Add-Check "scenario-status-full-pass" (
      $scenarioText -match "Overall 8-scenario status:\s+PASS" -and
      $scenarioText -notmatch "Manual opt-in required"
    ) "manual desktop-action scenarios are all marked PASS"
  } else {
    Add-Check "scenario-status-not-overclaimed" (
      $scenarioText -match "Overall 8-scenario status:\s+Not yet full PASS" -and
      $scenarioText -match "Manual opt-in required"
    ) "manual desktop-action scenarios are explicit and not overclaimed"
  }
}

if ($RequireManualScenarioPass) {
  $manualEvidenceExists = Test-Path -LiteralPath $manualEvidencePath
  $manualEvidenceDetail = if ($manualEvidenceExists) { ConvertTo-RepoRelativePath $manualEvidencePath } else { $manualEvidencePath }
  Add-Check "manual-evidence-exists" $manualEvidenceExists $manualEvidenceDetail
  if ($manualEvidenceExists) {
    $manualEvidenceText = [System.IO.File]::ReadAllText($manualEvidencePath)
    Add-Check "manual-evidence-date" ($manualEvidenceText -match "(?im)^\s*Date:\s*\d{4}-\d{2}-\d{2}") "manual evidence records a concrete date"
    Add-Check "manual-evidence-operator" ($manualEvidenceText -match "(?im)^\s*Operator:\s*\S") "manual evidence records the operator"
    Add-Check "manual-evidence-build" ($manualEvidenceText -match "(?im)^\s*(App version|Build|Executable):\s*\S") "manual evidence records the app version, build, or executable"
    Add-Check "manual-evidence-result" ($manualEvidenceText -match "(?im)^\s*Result:\s*PASS\s*$") "manual evidence records Result: PASS"
    Add-Check "manual-evidence-artifacts" ($manualEvidenceText -match "(?im)^\s*Artifacts:\s*\S[^\r\n]*\.(?:png|md|json)\b[^\r\n]*$") "manual evidence references screenshot or report artifacts on the Artifacts line"
    $manualArtifactRefs = Get-ManualEvidenceArtifactRefs $manualEvidenceText
    Add-Check "manual-evidence-artifacts-exist" (Test-ManualEvidenceArtifactsExist $manualArtifactRefs $qaRootPath) "manual evidence artifact references exist in the QA evidence folder"
    Add-Check "manual-evidence-no-image-data-url" ($manualEvidenceText -notmatch "data:image") "manual evidence does not persist screenshot data URLs"
    foreach ($scenarioId in @("CU-QA-01", "CU-QA-02", "CU-QA-03", "CU-QA-04", "CU-QA-05", "CU-QA-06", "CU-QA-07", "CU-QA-08")) {
      $scenarioEvidencePattern = "(?im)^\s*(?:[-*]\s*)?\|?\s*$([regex]::Escape($scenarioId))\b[^\r\n]*\bPASS\b"
      Add-Check "manual-evidence-$scenarioId" ($manualEvidenceText -match $scenarioEvidencePattern) "manual evidence records $scenarioId as PASS"
      Add-Check "manual-evidence-$scenarioId-detail" (Test-ManualScenarioEvidenceDetail $manualEvidenceText $scenarioId) "manual evidence records concrete detail for $scenarioId"
    }
  }
}

$requiredCheckIds = @(
  "release-app-start",
  "release-app-screenshot",
  "computer-screenshot-read",
  "computer-screenshot-health",
  "computer-list-windows",
  "computer-approval-lease",
  "computer-sensitive-approval",
  "computer-dangerous-key-combo",
  "computer-emergency-hotkey-command",
  "local-vision-missing-model-fail-open"
)
if (!$AllowMissingLocalVision) {
  $requiredCheckIds += "local-vision-real-model"
}

foreach ($id in $requiredCheckIds) {
  $check = Get-CheckById $evidence $id
  Add-Check "check-$id" ($check -and $check.passed -eq $true) ($(if ($check) { $check.detail } else { "missing check" }))
}

$allEvidenceChecksPass = @($evidence.checks | Where-Object { $_.passed -ne $true }).Count -eq 0
Add-Check "all-evidence-checks-pass" $allEvidenceChecksPass "all recorded QA checks passed"

$screenshot = $evidence.basic.screenshot
Add-Check "screenshot-dimensions" ($screenshot.width -gt 0 -and $screenshot.height -gt 0) "desktop screenshot $($screenshot.width)x$($screenshot.height)"
Add-Check "screenshot-not-blank" ($screenshot.health.suspiciousBlank -ne $true) "screenshot suspiciousBlank=$($screenshot.health.suspiciousBlank)"
Add-Check "windows-listed" ($evidence.basic.windows.count -gt 0) "listed $($evidence.basic.windows.count) windows"
Add-Check "approval-lease-created" ($evidence.basic.approval.leaseCreated -eq $true) "scoped approval lease was created"
Add-Check "sensitive-session-wide-rejected" ($evidence.basic.approval.sensitiveSessionWideRejected -eq $true) "sensitive session-wide approval was rejected"
Add-Check "dangerous-key-combo-rejected" ($evidence.basic.approval.dangerousKeyComboRejected -eq $true) "dangerous key combo approval preflight was rejected"
Add-Check "emergency-hotkey-toggled" ($evidence.basic.emergencyHotkey.toggled -eq $true) "emergency hotkey command toggled"
Add-Check "missing-model-empty-result" (
  $evidence.basic.missingLocalVision.returned -eq $true -and
  $evidence.basic.missingLocalVision.detections -eq 0 -and
  ($evidence.basic.missingLocalVision.timedOut -eq $true -or [string]$evidence.basic.missingLocalVision.error)
) "missing model returned empty structured result"

if (!$AllowMissingLocalVision) {
  $localVision = $evidence.localVision
  Add-Check "real-model-ran" ($localVision -and $localVision.timedOut -ne $true -and ![string]$localVision.error) "model=$($localVision.model), runtime=$($localVision.runtime), detections=$($localVision.detections), latency=$($localVision.latencyMs)ms"
  Add-Check "real-model-detections" ($localVision.detections -ge 1) "detections=$($localVision.detections)"
}

$failed = @($script:Checks | Where-Object { $_.Passed -ne $true })

Write-Host "Computer Use QA evidence root: $(ConvertTo-RepoRelativePath $qaRootPath)"
Write-Host ""
$script:Checks | ForEach-Object {
  $status = if ($_.Passed) { "PASS" } else { "FAIL" }
  Write-Host ("[{0}] {1}: {2}" -f $status, $_.Id, $_.Detail)
}

if ($failed.Count -gt 0) {
  throw "Computer Use QA evidence has $($failed.Count) failing check(s)."
}

Write-Host ""
Write-Host "Computer Use QA evidence verified."
