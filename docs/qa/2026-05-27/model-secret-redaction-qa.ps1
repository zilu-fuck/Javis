param(
  [string]$QaRoot = "",
  [string]$AppDataRoot = "",
  [switch]$SecretStorageExercised,
  [switch]$ExerciseSecretStorage,
  [string]$RepoRoot = "",
  [int]$DevtoolsPort = 9342
)

$ErrorActionPreference = "Stop"

if (!$QaRoot.Trim()) {
  $QaRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
if (!$AppDataRoot.Trim()) {
  $AppDataRoot = Join-Path $env:APPDATA "app.javis.desktop"
}
if (!$RepoRoot.Trim()) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

$outputPath = Join-Path $PSScriptRoot "model-secret-redaction-qa-output.txt"
$exe = Join-Path $RepoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"
$session = $null
$previousWebViewArgs = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

function ConvertTo-DisplayPath($path) {
  try {
    $resolved = (Resolve-Path -LiteralPath $path).Path
  } catch {
    return $path
  }
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
  if ($resolved.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $resolved.Substring($repoRoot.Length).TrimStart("\", "/")
  }
  if ($resolved.StartsWith($env:APPDATA, [System.StringComparison]::OrdinalIgnoreCase)) {
    return "%APPDATA%\" + $resolved.Substring($env:APPDATA.Length).TrimStart("\", "/")
  }
  return $resolved
}

function Invoke-Cdp($socket, [ref]$id, $method, $params) {
  $id.Value += 1
  $payload = @{ id = $id.Value; method = $method; params = $params } | ConvertTo-Json -Depth 40 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $buffer = New-Object byte[] 4194304
  while ($true) {
    $message = [System.Text.StringBuilder]::new()
    while ($true) {
      $segment = [ArraySegment[byte]]::new($buffer)
      $receive = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($receive.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        throw "CDP socket closed while waiting for $method."
      }
      [void]$message.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $receive.Count))
      if ($receive.EndOfMessage) {
        break
      }
    }
    $text = $message.ToString()
    try {
      $parsed = $text | ConvertFrom-Json
    } catch {
      continue
    }
    if ($null -ne $parsed.id -and $parsed.id -eq $id.Value) {
      return $parsed
    }
  }
}

function Eval-Js($socket, [ref]$id, $expression) {
  return Invoke-Cdp $socket $id "Runtime.evaluate" @{
    expression = $expression
    awaitPromise = $true
    returnByValue = $true
  }
}

function Invoke-AppJs($session, $script) {
  if ($session -is [object[]]) {
    $session = @($session | Where-Object { $_ -is [hashtable] })[0]
  }
  $id = [int]$session["Id"]
  $socket = $session["Socket"]
  $response = Eval-Js $socket ([ref]$id) $script
  $session["Id"] = $id
  if ($response.result.exceptionDetails) {
    $text = $response.result.exceptionDetails.text
    $description = $response.result.exceptionDetails.exception.description
    $details = $response.result.exceptionDetails | ConvertTo-Json -Depth 12 -Compress
    throw "App JS failed: $text $description $details"
  }
  return $response.result.result.value
}

function Wait-ForCdpTarget {
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$DevtoolsPort/json" -TimeoutSec 2
      $target = @($targets | Where-Object { $_.webSocketDebuggerUrl })[0]
      if ($target) {
        return $target
      }
    } catch {
      Start-Sleep -Milliseconds 600
    }
  }
  throw "Timed out waiting for WebView2 DevTools target on port $DevtoolsPort."
}

