$ErrorActionPreference = "Stop"

$qaDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $qaDir "..\..\..")).Path
$exe = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"
$storageKey = "javis.approvalRecords.v1"
$taskHistoryKey = "javis.taskHistory.v1"
$workspaceRoot = Join-Path $qaDir "code-patch-durable-approval-workspaces"

if (!(Test-Path $exe)) {
  throw "Release executable not found. Run pnpm --filter @javis/desktop tauri build first."
}

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CodePatchDurableApprovalQaWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out CodePatchDurableApprovalQaRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct CodePatchDurableApprovalQaRect { public int Left; public int Top; public int Right; public int Bottom; }
public class CodePatchDurableApprovalQaHash {
  public static string CreateFnv1a(string prefix, string payload) {
    unchecked {
      uint hash = 2166136261;
      foreach (char character in payload) {
        hash ^= character;
        hash *= 16777619;
      }
      return prefix + hash.ToString("x8");
    }
  }
}
'@

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

function Capture-Window($handle, $path) {
  [CodePatchDurableApprovalQaWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object CodePatchDurableApprovalQaRect
  [CodePatchDurableApprovalQaWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [CodePatchDurableApprovalQaWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
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

function Test-PageTextIncludes($socket, [ref]$id, $text) {
  $jsonText = $text | ConvertTo-Json -Compress
  $response = Eval-Js $socket $id "document.body.innerText.includes($jsonText)"
  return $response.result.result.value -eq $true
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

function Expand-ActivityLog($socket, [ref]$id) {
  $expression = @"
(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const button = buttons.find((item) => item.textContent && item.textContent.includes('展开日志'));
  if (button) {
    button.click();
  }
  return document.body.innerText;
})()
"@
  Eval-Js $socket $id $expression | Out-Null
}

function Start-JavisWithCdp($port) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
  $process = Start-Process -FilePath $exe -WorkingDirectory $repoRoot -PassThru
  Start-Sleep -Seconds 8
  $target = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/json")[0]
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

function Normalize-PathForJavis($path) {
  return $path.Replace("\", "/")
}

function Normalize-CanonicalWorkspaceForNative($path) {
  $normalized = Normalize-PathForJavis ((Resolve-Path -LiteralPath $path).Path)
  if ($normalized -match "^[A-Za-z]:/") {
    return "//?/$normalized"
  }
  return $normalized
}

function Invoke-Git($workspace, $arguments) {
  $output = & git -C $workspace @arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($arguments -join ' ') failed: $output"
  }
  return $output
}

function New-CodeProposalHash($proposalId, $workspace, $changedFiles, $patch) {
  $payload = @($proposalId, (Normalize-CanonicalWorkspaceForNative $workspace)) + $changedFiles + @($patch)
  return [CodePatchDurableApprovalQaHash]::CreateFnv1a("fnv1a-", ($payload -join "`n"))
}

function New-DryRunBindingHash($dryRun) {
  $normalized = [ordered]@{
    operation = $dryRun.operation
    affectedPaths = @($dryRun.affectedPaths | ForEach-Object {
      $path = [ordered]@{
        source = $_.source
        target = $_.target
        action = $_.action
      }
      if ($_.PSObject.Properties.Name -contains "conflict") {
        $path.conflict = $_.conflict
      }
      $path
    })
    riskSummary = $dryRun.riskSummary
    reversible = $dryRun.reversible
  }
  $payload = $normalized | ConvertTo-Json -Depth 10 -Compress
  return [CodePatchDurableApprovalQaHash]::CreateFnv1a("dryrun-fnv1a-", $payload)
}

function New-QaWorkspace($name) {
  $workspace = Join-Path $workspaceRoot $name
  Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $workspace "src") | Out-Null
  Write-Utf8NoBom (Join-Path $workspace "src\message.txt") "hello reviewed`n"
  Invoke-Git $workspace @("init") | Out-Null
  Invoke-Git $workspace @("config", "user.email", "javis@example.test") | Out-Null
  Invoke-Git $workspace @("config", "user.name", "Javis QA") | Out-Null
  Invoke-Git $workspace @("config", "core.autocrlf", "false") | Out-Null
  Invoke-Git $workspace @("add", ".") | Out-Null
  Invoke-Git $workspace @("commit", "-m", "initial") | Out-Null
  return $workspace
}

function New-CodePatchApprovalRecord($approvalId, $taskId, $workspace, $expiresAt) {
  $createdAt = "2026-05-24T00:00:00.000Z"
  $proposalId = "$taskId-proposal"
  $summary = "Tighten the Code Agent QA message."
  $changedFiles = @("src/message.txt")
  $patch = "diff --git a/src/message.txt b/src/message.txt`n--- a/src/message.txt`n+++ b/src/message.txt`n@@ -1 +1 @@`n-hello reviewed`n+hello approved`n"
  $patchHash = New-CodeProposalHash $proposalId $workspace $changedFiles $patch
  $dryRun = [ordered]@{
    operation = "Apply Code Agent patch proposal $proposalId"
    affectedPaths = @(
      [ordered]@{
        source = "src/message.txt"
        target = "src/message.txt"
        action = "modify"
      }
    )
    riskSummary = "$summary Patch hash: $patchHash."
    reversible = $true
  }
  $bindingHash = New-DryRunBindingHash $dryRun
  $permissionRequest = [ordered]@{
    id = $approvalId
    level = "confirmed_write"
    title = "Approve Code Agent patch application"
    reason = "Applying the proposed patch changes local project files, so Javis needs explicit approval."
    dryRun = $dryRun
    bindingHash = $bindingHash
    status = "pending"
    createdAt = $createdAt
  }
  return [ordered]@{
    version = 1
    records = @(
      [ordered]@{
        approvalId = $approvalId
        taskId = $taskId
        toolName = "code.applyProposedEdit"
        workspacePath = Normalize-CanonicalWorkspaceForNative $workspace
        permissionLevel = "confirmed_write"
        previewHash = $bindingHash
        expiresAt = $expiresAt
        status = "pending"
        createdAt = $createdAt
        permissionRequest = $permissionRequest
        codeProposedEdit = [ordered]@{
          proposalId = $proposalId
          workspacePath = Normalize-CanonicalWorkspaceForNative $workspace
          summary = $summary
          changedFiles = $changedFiles
          patch = $patch
          patchHash = $patchHash
        }
      }
    )
  }
}

function Get-StoredApprovalRecord($socket, [ref]$id) {
  $storageJson = $storageKey | ConvertTo-Json -Compress
  $response = Eval-Js $socket $id @"
(() => {
  const raw = localStorage.getItem($storageJson);
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw);
  return parsed.records && parsed.records[0] ? parsed.records[0] : null;
})()
"@
  return $response.result.result.value
}

function Inject-ApprovalRecord($approvalId, $taskId, $workspace, $expiresAt, $port) {
  $session = Start-JavisWithCdp $port
  try {
    $id = $session.Id
    $recordJson = (New-CodePatchApprovalRecord $approvalId $taskId $workspace $expiresAt) | ConvertTo-Json -Depth 16 -Compress
    $recordJsonLiteral = $recordJson | ConvertTo-Json -Compress
    Eval-Js $session.Socket ([ref]$id) @"
(() => {
  localStorage.removeItem('$taskHistoryKey');
  localStorage.setItem('$storageKey', $recordJsonLiteral);
  return localStorage.getItem('$storageKey');
})()
"@ | Out-Null
  } finally {
    Stop-Javis $session
  }
}

function Run-ApproveScenario {
  $workspace = New-QaWorkspace "approve"
  Inject-ApprovalRecord "code-patch-approval-durable-approve-qa" "task-code-patch-durable-approve-qa" $workspace "2099-01-01T00:00:00.000Z" 9241

  $session = Start-JavisWithCdp 9242
  try {
    $id = $session.Id
    Wait-ForText $session.Socket ([ref]$id) "Code Agent patch approval needed" 30 | Out-Null
    Wait-ForText $session.Socket ([ref]$id) "src/message.txt" 10 | Out-Null
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "26-code-patch-durable-approval-restored.png")
    Click-PendingPermissionButton $session.Socket ([ref]$id) "Approve"
    try {
      Wait-ForText $session.Socket ([ref]$id) "Code Agent patch applied" 30 | Out-Null
    } catch {
      $global:KeepCodePatchDurableQaWorkspace = $true
      Expand-ActivityLog $session.Socket ([ref]$id)
      Start-Sleep -Milliseconds 500
      Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "27-code-patch-durable-approval-apply-failed.png")
      throw
    }
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "27-code-patch-durable-approval-approved.png")
    $storedRecord = Get-StoredApprovalRecord $session.Socket ([ref]$id)
    $fileText = [System.IO.File]::ReadAllText((Join-Path $workspace "src\message.txt"))
    $gitCheck = Invoke-Git $workspace @("diff", "--check")

    if ($fileText -ne "hello approved`n") {
      throw "Approve QA file text was not patched: $fileText"
    }
    if ($storedRecord.status -ne "approved" -or $storedRecord.decision -ne "approved") {
      throw "Approve QA durable approval record was not resolved as approved."
    }

    return [pscustomobject]@{
      Decision = "approved"
      Workspace = $workspace
      FileText = $fileText.Trim()
      GitDiffCheck = $gitCheck
      StoredStatus = $storedRecord.status
      PreviewHash = $storedRecord.previewHash
      Screenshots = @(
        "26-code-patch-durable-approval-restored.png",
        "27-code-patch-durable-approval-approved.png"
      )
    }
  } finally {
    Stop-Javis $session
  }
}

