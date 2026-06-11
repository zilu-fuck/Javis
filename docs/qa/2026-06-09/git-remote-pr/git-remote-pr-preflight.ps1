param(
  [string]$WorkspacePath = "",
  [string]$RemoteName = "origin",
  [string[]]$ProtectedBranches = @("main", "master", "develop"),
  [switch]$RequireGhAuth,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$qaDir = $PSScriptRoot
if (!$OutputPath.Trim()) {
  $OutputPath = Join-Path $qaDir "git-remote-pr-preflight-output.txt"
}

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

function Add-Check($checks, $id, $passed, $detail) {
  $checks.Add([ordered]@{
    id = $id
    passed = [bool]$passed
    detail = [string]$detail
  }) | Out-Null
}

function Invoke-Git($cwd, [string[]]$arguments, [switch]$AllowFailure) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & git -C $cwd @arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0 -and !$AllowFailure) {
    throw "git $($arguments -join ' ') failed in $cwd`n$($output -join "`n")"
  }
  return [ordered]@{
    exitCode = $exitCode
    output = ($output -join "`n").Trim()
  }
}

function Invoke-External($file, [string[]]$arguments, [switch]$AllowFailure) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & $file @arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0 -and !$AllowFailure) {
    throw "$file $($arguments -join ' ') failed`n$($output -join "`n")"
  }
  return [ordered]@{
    exitCode = $exitCode
    output = ($output -join "`n").Trim()
  }
}

if (!$WorkspacePath.Trim()) {
  $WorkspacePath = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
}
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$checks = [System.Collections.Generic.List[object]]::new()

$gitPresent = [bool](Get-Command git -ErrorAction SilentlyContinue)
Add-Check $checks "git-present" $gitPresent "git executable is available"
if (!$gitPresent) {
  throw "git executable is required for Git/PR preflight."
}

$inside = Invoke-Git $workspace @("rev-parse", "--is-inside-work-tree") -AllowFailure
$isRepo = $inside.exitCode -eq 0 -and $inside.output -eq "true"
Add-Check $checks "git-worktree" $isRepo "workspace=$workspace"
if (!$isRepo) {
  throw "Workspace is not a Git worktree: $workspace"
}

$branch = (Invoke-Git $workspace @("branch", "--show-current")).output
$branchAllowed = $branch -and ($ProtectedBranches -notcontains $branch)
Add-Check $checks "qa-branch-not-protected" $branchAllowed "branch=$branch; protected=$($ProtectedBranches -join ',')"

$remote = Invoke-Git $workspace @("remote", "get-url", $RemoteName) -AllowFailure
$hasRemote = $remote.exitCode -eq 0 -and $remote.output.Trim().Length -gt 0
Add-Check $checks "remote-url" $hasRemote "$RemoteName=$($remote.output)"

$status = (Invoke-Git $workspace @("status", "--short")).output
Add-Check $checks "working-tree-status-readable" $true $(if ($status) { "status has changes" } else { "status is clean" })

$upstream = Invoke-Git $workspace @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") -AllowFailure
Add-Check $checks "upstream-readable" ($upstream.exitCode -eq 0) $(if ($upstream.exitCode -eq 0) { "upstream=$($upstream.output)" } else { "no upstream configured yet" })

$ghPresent = [bool](Get-Command gh -ErrorAction SilentlyContinue)
Add-Check $checks "gh-present" $ghPresent "GitHub CLI availability"
if ($ghPresent) {
  $auth = Invoke-External "gh" @("auth", "status") -AllowFailure
  Add-Check $checks "gh-auth-status" ($auth.exitCode -eq 0 -or !$RequireGhAuth) $(if ($auth.exitCode -eq 0) { "gh auth status passed" } else { $auth.output })

  $repoView = Invoke-External "gh" @("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner") -AllowFailure
  Add-Check $checks "gh-repo-view" (($repoView.exitCode -eq 0 -and $repoView.output.Trim().Length -gt 0) -or !$RequireGhAuth) $(if ($repoView.exitCode -eq 0) { "repo=$($repoView.output)" } else { $repoView.output })

  $prList = Invoke-External "gh" @("pr", "list", "--limit", "1", "--json", "number", "--jq", "length") -AllowFailure
  Add-Check $checks "gh-pr-list-readable" ($prList.exitCode -eq 0 -or !$RequireGhAuth) $(if ($prList.exitCode -eq 0) { "PR list readable" } else { $prList.output })
} else {
  Add-Check $checks "gh-auth-status" (!$RequireGhAuth) "gh is not installed"
  Add-Check $checks "gh-repo-view" (!$RequireGhAuth) "gh is not installed"
  Add-Check $checks "gh-pr-list-readable" (!$RequireGhAuth) "gh is not installed"
}

$failed = @($checks | Where-Object { -not $_.passed })
$result = if ($failed.Count -eq 0) { "PASS" } else { "FAIL" }
$lines = @(
  "# Git Remote and PR Preflight",
  "",
  "generatedAt: $((Get-Date).ToUniversalTime().ToString("o"))",
  "workspace: $workspace",
  "remote: $RemoteName",
  "result: $result",
  "",
  "Checks:"
) + @($checks | ForEach-Object {
  $mark = if ($_.passed) { "PASS" } else { "FAIL" }
  "- [$mark] $($_.id): $($_.detail)"
})

Write-Utf8NoBom $OutputPath ($lines -join "`n")

if ($failed.Count -gt 0) {
  throw "Git/PR preflight failed $($failed.Count) check(s). See $OutputPath."
}

Write-Host "Git/PR preflight passed. Output: $OutputPath"
