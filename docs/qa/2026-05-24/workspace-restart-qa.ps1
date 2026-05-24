$ErrorActionPreference = "Stop"

$qaDir = "E:\Javis\docs\qa\2026-05-24"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"
$workspacePath = "E:\Javis"
$storageKey = "javis.recentWorkspaces.v1"

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WorkspaceRestartQaWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WorkspaceRestartQaRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct WorkspaceRestartQaRect { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Capture-Window($handle, $path) {
  [WorkspaceRestartQaWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object WorkspaceRestartQaRect
  [WorkspaceRestartQaWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [WorkspaceRestartQaWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
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
    $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
    if ($text -match ('"id":' + $id.Value + '(,|})')) {
      return ($text | ConvertFrom-Json)
    }
  }
}

function Eval-Js($socket, [ref]$id, $expression) {
  return Invoke-Cdp $socket ([ref]$id.Value) "Runtime.evaluate" @{
    expression = $expression
    awaitPromise = $true
    returnByValue = $true
  }
}

function Wait-ForText($socket, [ref]$id, $text, $seconds) {
  $jsonText = $text | ConvertTo-Json -Compress
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $response = Invoke-Cdp $socket ([ref]$id.Value) "Runtime.evaluate" @{
      expression = "document.body.innerText.includes($jsonText)"
      returnByValue = $true
    }
    if ($response.result.result.value -eq $true) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-JavisWithCdp() {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
  $process = Start-Process -FilePath $exe -WorkingDirectory $workspacePath -PassThru
  Start-Sleep -Seconds 8
  $target = (Invoke-RestMethod -Uri "http://127.0.0.1:9222/json")[0]
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

$session = $null
$restartSession = $null

try {
  $session = Start-JavisWithCdp
  $id = $session.Id
  $quotedWorkspace = $workspacePath | ConvertTo-Json -Compress
  Eval-Js $session.Socket ([ref]$id) @"
(() => {
  localStorage.removeItem('$storageKey');
  const workspace = $quotedWorkspace;
  const input = document.querySelector('input[aria-label*="Workspace"], input[aria-label*="工作区"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, workspace);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()
"@ | Out-Null

  Eval-Js $session.Socket ([ref]$id) @"
(() => {
  const goal = 'test project environment';
  const input = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, goal);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('button[type="submit"]').click();
  return document.body.innerText;
})()
"@ | Out-Null

  if (!(Wait-ForText $session.Socket ([ref]$id) "Project environment inspected" 30)) {
    throw "Timed out waiting for completed project inspection."
  }
  if (!(Wait-ForText $session.Socket ([ref]$id) $workspacePath 10)) {
    throw "Completed workspace path was not visible before restart."
  }
  Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "01-workspace-recent-before-restart.png")
  $storedBeforeRestart = (Eval-Js $session.Socket ([ref]$id) "localStorage.getItem('$storageKey')").result.result.value
  Stop-Javis $session
  $session = $null

  $restartSession = Start-JavisWithCdp
  $restartId = $restartSession.Id
  if (!(Wait-ForText $restartSession.Socket ([ref]$restartId) $workspacePath 20)) {
    throw "Recent workspace path was not visible after restart."
  }
  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "02-workspace-recent-after-restart.png")
  $storedAfterRestart = (Eval-Js $restartSession.Socket ([ref]$restartId) "localStorage.getItem('$storageKey')").result.result.value

  [pscustomobject]@{
    WorkspacePath = $workspacePath
    StorageKey = $storageKey
    StoredBeforeRestart = $storedBeforeRestart
    StoredAfterRestart = $storedAfterRestart
    Screenshots = @(
      "01-workspace-recent-before-restart.png",
      "02-workspace-recent-after-restart.png"
    )
  } | ConvertTo-Json -Depth 4
}
finally {
  Stop-Javis $session
  Stop-Javis $restartSession
}