function Run-DenyScenario {
  $workspace = New-QaWorkspace "deny"
  Inject-ApprovalRecord "code-patch-approval-durable-deny-qa" "task-code-patch-durable-deny-qa" $workspace "2099-01-01T00:00:00.000Z" 9243

  $session = Start-JavisWithCdp 9244
  try {
    $id = $session.Id
    Wait-ForText $session.Socket ([ref]$id) "Code Agent patch approval needed" 30 | Out-Null
    Wait-ForText $session.Socket ([ref]$id) "src/message.txt" 10 | Out-Null
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "28-code-patch-durable-approval-deny-restored.png")
    Click-PendingPermissionButton $session.Socket ([ref]$id) "Deny"
    Wait-ForText $session.Socket ([ref]$id) "Code Agent patch denied" 30 | Out-Null
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "29-code-patch-durable-approval-denied.png")
    $storedRecord = Get-StoredApprovalRecord $session.Socket ([ref]$id)
    $fileText = [System.IO.File]::ReadAllText((Join-Path $workspace "src\message.txt"))

    if ($fileText -ne "hello reviewed`n") {
      throw "Deny QA file text changed unexpectedly: $fileText"
    }
    if ($storedRecord.status -ne "denied" -or $storedRecord.decision -ne "denied") {
      throw "Deny QA durable approval record was not resolved as denied."
    }

    return [pscustomobject]@{
      Decision = "denied"
      Workspace = $workspace
      FileText = $fileText.Trim()
      StoredStatus = $storedRecord.status
      PreviewHash = $storedRecord.previewHash
      Screenshots = @(
        "28-code-patch-durable-approval-deny-restored.png",
        "29-code-patch-durable-approval-denied.png"
      )
    }
  } finally {
    Stop-Javis $session
  }
}

