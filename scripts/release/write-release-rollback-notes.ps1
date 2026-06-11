[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$QaRoot = "",
  [string]$MsiPath = "",
  [string]$NsisPath = "",
  [Parameter(Mandatory = $true)]
  [string]$PreviousKnownGoodBuild,
  [string]$PreviousArtifactLocation = "",
  [string]$PreviousArtifactSha256 = "",
  [ValidateSet("yes", "no")]
  [string]$StorageSchemaChanges = "no",
  [string]$StorageSchemaDetails = "none",
  [ValidateSet("yes", "no")]
  [string]$PermissionStateChanges = "no",
  [ValidateSet("yes", "no")]
  [string]$UserDataFormatChanges = "no",
  [string]$NonDowngradableData = "none"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (!$QaRoot.Trim()) {
  $QaRoot = Join-Path $repoRoot ("docs\qa\" + (Get-Date -Format "yyyy-MM-dd"))
}
New-Item -ItemType Directory -Force -Path $QaRoot | Out-Null

if (!$Version.Trim()) {
  $tauriConfigPath = Join-Path $repoRoot "apps\desktop\src-tauri\tauri.conf.json"
  $Version = [string]((Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json).version)
}

$normalizedPreviousBuild = $PreviousKnownGoodBuild.Trim().ToLowerInvariant()
$isFirstRelease = $normalizedPreviousBuild -match "^(none|first release|none\s*-\s*first release)$"
if (!$isFirstRelease -and $PreviousArtifactSha256.Trim() -notmatch "^[0-9A-Fa-f]{64}$") {
  throw "PreviousArtifactSha256 must be a 64-character SHA-256 hash unless PreviousKnownGoodBuild is 'none'."
}
if ($isFirstRelease -and !$PreviousArtifactSha256.Trim()) {
  $PreviousArtifactSha256 = "none"
}

function Resolve-Artifact {
  param(
    [string]$ExplicitPath,
    [string]$Directory,
    [string]$Filter,
    [string]$Label
  )

  if ($ExplicitPath.Trim()) {
    if (!(Test-Path -LiteralPath $ExplicitPath)) {
      throw "$Label artifact not found: $ExplicitPath"
    }
    return (Resolve-Path -LiteralPath $ExplicitPath).Path
  }

  $dirPath = Join-Path $repoRoot $Directory
  if (!(Test-Path -LiteralPath $dirPath)) {
    throw "$Label artifact directory not found: $dirPath"
  }
  $matches = @(Get-ChildItem -LiteralPath $dirPath -Filter $Filter | Sort-Object LastWriteTime -Descending)
  if ($matches.Count -eq 0) {
    throw "$Label artifact not found in $dirPath with filter $Filter"
  }
  return $matches[0].FullName
}

function ConvertTo-RepoRelativePath($Path) {
  $fullPath = (Resolve-Path -LiteralPath $Path).Path
  if ($fullPath.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath.Substring($repoRoot.Length).TrimStart("\", "/")
  }
  return $fullPath
}

function Get-VerifiedArtifact($Path, $Label) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne "Valid") {
    throw "$Label signature is not valid: $($signature.Status)"
  }
  $thumbprint = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Thumbprint } else { "" }
  if ($thumbprint -notmatch "^[0-9A-Fa-f]{40}$") {
    throw "$Label signature is valid but signer thumbprint is missing or invalid."
  }
  $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $Path
  return [ordered]@{
    Path = $Path
    RelativePath = ConvertTo-RepoRelativePath $Path
    SignatureStatus = [string]$signature.Status
    SignerThumbprint = $thumbprint.ToUpperInvariant()
    SHA256 = [string]$hash.Hash
  }
}

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

$msi = Resolve-Artifact $MsiPath "apps\desktop\src-tauri\target\release\bundle\msi" "Javis_${Version}_*.msi" "MSI"
$nsis = Resolve-Artifact $NsisPath "apps\desktop\src-tauri\target\release\bundle\nsis" "Javis_${Version}_*-setup.exe" "NSIS"
$msiInfo = Get-VerifiedArtifact $msi "MSI"
$nsisInfo = Get-VerifiedArtifact $nsis "NSIS"
if ($msiInfo.SignerThumbprint -ne $nsisInfo.SignerThumbprint) {
  throw "MSI and NSIS artifacts were signed by different certificates."
}
$commit = ((& git -C $repoRoot rev-parse HEAD) | Select-Object -First 1).Trim()

$outputPath = Join-Path $QaRoot "release-rollback-notes.md"
$lines = @(
  "# Release Rollback Notes",
  "",
  "<!-- generated-by: scripts/release/write-release-rollback-notes.ps1 -->",
  "",
  "## Rollback Record - Javis $Version ($(Get-Date -Format "yyyy-MM-dd"))",
  "",
  "- Build version: $Version",
  "- Commit: $commit",
  "- Previous known-good build: $PreviousKnownGoodBuild",
  "- Previous artifact location: $PreviousArtifactLocation",
  "- Previous artifact SHA-256: $PreviousArtifactSha256",
  "- Storage schema changes: $StorageSchemaChanges",
  "- Storage schema details: $StorageSchemaDetails",
  "- Permission state changes: $PermissionStateChanges",
  "- User data format changes: $UserDataFormatChanges",
  "- Non-downgradable data: $NonDowngradableData",
  "",
  "## Artifacts",
  "",
  "- MSI: $($msiInfo.RelativePath)",
  "- MSI signature: $($msiInfo.SignatureStatus)",
  "- MSI signer thumbprint: $($msiInfo.SignerThumbprint)",
  "- MSI SHA-256: $($msiInfo.SHA256)",
  "- NSIS: $($nsisInfo.RelativePath)",
  "- NSIS signature: $($nsisInfo.SignatureStatus)",
  "- NSIS signer thumbprint: $($nsisInfo.SignerThumbprint)",
  "- NSIS SHA-256: $($nsisInfo.SHA256)",
  "",
  "## Rollback Steps",
  "",
  "1. Close Javis and verify no background process is running.",
  "2. If schemas changed, back up `%LOCALAPPDATA%\app.javis.desktop` before uninstalling.",
  "3. Uninstall the candidate build via Windows Settings > Apps.",
  "4. Install the previous known-good signed artifact.",
  "5. Launch Javis, verify the version, and rerun restart QA for task history, workspace recovery, and approval records."
)

Write-Utf8NoBom $outputPath ($lines -join "`n")
Write-Host "Release rollback notes written: $outputPath"
