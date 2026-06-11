[CmdletBinding()]
param(
  [string]$Version,
  [string]$CertificateThumbprint = $env:JAVIS_WINDOWS_CERT_THUMBPRINT,
  [string]$TimestampUrl = $(if ($env:JAVIS_WINDOWS_TIMESTAMP_URL) { $env:JAVIS_WINDOWS_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }),
  [ValidateSet("sha256")]
  [string]$DigestAlgorithm = "sha256",
  [string]$QaRoot = "",
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

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

function ConvertTo-RepoRelativePath($Path) {
  $fullPath = (Resolve-Path -LiteralPath $Path).Path
  if ($fullPath.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath.Substring($repoRoot.Length).TrimStart("\", "/")
  }
  return $fullPath
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

if (!$QaRoot.Trim()) {
  $QaRoot = Join-Path $repoRoot ("docs\qa\" + (Get-Date -Format "yyyy-MM-dd"))
}
New-Item -ItemType Directory -Force -Path $QaRoot | Out-Null

$checkArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $checkArgs += @("-ExpectedVersion", $Version)
}
& (Join-Path $PSScriptRoot "check-release-version.ps1") @checkArgs

if (-not $SkipChecks) {
  Push-Location $repoRoot
  try {
    Invoke-CheckedCommand "corepack" @("pnpm", "check") "pnpm check failed; signed release build was not created."
    Invoke-CheckedCommand "corepack" @("pnpm", "local-vision:prepare-runtime") "Local vision runtime preparation failed; signed release build was not created."
    Invoke-CheckedCommand "corepack" @(
      "pnpm",
      "local-vision:doctor",
      "--",
      "--require-bundled-desktop-node-runtime"
    ) "Local vision bundled desktop Node runtime check failed; signed release build was not created."
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
  Invoke-CheckedCommand "corepack" @(
    "pnpm",
    "--filter", "@javis/desktop",
    "tauri", "build",
    "--bundles", "msi", "nsis",
    "--ci",
    "--config", $config
  ) "Tauri signed Windows build failed. If the failure is LGHT0217/LGHT0216 during WiX ICE validation, check that the Windows Installer service is accessible on this machine."
  Invoke-CheckedCommand "corepack" @("pnpm", "local-vision:verify-release-resources") "Local vision release resources are missing from the Tauri release output."
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
    Artifact = ConvertTo-RepoRelativePath $artifact.FullName
    Signature = [string]$signature.Status
    SignerThumbprint = $CertificateThumbprint
    SHA256 = [string]$hash.Hash
  }
}

$summary | Format-Table -AutoSize
$commit = ((& git -C $repoRoot rev-parse HEAD) | Select-Object -First 1).Trim()
$summaryOutput = [ordered]@{
  generatedBy = "scripts/release/build-windows-signed.ps1"
  version = $Version
  commit = $commit
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  certificateThumbprint = $CertificateThumbprint
  timestampUrl = $TimestampUrl
  digestAlgorithm = $DigestAlgorithm
  artifacts = $summary
}
$summaryPath = Join-Path $QaRoot "release-build-summary.json"
Write-Utf8NoBom $summaryPath ($summaryOutput | ConvertTo-Json -Depth 8)
Write-Host "Release build summary written: $summaryPath"
Write-Host "Signed Windows release artifacts are ready for version $Version."
