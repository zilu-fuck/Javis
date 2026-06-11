param(
  [string]$QaRoot = (Join-Path $PSScriptRoot "..\..\docs\qa"),
  [switch]$AllowKnownBlockers,
  [switch]$Json
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

function New-TrendHotListJsonRequirement($Label, [string[]]$Names) {
  return [ordered]@{
    Kind = "trend-hot-list-json"
    Label = $Label
    Names = $Names
  }
}

function New-JsonPassFieldsRequirement($Label, [string[]]$Names, [string[]]$Fields) {
  return [ordered]@{
    Kind = "json-pass-fields"
    Label = $Label
    Names = $Names
    Fields = $Fields
  }
}

function New-ArtifactReferenceRequirement($Label, [string[]]$Names) {
  return [ordered]@{
    Kind = "artifact-reference"
    Label = $Label
    Names = $Names
  }
}

function New-ReleaseConsistencyRequirement($Label) {
  return [ordered]@{
    Kind = "release-consistency"
    Label = $Label
  }
}

function New-PackagedQaOutputRequirements([string[]]$Names) {
  return @(
    New-TextRequirement "QA output records packaged app context" '(?im)"?(packaged[-_ ]?app|PackagedApp)"?\s*[:=]\s*(PASS|true|yes)' $Names
    New-TextRequirement "QA output records app version or build" '(?im)"?(app[-_ ]?version|build|BuildVersion|AppVersion)"?\s*[:=]\s*"?\S+' $Names
    New-TextRequirement "QA output records concrete QA date" '(?im)"?(date|QaDate|QA Date)"?\s*[:=]\s*"?20\d{2}-\d{2}-\d{2}' $Names
    New-TextRequirement "QA output references evidence artifacts" '(?im)"?(artifacts?|screenshots?|Artifacts|Screenshots)"?\s*[:=]\s*\S+|\.(png|json|md)\b' $Names
    New-ArtifactReferenceRequirement "QA output artifact references exist" $Names
  )
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

function Test-ArtifactReferences([string[]]$Names) {
  $files = $script:TextQaFiles
  if ($Names.Count -gt 0) {
    $files = @(
      foreach ($name in $Names) {
        $script:TextQaFiles | Where-Object { $_.Name -ieq $name }
      }
    )
  }
  $found = @()
  $missing = @()
  foreach ($file in $files) {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    $matches = [regex]::Matches($text, '(?i)([^\\/:*?"<>|\s,''\[\]\(\)]+?\.(?:png|json|md))')
    foreach ($match in $matches) {
      $artifactName = [System.IO.Path]::GetFileName($match.Groups[1].Value.Trim())
      if (!$artifactName) {
        continue
      }
      $artifactPath = Find-Artifact @($artifactName)
      if ($artifactPath) {
        $found += [ordered]@{
          OutputPath = $file.FullName
          ArtifactPath = $artifactPath
        }
      } else {
        $missing += [ordered]@{
          OutputPath = $file.FullName
          ArtifactName = $artifactName
        }
      }
    }
  }
  return [ordered]@{
    Found = $found
    Missing = $missing
  }
}

function Get-JsonPropertyValue($Object, [string[]]$Names) {
  foreach ($name in $Names) {
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $name) {
      return $Object.$name
    }
  }
  return $null
}

function Get-JsonEvidenceObject($FilePath) {
  $text = [System.IO.File]::ReadAllText($FilePath)
  try {
    return $text | ConvertFrom-Json
  } catch {
    $match = [regex]::Match($text, '(?s)(?:^|\r?\n)json:\s*(\{.*\})\s*$')
    if (!$match.Success) {
      return $null
    }
    try {
      return $match.Groups[1].Value | ConvertFrom-Json
    } catch {
      return $null
    }
  }
}

function Test-JsonPassFields([string[]]$Names, [string[]]$Fields) {
  foreach ($name in $Names) {
    $file = $script:TextQaFiles |
      Where-Object { $_.Name -ieq $name } |
      Sort-Object FullName |
      Select-Object -First 1
    if (!$file) {
      continue
    }
    $json = Get-JsonEvidenceObject $file.FullName
    if ($null -eq $json) {
      continue
    }
    $missingOrNotPass = @()
    foreach ($field in $Fields) {
      $value = [string](Get-JsonPropertyValue $json @($field))
      if ($value.ToLowerInvariant() -ne "pass") {
        $missingOrNotPass += $field
      }
    }
    if ($missingOrNotPass.Count -eq 0) {
      return [ordered]@{
        Passed = $true
        Evidence = ConvertTo-RepoRelativePath $file.FullName
      }
    }
  }
  return [ordered]@{
    Passed = $false
    Evidence = "missing JSON pass fields [$($Fields -join ', ')] in $($Names -join ' | ')"
  }
}

function Get-MarkdownListValue([string]$Text, [string]$Label) {
  $escaped = [regex]::Escape($Label)
  $match = [regex]::Match($Text, "(?im)^\s*-\s+$escaped\s*:\s*(.+?)\s*$")
  if ($match.Success) {
    return $match.Groups[1].Value.Trim()
  }
  return ""
}

function Get-ReleaseSummaryArtifact($Summary, [string]$ExtensionPattern) {
  $artifacts = @(Get-JsonPropertyValue $Summary @("artifacts", "Artifacts"))
  foreach ($artifact in $artifacts) {
    $path = [string](Get-JsonPropertyValue $artifact @("Artifact", "artifact", "path", "Path"))
    if ($path -match $ExtensionPattern) {
      return $artifact
    }
  }
  return $null
}

function Test-ReleaseEvidenceConsistency {
  $summaryPath = Find-Artifact @("release-build-summary.json")
  $notesPath = Find-Artifact @("release-rollback-notes.md", "rollback-notes.md")
  if (!$summaryPath -or !$notesPath) {
    return [ordered]@{
      Passed = $false
      Evidence = "missing release-build-summary.json or release-rollback-notes.md"
    }
  }

  try {
    $summary = [System.IO.File]::ReadAllText($summaryPath) | ConvertFrom-Json
  } catch {
    return [ordered]@{
      Passed = $false
      Evidence = "$(ConvertTo-RepoRelativePath $summaryPath) is not valid JSON"
    }
  }

  $notes = [System.IO.File]::ReadAllText($notesPath)
  $summaryVersion = [string](Get-JsonPropertyValue $summary @("version", "Version"))
  $notesVersion = Get-MarkdownListValue $notes "Build version"
  if ($summaryVersion -ne $notesVersion) {
    return [ordered]@{
      Passed = $false
      Evidence = "version mismatch: summary=$summaryVersion notes=$notesVersion"
    }
  }

  $summaryCommit = [string](Get-JsonPropertyValue $summary @("commit", "Commit"))
  $notesCommit = Get-MarkdownListValue $notes "Commit"
  if ($summaryCommit -ne $notesCommit) {
    return [ordered]@{
      Passed = $false
      Evidence = "commit mismatch: summary=$summaryCommit notes=$notesCommit"
    }
  }

  $checks = @(
    [ordered]@{
      Label = "MSI"
      Artifact = Get-ReleaseSummaryArtifact $summary '\.msi$'
      NotesPath = Get-MarkdownListValue $notes "MSI"
      NotesSignature = Get-MarkdownListValue $notes "MSI signature"
      NotesThumbprint = Get-MarkdownListValue $notes "MSI signer thumbprint"
      NotesHash = Get-MarkdownListValue $notes "MSI SHA-256"
    }
    [ordered]@{
      Label = "NSIS"
      Artifact = Get-ReleaseSummaryArtifact $summary '(?:setup|installer)\.exe$'
      NotesPath = Get-MarkdownListValue $notes "NSIS"
      NotesSignature = Get-MarkdownListValue $notes "NSIS signature"
      NotesThumbprint = Get-MarkdownListValue $notes "NSIS signer thumbprint"
      NotesHash = Get-MarkdownListValue $notes "NSIS SHA-256"
    }
  )

  foreach ($check in $checks) {
    if (!$check.Artifact) {
      return [ordered]@{
        Passed = $false
        Evidence = "$($check.Label) artifact is missing from release-build-summary.json"
      }
    }
    $summaryPathValue = [string](Get-JsonPropertyValue $check.Artifact @("Artifact", "artifact", "path", "Path"))
    $summarySignature = [string](Get-JsonPropertyValue $check.Artifact @("Signature", "signature"))
    $summaryThumbprint = [string](Get-JsonPropertyValue $check.Artifact @("SignerThumbprint", "signerThumbprint"))
    $summaryHash = [string](Get-JsonPropertyValue $check.Artifact @("SHA256", "sha256"))
    if ($summaryPathValue -ne $check.NotesPath) {
      return [ordered]@{
        Passed = $false
        Evidence = "$($check.Label) path mismatch: summary=$summaryPathValue notes=$($check.NotesPath)"
      }
    }
    if ($summarySignature -ne $check.NotesSignature) {
      return [ordered]@{
        Passed = $false
        Evidence = "$($check.Label) signature mismatch: summary=$summarySignature notes=$($check.NotesSignature)"
      }
    }
    if ($summaryThumbprint -ne $check.NotesThumbprint) {
      return [ordered]@{
        Passed = $false
        Evidence = "$($check.Label) signer thumbprint mismatch"
      }
    }
    if ($summaryHash -ne $check.NotesHash) {
      return [ordered]@{
        Passed = $false
        Evidence = "$($check.Label) SHA-256 mismatch"
      }
    }
  }

  return [ordered]@{
    Passed = $true
    Evidence = "$(ConvertTo-RepoRelativePath $summaryPath) matches $(ConvertTo-RepoRelativePath $notesPath)"
  }
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

  if ($Requirement.Kind -eq "artifact-reference") {
    $result = Test-ArtifactReferences $Requirement.Names
    $scope = if ($Requirement.Names.Count -gt 0) { " in $($Requirement.Names -join ' | ')" } else { "" }
    $missing = @($result.Missing)
    $found = @($result.Found)
    $passed = $found.Count -gt 0 -and $missing.Count -eq 0
    return [ordered]@{
      Label = $Requirement.Label
      Passed = $passed
      Evidence = if ($passed) {
        ($found | ForEach-Object {
          "$(ConvertTo-RepoRelativePath $_.OutputPath) -> $(ConvertTo-RepoRelativePath $_.ArtifactPath)"
        }) -join "; "
      } elseif ($missing.Count -gt 0) {
        ($missing | ForEach-Object {
          "$(ConvertTo-RepoRelativePath $_.OutputPath) -> missing $($_.ArtifactName)"
        }) -join "; "
      } else {
        "missing existing artifact reference$($scope)"
      }
    }
  }

  if ($Requirement.Kind -eq "trend-hot-list-json") {
    foreach ($name in $Requirement.Names) {
      $file = $script:TextQaFiles |
        Where-Object { $_.Name -ieq $name } |
        Sort-Object FullName |
        Select-Object -First 1
      if (!$file) {
        continue
      }
      try {
        $json = Get-JsonEvidenceObject $file.FullName
        if ($null -eq $json) {
          continue
        }
        $toolName = [string]$json.toolName
        $provider = [string](Get-JsonPropertyValue $json @("Provider", "provider"))
        $requestedCount = [int](Get-JsonPropertyValue $json @("RequestedCount", "requestedCount", "limit"))
        $itemCount = [int](Get-JsonPropertyValue $json @("ItemCount", "itemCount"))
        $sourceUrl = [string](Get-JsonPropertyValue $json @("SourceUrl", "sourceUrl"))
        $diagnostics = @(Get-JsonPropertyValue $json @("Diagnostics", "diagnostics"))
        $report = Get-JsonPropertyValue $json @("ResearchReport", "researchReport")
        $sources = @(Get-JsonPropertyValue $report @("Sources", "sources"))
        if ($sources.Count -eq 0) {
          $sources = @(Get-JsonPropertyValue $json @("Sources", "sources"))
        }
        $completedDiagnostic = @($diagnostics | Where-Object { ([string](Get-JsonPropertyValue $_ @("Status", "status"))) -eq "completed" }).Count -gt 0
        if (
          $toolName -eq "trend.fetchHotList" -and
          $provider.Trim().Length -gt 0 -and
          $requestedCount -eq 20 -and
          $itemCount -gt 0 -and
          $sourceUrl -match "^https?://" -and
          $completedDiagnostic -and
          @($sources | Where-Object { ([string]$_) -match "^https?://" }).Count -gt 0
        ) {
          return [ordered]@{
            Label = $Requirement.Label
            Passed = $true
            Evidence = ConvertTo-RepoRelativePath $file.FullName
          }
        }
      } catch {
        continue
      }
    }
    return [ordered]@{
      Label = $Requirement.Label
      Passed = $false
      Evidence = "missing valid trend hot-list JSON evidence in $($Requirement.Names -join ' | ')"
    }
  }

  if ($Requirement.Kind -eq "json-pass-fields") {
    $result = Test-JsonPassFields $Requirement.Names $Requirement.Fields
    return [ordered]@{
      Label = $Requirement.Label
      Passed = [bool]$result.Passed
      Evidence = $result.Evidence
    }
  }

  if ($Requirement.Kind -eq "release-consistency") {
    $result = Test-ReleaseEvidenceConsistency
    return [ordered]@{
      Label = $Requirement.Label
      Passed = [bool]$result.Passed
      Evidence = $result.Evidence
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
      New-TextRequirement "Search QA output records github-cli screenshot" '09-search-github-cli-completed\.png|github-cli-fixture\s*:\s*PASS' @("research-search-qa-output.txt")
      New-TextRequirement "Search QA output records Agent Chrome screenshot" '10-search-agent-chrome-fallback-completed\.png|agent-chrome-fixture\s*:\s*PASS' @("research-search-qa-output.txt")
      New-TextRequirement "Search QA output records weak evidence screenshot" '11-search-weak-evidence-failed\.png|weak-evidence-failure\s*:\s*PASS' @("research-search-qa-output.txt")
      New-TextRequirement "Search QA output records failed fetch screenshot" '12-search-failed-fetch-state\.png|failed-fetch-state\s*:\s*PASS' @("research-search-qa-output.txt")
      New-TextRequirement "Search QA output records no results screenshot" '13-search-no-results-state\.png|no-results-state\s*:\s*PASS' @("research-search-qa-output.txt")
      New-TextRequirement "Live search output records github-cli screenshot" '14-search-live-github-cli-smoke\.png|live-github-cli\s*:\s*PASS' @("research-live-smoke-qa-output.txt")
      New-TextRequirement "Live search output records Agent Chrome screenshot" '15-search-live-agent-chrome-smoke\.png|live-agent-chrome\s*:\s*PASS' @("research-live-smoke-qa-output.txt")
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
      New-TextRequirement "Workspace output records before restart storage" '"StoredBeforeRestart"\s*:\s*"\[' @("workspace-restart-qa-output.txt")
      New-TextRequirement "Workspace output records after restart storage" '"StoredAfterRestart"\s*:\s*"\[' @("workspace-restart-qa-output.txt")
      New-TextRequirement "Workspace output records before screenshot" '01-workspace-recent-before-restart\.png' @("workspace-restart-qa-output.txt")
      New-TextRequirement "Workspace output records after screenshot" '02-workspace-recent-after-restart\.png' @("workspace-restart-qa-output.txt")
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
      New-TextRequirement "Code Agent output records denied fixture pass" '(?s)"Scenario"\s*:\s*"denied".*"FileText"\s*:\s*"hello reviewed"' @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Code Agent output records approved fixture pass" '(?s)"Scenario"\s*:\s*"approved".*"FileText"\s*:\s*"hello approved"' @("code-agent-opencode-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "code-agent-live-provider"
    Title = "Code Agent live provider proposal/apply"
    KnownBlocker = $true
    Requirements = @(
      New-PackagedQaOutputRequirements @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Live provider is configured" '"LiveProviderConfigured"\s*:\s*true' @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Live credential storage is enabled" '"LiveCredentialStorageEnabled"\s*:\s*true' @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Live provider approved apply passed" '(?s)"LiveResult"\s*:\s*\{.*"Scenario"\s*:\s*"live-approved".*"Status"\s*:\s*"pass"' @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Live output references proposal screenshot" '20-code-agent-live-proposal-before-approve\.png' @("code-agent-opencode-qa-output.txt")
      New-TextRequirement "Live output references approved screenshot" '20-code-agent-live-approved\.png|20-code-agent-live-apply-approved\.png' @("code-agent-opencode-qa-output.txt")
      New-FileRequirement "Live proposal before write approval" @("20-code-agent-live-proposal-before-approve.png")
      New-FileRequirement "Live approved apply result" @("20-code-agent-live-approved.png", "20-code-agent-live-apply-approved.png")
    )
  }
  [ordered]@{
    Id = "trend-hot-list-live"
    Title = "Structured hot-list research live/package workflow"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Trend hot-list report screenshot" @("38-trend-hot-list-report.png", "38-structured-hot-list-report.png")
      New-FileRequirement "Trend hot-list QA output" @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-PackagedQaOutputRequirements @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TrendHotListJsonRequirement "Trend output JSON schema is valid" @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TextRequirement "Trend output records structured tool" 'trend\.fetchHotList|"toolName"\s*:\s*"trend\.fetchHotList"' @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TextRequirement "Trend output records provider id" '"?(Provider|provider)"?\s*:\s*"\S+"' @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TextRequirement "Trend output records requested count" '"?(RequestedCount|requestedCount|limit)"?\s*:\s*20|top\s*20' @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TextRequirement "Trend output records non-empty item count" '"?(ItemCount|itemCount|items)"?\s*:\s*([1-9]|[1-9][0-9]+)' @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TextRequirement "Trend output records source URL" 'https?://\S+' @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TextRequirement "Trend output records completed diagnostics" '(?s)"?(Diagnostics|diagnostics)"?.*("?(Status|status)"?\s*:\s*"completed"|completed)' @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
      New-TextRequirement "Trend output records report sources" '(?s)(research[- ]?report|ResearchReport|sources|Sources)' @("trend-hot-list-live-qa-output.txt", "structured-hot-list-live-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "repo-intelligence-package-live"
    Title = "Repository intelligence package/live workflow"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Repository search key-files screenshot" @("42-repo-search-key-files.png")
      New-FileRequirement "Repository trace symbol graph screenshot" @("43-repo-trace-symbol-graph.png")
      New-FileRequirement "Repository intelligence QA output" @("repo-intelligence-package-live-qa-output.txt")
      New-PackagedQaOutputRequirements @("repo-intelligence-package-live-qa-output.txt")
      New-JsonPassFieldsRequirement "Repository output JSON status fields pass" @("repo-intelligence-package-live-qa-output.txt") @("keyFiles", "symbolGraph", "resolver", "packageHints", "registryEvidence", "fallbackDiagnostics")
      New-TextRequirement "Repository search records key files" 'key[-_ ]?files\s*:\s*PASS|"keyFiles"\s*:\s*"pass"' @("repo-intelligence-package-live-qa-output.txt")
      New-TextRequirement "Repository trace records symbol graph" 'symbol[-_ ]?graph\s*:\s*PASS|"symbolGraph"\s*:\s*"pass"' @("repo-intelligence-package-live-qa-output.txt")
      New-TextRequirement "Repository trace records resolver evidence" 'resolver\s*:\s*PASS|"resolver"\s*:\s*"pass"' @("repo-intelligence-package-live-qa-output.txt")
      New-TextRequirement "Repository trace records package hints" 'package[-_ ]?hints?\s*:\s*PASS|"packageHints"\s*:\s*"pass"' @("repo-intelligence-package-live-qa-output.txt")
      New-TextRequirement "Repository trace records external registry evidence" 'registry[-_ ]?evidence\s*:\s*PASS|"registryEvidence"\s*:\s*"pass"' @("repo-intelligence-package-live-qa-output.txt")
      New-TextRequirement "Repository search records fallback diagnostics" 'fallback[-_ ]?diagnostics\s*:\s*PASS|"fallbackDiagnostics"\s*:\s*"pass"' @("repo-intelligence-package-live-qa-output.txt")
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
      New-TextRequirement "PDF approval output records approved move" '(?s)"(Scenario|Decision)"\s*:\s*"approved".*"SourceExistsAfterDecision"\s*:\s*false.*"TargetExistsAfterDecision"\s*:\s*true.*"StoredStatus"\s*:\s*"approved"' @("pdf-durable-approval-qa-output.txt")
      New-TextRequirement "PDF approval output records denied no-op" '(?s)"(Scenario|Decision)"\s*:\s*"denied".*"SourceExistsAfterDecision"\s*:\s*true.*"TargetExistsAfterDecision"\s*:\s*false.*"StoredStatus"\s*:\s*"denied"' @("pdf-durable-approval-qa-output.txt")
      New-TextRequirement "PDF approval output records expired fail-closed" '(?s)"(Scenario|Decision)"\s*:\s*"expired".*"SourceExistsAfterDecision"\s*:\s*true.*"TargetExistsAfterDecision"\s*:\s*false.*"StoredStatus"\s*:\s*"expired"' @("pdf-durable-approval-qa-output.txt")
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
      New-TextRequirement "Code Patch output records approved apply" '(?s)"(Scenario|Decision)"\s*:\s*"approved".*"FileText"\s*:\s*"hello approved".*"StoredStatus"\s*:\s*"approved"' @("code-patch-durable-approval-qa-output.txt")
      New-TextRequirement "Code Patch output records denied no-op" '(?s)"(Scenario|Decision)"\s*:\s*"denied".*"FileText"\s*:\s*"hello reviewed".*"StoredStatus"\s*:\s*"denied"' @("code-patch-durable-approval-qa-output.txt")
      New-TextRequirement "Code Patch output records expired fail-closed" '(?s)"(Scenario|Decision)"\s*:\s*"expired".*"FileText"\s*:\s*"hello reviewed".*"StoredStatus"\s*:\s*"expired"' @("code-patch-durable-approval-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "git-remote-pr-writes"
    Title = "Git remote and pull request confirmed-write workflows"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Git Review panel status and PR list" @("31-git-review-status-pr-list.png")
      New-FileRequirement "Git stage approval card" @("32-git-stage-approval-card.png")
      New-FileRequirement "Git commit approval card" @("33-git-commit-approval-card.png")
      New-FileRequirement "Git push approval card" @("34-git-push-approval-card.png")
      New-FileRequirement "Git draft PR approval card" @("35-git-create-pr-approval-card.png")
      New-FileRequirement "Git PR comment approval card" @("36-git-comment-pr-approval-card.png")
      New-FileRequirement "Git restored approval after restart" @("37-git-restored-approval-after-restart.png")
      New-FileRequirement "Git workflow QA output" @("git-remote-pr-qa-output.txt")
      New-PackagedQaOutputRequirements @("git-remote-pr-qa-output.txt")
      New-JsonPassFieldsRequirement "Git workflow output JSON status fields pass" @("git-remote-pr-qa-output.txt") @("stage", "commit", "push", "prCreate", "prComment", "denial", "restore")
      New-TextRequirement "Git workflow output records stage pass" 'stage\s*:\s*PASS|"stage"\s*:\s*"pass"' @("git-remote-pr-qa-output.txt")
      New-TextRequirement "Git workflow output records commit pass" 'commit\s*:\s*PASS|"commit"\s*:\s*"pass"' @("git-remote-pr-qa-output.txt")
      New-TextRequirement "Git workflow output records push pass" 'push\s*:\s*PASS|"push"\s*:\s*"pass"' @("git-remote-pr-qa-output.txt")
      New-TextRequirement "Git workflow output records PR create pass" 'pr[-_ ]?create\s*:\s*PASS|"prCreate"\s*:\s*"pass"' @("git-remote-pr-qa-output.txt")
      New-TextRequirement "Git workflow output records PR comment pass" 'pr[-_ ]?comment\s*:\s*PASS|"prComment"\s*:\s*"pass"' @("git-remote-pr-qa-output.txt")
      New-TextRequirement "Git workflow output records denial fail-closed pass" 'den(y|ial)\s*:\s*PASS|"denial"\s*:\s*"pass"' @("git-remote-pr-qa-output.txt")
      New-TextRequirement "Git workflow output records restore pass" 'restore\s*:\s*PASS|"restore"\s*:\s*"pass"' @("git-remote-pr-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "browser-terminal-approvals"
    Title = "Browser and Terminal confirmed-write approval workflows"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Terminal start approval card" @("39-terminal-start-approval-card.png")
      New-FileRequirement "Terminal input approval card" @("40-terminal-input-approval-card.png")
      New-FileRequirement "Browser write approval card" @("41-browser-write-approval-card.png")
      New-FileRequirement "Browser and Terminal approval QA output" @("browser-terminal-approval-qa-output.txt")
      New-PackagedQaOutputRequirements @("browser-terminal-approval-qa-output.txt")
      New-JsonPassFieldsRequirement "Browser/Terminal output JSON status fields pass" @("browser-terminal-approval-qa-output.txt") @("terminalStart", "terminalInput", "browserWrite", "denial", "stalePreview", "oneShot")
      New-TextRequirement "Terminal start approval passes" 'terminal[-_ ]?start\s*:\s*PASS|"terminalStart"\s*:\s*"pass"' @("browser-terminal-approval-qa-output.txt")
      New-TextRequirement "Terminal input approval passes" 'terminal[-_ ]?input\s*:\s*PASS|"terminalInput"\s*:\s*"pass"' @("browser-terminal-approval-qa-output.txt")
      New-TextRequirement "Browser write approval passes" 'browser[-_ ]?write\s*:\s*PASS|"browserWrite"\s*:\s*"pass"' @("browser-terminal-approval-qa-output.txt")
      New-TextRequirement "Approval denial is fail-closed" 'den(y|ial)\s*:\s*PASS|"denial"\s*:\s*"pass"' @("browser-terminal-approval-qa-output.txt")
      New-TextRequirement "Stale preview is rejected" 'stale[-_ ]?preview\s*:\s*PASS|"stalePreview"\s*:\s*"pass"' @("browser-terminal-approval-qa-output.txt")
      New-TextRequirement "One-shot execution is enforced" 'one[-_ ]?shot\s*:\s*PASS|"oneShot"\s*:\s*"pass"' @("browser-terminal-approval-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "task-history-persistence"
    Title = "Task history restore and delete"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "Task history restored after restart" @("task-history-restored-after-restart.png")
      New-FileRequirement "Task history delete after restart" @("task-history-deleted-after-restart.png")
      New-FileRequirement "Task history QA output" @("task-history-qa-output.txt")
      New-TextRequirement "Task history output records restore pass" 'restore\s*:\s*PASS|"restore"\s*:\s*"pass"' @("task-history-qa-output.txt")
      New-TextRequirement "Task history output records delete pass" 'delete\s*:\s*PASS|"delete"\s*:\s*"pass"' @("task-history-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "model-secret-handling"
    Title = "Model settings and secret redaction"
    KnownBlocker = $false
    Requirements = @(
      New-FileRequirement "Secret redaction scan output" @("model-secret-redaction-qa-output.txt", "secret-scan-output.txt")
      New-TextRequirement "Secret scan reports no API keys" 'PASS|No API keys found|No secrets found|0 findings' @("model-secret-redaction-qa-output.txt", "secret-scan-output.txt")
      New-TextRequirement "Secret storage is exercised by QA output" '"LiveCredentialStorageEnabled"\s*:\s*true|save_model_api_key_secret' @("code-agent-opencode-qa-output.txt", "model-secret-redaction-qa-output.txt", "secret-scan-output.txt")
      New-TextRequirement "Secret redaction output records verdict pass" 'verdict\s*:\s*PASS|"verdict"\s*:\s*"pass"' @("model-secret-redaction-qa-output.txt", "secret-scan-output.txt")
    )
  }
  [ordered]@{
    Id = "agent-memory-embedding-provider-live"
    Title = "Agent memory embedding provider live/package workflow"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Embedding provider settings screenshot" @("44-agent-memory-embedding-settings.png")
      New-FileRequirement "Embedding provider QA output" @("agent-memory-embedding-provider-live-qa-output.txt")
      New-PackagedQaOutputRequirements @("agent-memory-embedding-provider-live-qa-output.txt")
      New-JsonPassFieldsRequirement "Embedding provider output JSON status fields pass" @("agent-memory-embedding-provider-live-qa-output.txt") @("localEmbedding", "nativeOpenAiCompatible", "secretReference", "vectorSearch")
      New-TextRequirement "Embedding mode can use local provider" 'local[-_ ]?embedding\s*:\s*PASS|"localEmbedding"\s*:\s*"pass"' @("agent-memory-embedding-provider-live-qa-output.txt")
      New-TextRequirement "Embedding mode can use native OpenAI-compatible provider" 'native[-_ ]?openai[-_ ]?compatible\s*:\s*PASS|"nativeOpenAiCompatible"\s*:\s*"pass"' @("agent-memory-embedding-provider-live-qa-output.txt")
      New-TextRequirement "Embedding secret is referenced, not logged" 'secret[-_ ]?reference\s*:\s*PASS|"secretReference"\s*:\s*"pass"' @("agent-memory-embedding-provider-live-qa-output.txt")
      New-TextRequirement "Embedding vector search is exercised" 'vector[-_ ]?search\s*:\s*PASS|"vectorSearch"\s*:\s*"pass"' @("agent-memory-embedding-provider-live-qa-output.txt")
    )
  }
  [ordered]@{
    Id = "capability-scoring-evidence-ingestion"
    Title = "Capability scoring QA/live evidence ingestion"
    KnownBlocker = $true
    Requirements = @(
      New-FileRequirement "Capability score inspector evidence" @("45-capability-scoring-evidence-ingestion.png")
      New-FileRequirement "Capability scoring ingestion QA output" @("capability-scoring-evidence-ingestion-qa-output.txt")
      New-PackagedQaOutputRequirements @("capability-scoring-evidence-ingestion-qa-output.txt")
      New-JsonPassFieldsRequirement "Capability scoring output JSON status fields pass" @("capability-scoring-evidence-ingestion-qa-output.txt") @("qaEvidence", "liveEvidence", "evidenceRefs", "recentFailureRate")
      New-TextRequirement "Capability scoring ingests QA evidence" 'qa[-_ ]?evidence\s*:\s*PASS|"qaEvidence"\s*:\s*"pass"' @("capability-scoring-evidence-ingestion-qa-output.txt")
      New-TextRequirement "Capability scoring ingests live evidence" 'live[-_ ]?evidence\s*:\s*PASS|"liveEvidence"\s*:\s*"pass"' @("capability-scoring-evidence-ingestion-qa-output.txt")
      New-TextRequirement "Capability scoring displays evidence refs" 'evidence[-_ ]?refs?\s*:\s*PASS|"evidenceRefs"\s*:\s*"pass"' @("capability-scoring-evidence-ingestion-qa-output.txt")
      New-TextRequirement "Capability scoring records concrete evidence references" '(?is)"EvidenceReferences"\s*:\s*\[\s*"[^"]+"' @("capability-scoring-evidence-ingestion-qa-output.txt")
      New-TextRequirement "Capability scoring displays recent failure rate" 'recent[-_ ]?failure[-_ ]?rate\s*:\s*PASS|"recentFailureRate"\s*:\s*"pass"' @("capability-scoring-evidence-ingestion-qa-output.txt")
      New-TextRequirement "Capability scoring records numeric recent failure rate" '(?i)"RecentFailureRateValue"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)' @("capability-scoring-evidence-ingestion-qa-output.txt")
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
      New-FileRequirement "Release build summary" @("release-build-summary.json")
      New-TextRequirement "Build summary is generated by signed build helper" '"generatedBy"\s*:\s*"scripts/release/build-windows-signed\.ps1"' @("release-build-summary.json")
      New-TextRequirement "Build summary records release version" '"version"\s*:\s*"\d+\.\d+\.\d+"' @("release-build-summary.json")
      New-TextRequirement "Build summary records commit" '"commit"\s*:\s*"[0-9a-f]{7,40}"' @("release-build-summary.json")
      New-TextRequirement "Build summary records certificate thumbprint" '"certificateThumbprint"\s*:\s*"[A-Fa-f0-9]{40}"' @("release-build-summary.json")
      New-TextRequirement "Build summary records MSI artifact" '"Artifact"\s*:\s*"[^"]+\.msi"' @("release-build-summary.json")
      New-TextRequirement "Build summary records NSIS artifact" '"Artifact"\s*:\s*"[^"]+(?:setup|installer)\.exe"' @("release-build-summary.json")
      New-TextRequirement "Build summary records valid signatures" '(?s)"Signature"\s*:\s*"Valid".*"Signature"\s*:\s*"Valid"' @("release-build-summary.json")
      New-TextRequirement "Build summary records signer thumbprints" '(?s)"SignerThumbprint"\s*:\s*"[A-Fa-f0-9]{40}".*"SignerThumbprint"\s*:\s*"[A-Fa-f0-9]{40}"' @("release-build-summary.json")
      New-TextRequirement "Build summary records artifact hashes" '(?s)"SHA256"\s*:\s*"[A-Fa-f0-9]{64}".*"SHA256"\s*:\s*"[A-Fa-f0-9]{64}"' @("release-build-summary.json")
      New-FileRequirement "Release rollback notes" @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "Rollback notes are generated by release helper" 'generated-by:\s*scripts/release/write-release-rollback-notes\.ps1' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "Release version is recorded" 'Build version:\s*\d+\.\d+\.\d+' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "Commit is recorded" 'Commit:\s*[0-9a-f]{7,40}' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "Previous known-good build is recorded" 'Previous known-good build:\s*\S+' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "Previous artifact SHA-256 is recorded" 'Previous artifact SHA-256:\s*(?:[A-Fa-f0-9]{64}|none)' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "MSI artifact path is recorded" 'MSI:\s*\S+\.msi' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "NSIS artifact path is recorded" 'NSIS:\s*\S+(?:setup|installer)\.exe' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "MSI signature is valid" 'MSI signature:\s*Valid' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "NSIS signature is valid" 'NSIS signature:\s*Valid' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "MSI signer thumbprint is recorded" 'MSI signer thumbprint:\s*[A-Fa-f0-9]{40}' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "NSIS signer thumbprint is recorded" 'NSIS signer thumbprint:\s*[A-Fa-f0-9]{40}' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "MSI hash is recorded" 'MSI SHA-256:\s*[A-Fa-f0-9]{64}' @("release-rollback-notes.md", "rollback-notes.md")
      New-TextRequirement "NSIS hash is recorded" 'NSIS SHA-256:\s*[A-Fa-f0-9]{64}' @("release-rollback-notes.md", "rollback-notes.md")
      New-ReleaseConsistencyRequirement "Release build summary matches rollback notes"
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

$failed = @($results | Where-Object { $_.Status -eq "FAIL" })
$blocked = @($results | Where-Object { $_.Status -eq "BLOCKED" })

if ($Json) {
  [ordered]@{
    qaRoot = ConvertTo-RepoRelativePath $qaRootPath
    allowKnownBlockers = [bool]$AllowKnownBlockers
    scenarios = $results
    missingDetails = $missingDetails
  } | ConvertTo-Json -Depth 8
} else {
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
}

if ($failed.Count -gt 0) {
  throw "Product workflow QA evidence has $($failed.Count) failing scenario(s)."
}

if ($blocked.Count -gt 0 -and !$AllowKnownBlockers) {
  throw "Product workflow QA evidence has $($blocked.Count) known blocker(s). Re-run with -AllowKnownBlockers only for development inventory."
}

if ($blocked.Count -gt 0) {
  if (!$Json) {
    Write-Host ""
    Write-Host "Known blockers are allowed for this development inventory run."
  }
}
