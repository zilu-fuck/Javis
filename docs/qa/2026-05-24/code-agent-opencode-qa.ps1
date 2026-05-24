$ErrorActionPreference = "Stop"

$qaDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $qaDir "..\..\..")).Path
$exe = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"
$fixturePath = Join-Path $qaDir "code-agent-opencode-proposal-fixture.json"
$workspacePath = Join-Path $qaDir "code-agent-opencode-workspace"
$workspaceName = Split-Path $workspacePath -Leaf
$storageWorkspaceKey = "javis.recentWorkspaces.v1"
$storageModelKey = "javis.modelSettings.v1"
$liveProvider = [Environment]::GetEnvironmentVariable("JAVIS_OPENCODE_LIVE_PROVIDER", "Process")
$liveModel = [Environment]::GetEnvironmentVariable("JAVIS_OPENCODE_LIVE_MODEL", "Process")
$liveApiKey = [Environment]::GetEnvironmentVariable("JAVIS_OPENCODE_LIVE_API_KEY", "Process")
$liveBaseUrl = [Environment]::GetEnvironmentVariable("JAVIS_OPENCODE_LIVE_BASE_URL", "Process")
$liveCredentialStorageEnabled = $false
if (!$liveProvider -and $liveModel -like "deepseek*") {
  $liveProvider = "deepseek"
}
if ($liveProvider -and $liveModel -and $liveModel -notlike "*/*") {
  $liveModel = "$liveProvider/$liveModel"
}

