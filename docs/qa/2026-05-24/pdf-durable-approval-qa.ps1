$ErrorActionPreference = "Stop"

$qaDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $qaDir "..\..\..")).Path
$exe = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"
$storageKey = "javis.approvalRecords.v1"
$downloads = Join-Path $env:USERPROFILE "Downloads"
$qaSource = Join-Path $downloads "javis-durable-approval-qa.pdf"
$qaTargetDir = Join-Path $downloads "JavisDurableApprovalQa"
$qaTarget = Join-Path $qaTargetDir "javis-durable-approval-qa.pdf"

if (!(Test-Path $exe)) {
  throw "Release executable not found. Run pnpm --filter @javis/desktop tauri build first."
}

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PdfDurableApprovalQaWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out PdfDurableApprovalQaRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct PdfDurableApprovalQaRect { public int Left; public int Top; public int Right; public int Bottom; }
public class PdfDurableApprovalQaHash {
  public static string CreateDryRunBindingHash(string payload) {
    unchecked {
      uint hash = 2166136261;
      foreach (char character in payload) {
        hash ^= character;
        hash *= 16777619;
      }
      return "dryrun-fnv1a-" + hash.ToString("x8");
    }
  }
}
'@

function Capture-Window($handle, $path) {
  [PdfDurableApprovalQaWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object PdfDurableApprovalQaRect
  [PdfDurableApprovalQaWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [PdfDurableApprovalQaWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
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
  return [PdfDurableApprovalQaHash]::CreateDryRunBindingHash($payload)
}

function New-ApprovalRecord($approvalId, $source, $target) {
  $createdAt = "2026-05-24T00:00:00.000Z"
  $expiresAt = "2099-01-01T00:00:00.000Z"
  $dryRun = [ordered]@{
    operation = "Organize PDF files by filename topic"
    affectedPaths = @(
      [ordered]@{
        source = Normalize-PathForJavis $source
        target = Normalize-PathForJavis $target
        action = "move"
      }
    )
    riskSummary = "Preview only. Files move only after the current dry-run is approved."
    reversible = $true
  }
  $bindingHash = New-DryRunBindingHash $dryRun
  $permissionRequest = [ordered]@{
    id = $approvalId
    level = "confirmed_write"
    title = "Approve PDF move plan"
    reason = "Moving files changes the local filesystem, so Javis needs explicit approval."
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
        taskId = "task-pdf-durable-approval-qa"
        toolName = "file.executePdfOrganization"
        workspacePath = Normalize-PathForJavis $downloads
        permissionLevel = "confirmed_write"
        previewHash = $bindingHash
        expiresAt = $expiresAt
        status = "pending"
        createdAt = $createdAt
        permissionRequest = $permissionRequest
      }
    )
  }
}

$session = $null
$restartSession = $null
$previousWebviewArgs = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")

try {
  Remove-Item -LiteralPath $qaSource -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $qaTarget -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $qaTargetDir | Out-Null
  [System.IO.File]::WriteAllText($qaSource, "%PDF-1.4`n% Javis durable approval QA`n")

  $session = Start-JavisWithCdp 9231
  $id = $session.Id
  $recordJson = (New-ApprovalRecord "pdf-approval-durable-qa" $qaSource $qaTarget) | ConvertTo-Json -Depth 12 -Compress
  $recordJsonLiteral = $recordJson | ConvertTo-Json -Compress
  Eval-Js $session.Socket ([ref]$id) @"
(() => {
  localStorage.setItem('$storageKey', $recordJsonLiteral);
  return localStorage.getItem('$storageKey');
})()
"@ | Out-Null
  Stop-Javis $session
  $session = $null

  $restartSession = Start-JavisWithCdp 9232
  $restartId = $restartSession.Id
  Wait-ForText $restartSession.Socket ([ref]$restartId) "PDF organization approval needed" 30 | Out-Null
  Wait-ForText $restartSession.Socket ([ref]$restartId) "javis-durable-approval-qa.pdf" 10 | Out-Null
  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "21-pdf-durable-approval-restored.png")
  Click-PendingPermissionButton $restartSession.Socket ([ref]$restartId) "Approve"
  Wait-ForText $restartSession.Socket ([ref]$restartId) "PDF organization completed" 30 | Out-Null
  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "22-pdf-durable-approval-approved.png")
  $storedAfterApprove = (Eval-Js $restartSession.Socket ([ref]$restartId) "localStorage.getItem('$storageKey')").result.result.value

  if (Test-Path $qaSource) {
    throw "QA source still exists after restored approval execution."
  }
  if (!(Test-Path $qaTarget)) {
    throw "QA target was not created by restored approval execution."
  }

  [pscustomobject]@{
    ApprovalStorageKey = $storageKey
    Source = $qaSource
    Target = $qaTarget
    SourceExistsAfterApprove = Test-Path $qaSource
    TargetExistsAfterApprove = Test-Path $qaTarget
    StoredAfterApprove = $storedAfterApprove
    Screenshots = @(
      "21-pdf-durable-approval-restored.png",
      "22-pdf-durable-approval-approved.png"
    )
  } | ConvertTo-Json -Depth 6
}
finally {
  Stop-Javis $session
  Stop-Javis $restartSession
  Remove-Item -LiteralPath $qaSource -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $qaTarget -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $qaTargetDir -Force -ErrorAction SilentlyContinue
  if ($null -eq $previousWebviewArgs) {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  } else {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebviewArgs
  }
}
