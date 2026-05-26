[CmdletBinding()]
param(
  [string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Join-RepoPath {
  param([Parameter(Mandatory = $true)][string[]]$Parts)

  $path = $repoRoot
  foreach ($part in $Parts) {
    $path = Join-Path -Path $path -ChildPath $part
  }
  return $path
}

function Read-JsonVersion {
  param([Parameter(Mandatory = $true)][string]$Path)

  $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$json.version)) {
    throw "Missing version in $Path"
  }
  return [string]$json.version
}

function Read-CargoTomlPackageVersion {
  param([Parameter(Mandatory = $true)][string]$Path)

  $content = Get-Content -LiteralPath $Path -Raw
  $packageBlock = [regex]::Match($content, "(?ms)^\[package\]\s*(.*?)(?=^\[|\z)")
  if (-not $packageBlock.Success) {
    throw "Missing [package] block in $Path"
  }

  $versionMatch = [regex]::Match($packageBlock.Value, '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $versionMatch.Success) {
    throw "Missing package version in $Path"
  }

  return $versionMatch.Groups[1].Value
}

function Read-CargoLockPackageVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$PackageName
  )

  $content = Get-Content -LiteralPath $Path -Raw
  $blocks = [regex]::Split($content, '(?m)^\[\[package\]\]\s*$')
  foreach ($block in $blocks) {
    if ($block -match "(?m)^name\s*=\s*`"$([regex]::Escape($PackageName))`"$") {
      $versionMatch = [regex]::Match($block, '(?m)^version\s*=\s*"([^"]+)"')
      if ($versionMatch.Success) {
        return $versionMatch.Groups[1].Value
      }
    }
  }

  throw "Missing $PackageName package version in $Path"
}

function Assert-WindowsInstallerVersion {
  param([Parameter(Mandatory = $true)][string]$Version)

  $match = [regex]::Match($Version, '^(\d+)\.(\d+)\.(\d+)$')
  if (-not $match.Success) {
    throw "Windows release version must be numeric major.minor.patch, for example 1.2.3. MSI builds cannot use prerelease or build metadata."
  }

  $major = [int]$match.Groups[1].Value
  $minor = [int]$match.Groups[2].Value
  $patch = [int]$match.Groups[3].Value

  if ($major -gt 255 -or $minor -gt 255 -or $patch -gt 65535) {
    throw "Windows MSI version fields are out of range. Use major/minor <= 255 and patch <= 65535."
  }
}

$versions = [ordered]@{
  "package.json" = Read-JsonVersion (Join-RepoPath @("package.json"))
  "apps/desktop/package.json" = Read-JsonVersion (Join-RepoPath @("apps", "desktop", "package.json"))
  "apps/desktop/src-tauri/tauri.conf.json" = Read-JsonVersion (Join-RepoPath @("apps", "desktop", "src-tauri", "tauri.conf.json"))
  "apps/desktop/src-tauri/Cargo.toml" = Read-CargoTomlPackageVersion (Join-RepoPath @("apps", "desktop", "src-tauri", "Cargo.toml"))
  "apps/desktop/src-tauri/Cargo.lock" = Read-CargoLockPackageVersion (Join-RepoPath @("apps", "desktop", "src-tauri", "Cargo.lock")) "javis-desktop"
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
  $versions["expected"] = $ExpectedVersion
}

$uniqueVersions = @($versions.Values | Sort-Object -Unique)
if ($uniqueVersions.Count -ne 1) {
  foreach ($key in $versions.Keys) {
    Write-Host ("{0}: {1}" -f $key, $versions[$key])
  }
  throw "Release version values are not aligned."
}

$releaseVersion = $uniqueVersions[0]
Assert-WindowsInstallerVersion $releaseVersion

Write-Host "Release version is aligned for Windows installers: $releaseVersion"