if (!(Test-Path $exe)) {
  throw "Release executable not found. Run pnpm --filter @javis/desktop tauri build first."
}

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CodeAgentOpenCodeQaWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out CodeAgentOpenCodeQaRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct CodeAgentOpenCodeQaRect { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

function Capture-Window($handle, $path) {
  [CodeAgentOpenCodeQaWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object CodeAgentOpenCodeQaRect
  [CodeAgentOpenCodeQaWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [CodeAgentOpenCodeQaWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
  $graphics.ReleaseHdc($hdc)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

function Invoke-Cdp($socket, [ref]$id, $method, $params) {
  $id.Value += 1
  $payload = @{ id = $id.Value; method = $method; params = $params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $buffer = New-Object byte[] 1048576
  while ($true) {
    $message = New-Object System.Text.StringBuilder
    while ($true) {
      $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        throw "CDP socket closed while waiting for $method."
      }
      [void]$message.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
      if ($result.EndOfMessage) {
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

function Get-PageText($socket, [ref]$id) {
  $response = Invoke-Cdp $socket $id "Runtime.evaluate" @{
    expression = "document.body.innerText"
    returnByValue = $true
  }
  return $response.result.result.value
}

function Wait-ForText($socket, [ref]$id, $text, $seconds) {
  $jsonText = $text | ConvertTo-Json -Compress
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $response = Invoke-Cdp $socket $id "Runtime.evaluate" @{
      expression = "document.body.innerText.includes($jsonText)"
      returnByValue = $true
    }
    if ($response.result.result.value -eq $true) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  $pageText = Get-PageText $socket $id
  if ($pageText.Length -gt 2500) {
    $pageText = $pageText.Substring(0, 2500)
  }
  throw "Timed out waiting for text: $text`nCurrent page text:`n$pageText"
}

function Wait-ForAnyText($socket, [ref]$id, [string[]]$texts, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $pageText = Get-PageText $socket $id
    foreach ($text in $texts) {
      if ($pageText.Contains($text)) {
        return $text
      }
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Click-PendingPermissionButton($socket, [ref]$id, $label) {
  $buttonIndex = if ($label -eq "Approve") { 0 } else { 1 }
  $expression = @"
(() => {
  const actions = document.querySelector('.javis-confirmation-actions');
  const buttons = actions ? Array.from(actions.querySelectorAll('button')) : [];
  const button = buttons[$buttonIndex];
  if (!button) {
    throw new Error('No enabled permission button found.');
  }
  if (button.disabled) {
    throw new Error('Permission button is disabled.');
  }
  button.click();
  return document.body.innerText;
})()
"@
  Eval-Js $socket $id $expression | Out-Null
}

function Submit-Goal($socket, [ref]$id, $goal) {
  $jsonGoal = $goal | ConvertTo-Json -Compress
  $expression = @"
(() => {
  const goal = $jsonGoal;
  const input = document.querySelector('textarea');
  if (!input) {
    throw new Error('Goal textarea was not found.');
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, goal);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
  return document.body.innerText;
})()
"@
  Eval-Js $socket $id $expression | Out-Null
}

function Expand-ActivityLog($socket, [ref]$id) {
  Eval-Js $socket $id @"
(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const button = buttons.find((candidate) =>
    candidate.textContent.includes('展开日志') || candidate.textContent.includes('Expand activity log')
  );
  if (button) {
    button.click();
  }
  return document.body.innerText;
})()
"@ | Out-Null
}

function Run-Git($workingDirectory, [string[]]$arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & git -C $workingDirectory @arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "git $($arguments -join ' ') failed in $workingDirectory`n$($output -join "`n")"
  }
  return $output
}

function Reset-QaWorkspace {
  if (Test-Path $workspacePath) {
    Remove-Item -LiteralPath $workspacePath -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $workspacePath "src") | Out-Null
  Write-Utf8NoBom (Join-Path $workspacePath "src\message.txt") "hello base`n"
  Run-Git $workspacePath @("init") | Out-Null
  Run-Git $workspacePath @("config", "core.autocrlf", "false") | Out-Null
  Run-Git $workspacePath @("config", "user.email", "javis@example.test") | Out-Null
  Run-Git $workspacePath @("config", "user.name", "Javis QA") | Out-Null
  Run-Git $workspacePath @("add", "src/message.txt") | Out-Null
  Run-Git $workspacePath @("commit", "-m", "seed code agent qa") | Out-Null
  Write-Utf8NoBom (Join-Path $workspacePath "src\message.txt") "hello reviewed`n"
}

function Write-ProposalFixture {
  $fixture = @{
    summary = "Tighten the Code Agent QA message."
    changedFiles = @("src/message.txt")
    patch = "diff --git a/src/message.txt b/src/message.txt`n--- a/src/message.txt`n+++ b/src/message.txt`n@@ -1 +1 @@`n-hello reviewed`n+hello approved`n"
  } | ConvertTo-Json -Depth 5 -Compress
  Write-Utf8NoBom $fixturePath $fixture
}

function Start-JavisWithCdp($port, $useFixture) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
  if ($useFixture) {
    $env:JAVIS_QA_MODE = "1"
    $env:JAVIS_CODE_PROPOSAL_FIXTURE_PATH = $fixturePath
  } else {
    Remove-Item Env:JAVIS_QA_MODE -ErrorAction SilentlyContinue
    Remove-Item Env:JAVIS_CODE_PROPOSAL_FIXTURE_PATH -ErrorAction SilentlyContinue
  }
  $process = Start-Process -FilePath $exe -WorkingDirectory $repoRoot -PassThru
  Start-Sleep -Seconds 8
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json"
  $target = @($targets | Where-Object { $_.title -eq "Javis" -or $_.url -like "tauri://*" } | Select-Object -First 1)[0]
  if (!$target) {
    $target = @($targets)[0]
  }
  if (!$target) {
    throw "No WebView2 CDP target found on port $port."
  }
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return @{ Process = $process; Socket = $socket; Id = 0 }
}

function Stop-Javis($session) {
  if ($session.Socket) {
    $session.Socket.Dispose()
  }
  if ($session.Process) {
    Stop-Process -Id $session.Process.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

function Configure-AppStorage($session, [ref]$id, $provider, $model, $baseUrl) {
  $workspaceJson = $workspacePath | ConvertTo-Json -Compress
  $modelSettingsJson = @{
    provider = $provider
    model = $model
    apiKeyReference = "default"
    baseUrl = $baseUrl
  } | ConvertTo-Json -Compress
  $storageWorkspaceKeyJson = $storageWorkspaceKey | ConvertTo-Json -Compress
  $storageModelKeyJson = $storageModelKey | ConvertTo-Json -Compress

  Eval-Js $session.Socket $id @"
(() => {
  localStorage.clear();
  localStorage.setItem($storageWorkspaceKeyJson, JSON.stringify([$workspaceJson]));
  localStorage.setItem($storageModelKeyJson, JSON.stringify($modelSettingsJson));
  location.reload();
  return $workspaceJson;
})()
"@ | Out-Null
  Start-Sleep -Seconds 2
}

function Save-ModelApiKeySecret($session, [ref]$id, $apiKey) {
  $apiKeyJson = $apiKey | ConvertTo-Json -Compress
  Eval-Js $session.Socket $id @"
window.__TAURI__.core.invoke("save_model_api_key_secret", {
  request: {
    keyReference: "default",
    apiKey: $apiKeyJson
  }
})
"@ | Out-Null
}

function Run-CodeAgentScenario(
  $name,
  $decision,
  $screenshotName,
  $expectedTitle,
  $expectedFileText,
  $useFixture,
  $provider,
  $model,
  $baseUrl,
  $port
) {
  Reset-QaWorkspace
  if ($useFixture) {
    Write-ProposalFixture
  }
  $session = $null
  try {
    $session = Start-JavisWithCdp $port $useFixture
    $id = $session.Id
    Configure-AppStorage $session ([ref]$id) $provider $model $baseUrl
    Wait-ForText $session.Socket ([ref]$id) $workspaceName 20 | Out-Null

    Submit-Goal $session.Socket ([ref]$id) "Review code changes"
    Wait-ForText $session.Socket ([ref]$id) "Approve code review continuation" 30 | Out-Null
    Click-PendingPermissionButton $session.Socket ([ref]$id) "Approve"
    Wait-ForText $session.Socket ([ref]$id) "Code Agent patch approval needed" 120 | Out-Null
    Wait-ForText $session.Socket ([ref]$id) "Code Agent patch proposal" 10 | Out-Null
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir $screenshotName)

    Click-PendingPermissionButton $session.Socket ([ref]$id) $decision
    Wait-ForText $session.Socket ([ref]$id) $expectedTitle 30 | Out-Null
    $finalScreenshot = $screenshotName -replace "proposal", $name
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir $finalScreenshot)
    $fileText = [System.IO.File]::ReadAllText((Join-Path $workspacePath "src\message.txt"))
    if ($fileText -ne $expectedFileText) {
      throw "$name scenario wrote unexpected file text: $fileText"
    }
    return [pscustomobject]@{
      Scenario = $name
      Decision = $decision
      FinalTitle = $expectedTitle
      FileText = $fileText.Trim()
      Provider = $provider
      Model = $model
      Screenshots = @($screenshotName, $finalScreenshot)
    }
  }
  finally {
    Stop-Javis $session
  }
}

function Run-LiveCodeAgentScenario($provider, $model, $apiKey, $baseUrl) {
  Reset-QaWorkspace
  $session = $null
  try {
    $session = Start-JavisWithCdp 9227 $false
    $id = $session.Id
    Configure-AppStorage $session ([ref]$id) $provider $model $baseUrl
    Save-ModelApiKeySecret $session ([ref]$id) $apiKey
    Wait-ForText $session.Socket ([ref]$id) $workspaceName 20 | Out-Null

    Submit-Goal $session.Socket ([ref]$id) "Review code changes"
    Wait-ForText $session.Socket ([ref]$id) "Approve code review continuation" 30 | Out-Null
    Click-PendingPermissionButton $session.Socket ([ref]$id) "Approve"

    $liveOutcome = Wait-ForAnyText $session.Socket ([ref]$id) @(
      "Code Agent patch approval needed",
      "Code Agent patch proposal failed",
      "Code Agent patch proposal 失败"
    ) 120
    if ($liveOutcome -eq "Code Agent patch approval needed") {
      Wait-ForText $session.Socket ([ref]$id) "Code Agent patch proposal" 10 | Out-Null
      Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "20-code-agent-live-proposal-before-approve.png")
      return [pscustomobject]@{
        Scenario = "live-proposal"
        Provider = $provider
        Model = $model
        Status = "pass"
        Summary = "Live provider produced a parseable patch proposal and Javis stopped for confirmed-write approval."
        Screenshots = @("20-code-agent-live-proposal-before-approve.png")
      }
    } else {
      if (!$liveOutcome) {
        Wait-ForAnyText $session.Socket ([ref]$id) @(
          "Code Agent patch proposal failed",
          "Code Agent patch proposal 失败"
        ) 5 | Out-Null
      }
      Expand-ActivityLog $session.Socket ([ref]$id)
      Start-Sleep -Milliseconds 500
      Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "20-code-agent-live-proposal-failed.png")
      $pageText = Get-PageText $session.Socket ([ref]$id)
      return [pscustomobject]@{
        Scenario = "live-approved"
        Provider = $provider
        Model = $model
        Status = "provider-hardening-needed"
        Summary = "Live provider did not produce a parseable patch proposal before write approval."
        PageTextExcerpt = $pageText.Substring(0, [Math]::Min(1200, $pageText.Length))
        Screenshots = @("20-code-agent-live-proposal-failed.png")
      }
    }
  }
  finally {
    Stop-Javis $session
  }
}

$previousWebviewArgs = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")
$previousQaMode = [Environment]::GetEnvironmentVariable("JAVIS_QA_MODE", "Process")
$previousFixture = [Environment]::GetEnvironmentVariable("JAVIS_CODE_PROPOSAL_FIXTURE_PATH", "Process")

try {
  $denyResult = Run-CodeAgentScenario "denied" "Deny" "16-code-agent-proposal-before-deny.png" "Code Agent patch denied" "hello reviewed`n" $true "openai" "openai/code-agent-fixture" "https://fixture.invalid/v1" 9226
  $approveResult = Run-CodeAgentScenario "approved" "Approve" "18-code-agent-proposal-before-approve.png" "Code Agent patch applied" "hello approved`n" $true "openai" "openai/code-agent-fixture" "https://fixture.invalid/v1" 9228
  $gitCheck = Run-Git $workspacePath @("diff", "--check")
  $liveResult = $null
  if ($liveProvider -and $liveModel -and $liveApiKey -and $liveBaseUrl) {
    $liveCredentialStorageEnabled = $true
    $liveResult = Run-LiveCodeAgentScenario $liveProvider $liveModel $liveApiKey $liveBaseUrl
  }

  [pscustomobject]@{
    WorkspacePath = $workspacePath
    FixturePath = $fixturePath
    GitDiffCheck = $gitCheck
    LiveProviderConfigured = [bool]($liveProvider -and $liveModel -and $liveApiKey -and $liveBaseUrl)
    LiveCredentialStorageEnabled = $liveCredentialStorageEnabled
    Results = @($denyResult, $approveResult)
    LiveResult = $liveResult
  } | ConvertTo-Json -Depth 6
}
finally {
  if ($null -eq $previousWebviewArgs) {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  } else {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebviewArgs
  }
  if ($null -eq $previousQaMode) {
    Remove-Item Env:JAVIS_QA_MODE -ErrorAction SilentlyContinue
  } else {
    $env:JAVIS_QA_MODE = $previousQaMode
  }
  if ($null -eq $previousFixture) {
    Remove-Item Env:JAVIS_CODE_PROPOSAL_FIXTURE_PATH -ErrorAction SilentlyContinue
  } else {
    $env:JAVIS_CODE_PROPOSAL_FIXTURE_PATH = $previousFixture
  }
  Remove-Item -LiteralPath $workspacePath -Recurse -Force -ErrorAction SilentlyContinue
}