function Run-ExpiredScenario {
  $workspace = New-QaWorkspace "expired"
  Inject-ApprovalRecord "code-patch-approval-durable-expired-qa" "task-code-patch-durable-expired-qa" $workspace "2026-01-01T00:00:00.000Z" 9245

  $session = Start-JavisWithCdp 9246
  try {
    $id = $session.Id
    Start-Sleep -Seconds 3
    $hasApprovalCard = Test-PageTextIncludes $session.Socket ([ref]$id) "Code Agent patch approval needed"
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "30-code-patch-durable-approval-expired.png")
    $storedRecord = Get-StoredApprovalRecord $session.Socket ([ref]$id)
    $fileText = [System.IO.File]::ReadAllText((Join-Path $workspace "src\message.txt"))

    if ($hasApprovalCard) {
      throw "Expired QA restored a Code Patch approval card."
    }
    if ($fileText -ne "hello reviewed`n") {
      throw "Expired QA file text changed unexpectedly: $fileText"
    }
    if ($storedRecord.status -ne "expired") {
      throw "Expired QA durable approval record was not marked expired."
    }

    return [pscustomobject]@{
      Decision = "expired"
      Workspace = $workspace
      FileText = $fileText.Trim()
      StoredStatus = $storedRecord.status
      PreviewHash = $storedRecord.previewHash
      Screenshots = @("30-code-patch-durable-approval-expired.png")
    }
  } finally {
    Stop-Javis $session
  }
}

$session = $null
$previousWebviewArgs = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")

try {
  Remove-Item -LiteralPath $workspaceRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $workspaceRoot | Out-Null
  $approveResult = Run-ApproveScenario
  $denyResult = Run-DenyScenario
  $expiredResult = Run-ExpiredScenario

  [pscustomobject]@{
    ApprovalStorageKey = $storageKey
    Results = @($approveResult, $denyResult, $expiredResult)
  } | ConvertTo-Json -Depth 8
}
finally {
  Stop-Javis $session
  if (!$global:KeepCodePatchDurableQaWorkspace) {
    Remove-Item -LiteralPath $workspaceRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($null -eq $previousWebviewArgs) {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  } else {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebviewArgs
  }
}