function Start-ReleaseApp {
  if (!(Test-Path -LiteralPath $exe)) {
    throw "Release executable not found: $exe. Run the packaged desktop build first."
  }
  [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=$DevtoolsPort", "Process")
  $process = Start-Process -FilePath $exe -PassThru
  $target = Wait-ForCdpTarget
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  Start-Sleep -Seconds 3
  return ,@{
    Process = $process
    Socket = $socket
    Id = 0
  }
}

function Stop-ReleaseApp($session) {
  if ($null -eq $session) {
    return
  }
  if ($session["Socket"]) {
    $session["Socket"].Dispose()
  }
  if ($session["Process"]) {
    Stop-Process -Id $session["Process"].Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}

if ($ExerciseSecretStorage) {
  try {
    $session = Start-ReleaseApp
    $keyReference = "model.qa_secret_redaction_$([Guid]::NewGuid().ToString("N"))"
    $fakeSecret = "sk-javis-redaction-qa-$([Guid]::NewGuid().ToString("N"))"
    $keyReferenceJson = $keyReference | ConvertTo-Json -Compress
    $fakeSecretJson = $fakeSecret | ConvertTo-Json -Compress
    $storageResult = Invoke-AppJs $session @"
(async () => {
  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core) ||
    window.__TAURI__?.invoke?.bind(window.__TAURI__) ||
    window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
  if (!invoke) {
    throw new Error("Tauri invoke API is unavailable");
  }
  const keyReference = $keyReferenceJson;
  await invoke("save_model_api_key_secret", {
    request: { keyReference, apiKey: $fakeSecretJson }
  });
  const status = await invoke("check_model_api_key_secret", { keyReference });
  await invoke("delete_model_api_key_secret", { keyReference });
  const deleted = await invoke("check_model_api_key_secret", { keyReference });
  return { saved: true, existedAfterSave: !!status.exists, existsAfterDelete: !!deleted.exists };
})()
"@
    if (!$storageResult.saved -or !$storageResult.existedAfterSave -or $storageResult.existsAfterDelete) {
      throw "Secret storage round trip failed: $($storageResult | ConvertTo-Json -Compress)"
    }
    $SecretStorageExercised = $true
  } finally {
    Stop-ReleaseApp $session
    [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $previousWebViewArgs, "Process")
  }
}

$secretPatterns = @(
  @{ Name = "OpenAI-style API key"; Pattern = "\bsk-[A-Za-z0-9_-]{12,}" },
  @{ Name = "GitHub classic token"; Pattern = "\bghp_[A-Za-z0-9_]{20,}" },
  @{ Name = "GitHub fine-grained token"; Pattern = "\bgithub_pat_[A-Za-z0-9_]{20,}" },
  @{ Name = "AWS access key"; Pattern = "\bAKIA[0-9A-Z]{16}\b" },
  @{ Name = "Slack token"; Pattern = "\bxox[baprs]-[A-Za-z0-9-]{20,}" },
  @{ Name = "JWT-like token"; Pattern = "\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b" }
)

$scanRoots = @()
if (Test-Path -LiteralPath $QaRoot) {
  $scanRoots += (Resolve-Path -LiteralPath $QaRoot).Path
}
if (Test-Path -LiteralPath $AppDataRoot) {
  $scanRoots += (Resolve-Path -LiteralPath $AppDataRoot).Path
}

$textExtensions = @(".json", ".txt", ".md", ".log", ".sqlite", ".db")
$files = @(
  foreach ($root in $scanRoots) {
    Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Extension -in $textExtensions -and
        $_.Name -notlike "*.png" -and
        $_.Name -notlike "*.ps1"
      }
  }
)

$findings = @()
$skippedFiles = @()
foreach ($file in $files) {
  $text = $null
  if ($file.Extension -in @(".db", ".sqlite")) {
    $dump = & sqlite3 $file.FullName ".dump" 2>&1
    if ($LASTEXITCODE -eq 0) {
      $text = ($dump -join "`n")
    } else {
      $skippedFiles += [pscustomobject]@{
        File = ConvertTo-DisplayPath $file.FullName
        Reason = "sqlite dump failed: $dump"
      }
      continue
    }
  } else {
    try {
      $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    } catch {
      $skippedFiles += [pscustomobject]@{
        File = ConvertTo-DisplayPath $file.FullName
        Reason = $_.Exception.Message
      }
      continue
    }
    if ($bytes.Length -gt 5242880) {
      $skippedFiles += [pscustomobject]@{
        File = ConvertTo-DisplayPath $file.FullName
        Reason = "larger than 5 MiB"
      }
      continue
    }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  }
  foreach ($pattern in $secretPatterns) {
    if ($text -match $pattern.Pattern) {
      $findings += [pscustomobject]@{
        File = ConvertTo-DisplayPath $file.FullName
        Pattern = $pattern.Name
      }
    }
  }
}

$secretScanPassed = $findings.Count -eq 0
$storageStatus = if ($SecretStorageExercised) { "PASS" } else { "FAIL" }
$verdict = if ($secretScanPassed -and $SecretStorageExercised) { "PASS" } else { "FAIL" }

$lines = @(
  "# Model Secret Redaction QA Output",
  "",
  "generatedAt: $((Get-Date).ToUniversalTime().ToString("o"))",
  "qaRoot: $(ConvertTo-DisplayPath $QaRoot)",
  "appDataRoot: $(ConvertTo-DisplayPath $AppDataRoot)",
  "files scanned: $($files.Count)",
  "files skipped: $($skippedFiles.Count)",
  "findings: $($findings.Count)",
  "",
  "secret scan: $(if ($secretScanPassed) { "PASS" } else { "FAIL" })",
  "storage command: $storageStatus",
  "$(if ($SecretStorageExercised) { "save_model_api_key_secret: exercised" } else { "secret storage command: not verified" })",
  "verdict: $verdict"
)

if ($secretScanPassed) {
  $lines += "No API keys found"
} else {
  $lines += ""
  $lines += "Findings:"
  foreach ($finding in $findings) {
    $lines += "- $($finding.Pattern) in $($finding.File)"
  }
}
if ($skippedFiles.Count -gt 0) {
  $lines += ""
  $lines += "Skipped files:"
  foreach ($skipped in $skippedFiles) {
    $lines += "- $($skipped.File): $($skipped.Reason)"
  }
}

Write-Utf8NoBom $outputPath ($lines -join "`n")

if ($verdict -ne "PASS") {
  throw "Model secret redaction QA is not passing yet. See $outputPath."
}

Write-Host "Model secret redaction QA passed. Output: $outputPath"
