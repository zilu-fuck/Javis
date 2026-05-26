[CmdletBinding()]
param(
  [string]$Version,
  [string]$CertificateThumbprint = $env:JAVIS_WINDOWS_CERT_THUMBPRINT,
  [string]$TimestampUrl = $(if ($env:JAVIS_WINDOWS_TIMESTAMP_URL) { $env:JAVIS_WINDOWS_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }),
  [ValidateSet("sha256")]
  [string]$DigestAlgorithm = "sha256",
  [switch]$SkipChecks
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

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

$CertificateThumbprint = ([string]$CertificateThumbprint -replace '\s', '').ToUpperInvariant()
if ($CertificateThumbprint -notmatch '^[0-9A-F]{40}$') {
  throw "Set JAVIS_WINDOWS_CERT_THUMBPRINT, or pass -CertificateThumbprint, to the SHA1 thumbprint of a code signing certificate."
}

$cert = Get-ChildItem -Path Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
  Where-Object { $_.Thumbprint -eq $CertificateThumbprint } |
  Select-Object -First 1

if (-not $cert) {
  throw "Certificate $CertificateThumbprint was not found in CurrentUser\My or LocalMachine\My."
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $tauriConfig = Get-Content -LiteralPath (Join-RepoPath @("apps", "desktop", "src-tauri", "tauri.conf.json")) -Raw | ConvertFrom-Json
  $Version = [string]$tauriConfig.version
}

$checkArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $checkArgs += @("-ExpectedVersion", $Version)
}
& (Join-Path $PSScriptRoot "check-release-version.ps1") @checkArgs

if (-not $SkipChecks) {
  Push-Location $repoRoot
  try {
    Invoke-CheckedCommand "pnpm" @("check") "pnpm check failed; signed release build was not created."
  } finally {
    Pop-Location
  }
}

$windowsConfig = [ordered]@{
  digestAlgorithm = $DigestAlgorithm
  certificateThumbprint = $CertificateThumbprint
  timestampUrl = $TimestampUrl
  allowDowngrades = $false
  wix = [ordered]@{
    upgradeCode = "b443f13b-df09-5c55-b75e-c66eed973e79"
  }
}

if ($env:JAVIS_WINDOWS_TIMESTAMP_TSP -eq "1") {
  $windowsConfig["tsp"] = $true
}

$config = [ordered]@{
  bundle = [ordered]@{
    targets = @("msi", "nsis")
    windows = $windowsConfig
  }
} | ConvertTo-Json -Depth 8 -Compress

$buildStartedAt = Get-Date

Push-Location $repoRoot
try {
  Invoke-CheckedCommand "pnpm" @(
    "--filter", "@javis/desktop",
    "tauri", "build",
    "--bundles", "msi", "nsis",
    "--ci",
    "--config", $config
  ) "Tauri signed Windows build failed."
} finally {
  Pop-Location
}

$artifactQueries = @(
  @{
    Name = "MSI"
    Dir = Join-RepoPath @("apps", "desktop", "src-tauri", "target", "release", "bundle", "msi")
    Filter = "Javis_${Version}_*.msi"
  },
  @{
    Name = "NSIS"
    Dir = Join-RepoPath @("apps", "desktop", "src-tauri", "target", "release", "bundle", "nsis")
    Filter = "Javis_${Version}_*-setup.exe"
  }
)

$artifacts = @()
foreach ($query in $artifactQueries) {
  if (-not (Test-Path -LiteralPath $query.Dir)) {
    throw "$($query.Name) artifact directory was not found: $($query.Dir)"
  }

  $matches = @(Get-ChildItem -LiteralPath $query.Dir -Filter $query.Filter |
    Where-Object { $_.LastWriteTime -ge $buildStartedAt } |
    Sort-Object LastWriteTime -Descending)
  if ($matches.Count -eq 0) {
    throw "$($query.Name) artifact from the current build was not found with filter $($query.Filter)."
  }

  $artifacts += $matches[0]
}

$summary = @()
foreach ($artifact in $artifacts) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
  if ($signature.Status -ne "Valid") {
    throw "Signature verification failed for $($artifact.FullName): $($signature.Status)"
  }

  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint) {
    throw "Signature certificate mismatch for $($artifact.FullName)."
  }

  $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName
  $summary += [PSCustomObject]@{
    Artifact = $artifact.FullName
    Signature = $signature.Status
    SHA256 = $hash.Hash
  }
}

$summary | Format-Table -AutoSize
Write-Host "Signed Windows release artifacts are ready for version $Version."
