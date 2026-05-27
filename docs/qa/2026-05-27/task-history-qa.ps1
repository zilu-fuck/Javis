$ErrorActionPreference = "Stop"

$qaDir = "E:\Javis\docs\qa\2026-05-27"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"
$workspacePath = "E:\Javis"
$dbPath = "$env:APPDATA\app.javis.desktop\javis.db"
$legacyKey = "javis.taskHistory.v1"

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TaskHistoryWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out TaskHistoryRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct TaskHistoryRect { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Capture-Window($handle, $path) {
  [TaskHistoryWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object TaskHistoryRect
  [TaskHistoryWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [TaskHistoryWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

function Invoke-Cdp($socket, [ref]$msgId, $method, $params) {
  $msgId.Value += 1
  $payload = @{ id = $msgId.Value; method = $method; params = $params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $buffer = New-Object byte[] 1048576
  while ($true) {
    $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
    $marker = '"id":' + $msgId.Value
    if ($text.Contains($marker)) {
      return ($text | ConvertFrom-Json)
    }
  }
}

function Eval-Js($socket, [ref]$msgId, $expr) {
  return Invoke-Cdp $socket ([ref]$msgId.Value) "Runtime.evaluate" @{ expression = $expr; awaitPromise = $true; returnByValue = $true }
}

function Wait-ForText($socket, [ref]$msgId, $text, $seconds) {
  $jsonText = $text | ConvertTo-Json -Compress
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $r = Invoke-Cdp $socket ([ref]$msgId.Value) "Runtime.evaluate" @{ expression = "document.body.innerText.includes($jsonText)"; returnByValue = $true }
    if ($r.result.result.value -eq $true) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-JavisWithCdp() {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
  $proc = Start-Process -FilePath $exe -WorkingDirectory $workspacePath -PassThru
  Start-Sleep -Seconds 8
  $target = (Invoke-RestMethod -Uri "http://127.0.0.1:9223/json")[0]
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return @{ Process = $proc; Socket = $ws; Id = 0 }
}

function Stop-Javis($sess) {
  if ($sess -and $sess.Socket) { $sess.Socket.Dispose() }
  if ($sess -and $sess.Process) { Stop-Process -Id $sess.Process.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Get-DbRowCount {
  param($tableName)
  if (!(Test-Path $dbPath)) { return -1 }
  $val = cmd /c "echo SELECT COUNT(*) FROM $tableName; | sqlite3 `"$dbPath`"" 2>&1
  if ($LASTEXITCODE -ne 0 -or !$val) { return -1 }
  $num = 0
  if ([int]::TryParse($val.Trim(), [ref]$num)) { return $num }
  return -1
}

function Get-DbRows {
  param($tableName, $limit = 5)
  if (!(Test-Path $dbPath)) { return "" }
  $val = cmd /c "echo SELECT id, title, status FROM $tableName ORDER BY updated_at DESC LIMIT $limit; | sqlite3 `"$dbPath`"" 2>&1
  if ($LASTEXITCODE -ne 0) { return "" }
  return $val.Trim()
}

$session = $null
$restartSession = $null

try {
  # Phase 1: Run a task
  Write-Host "Phase 1: Starting Javis with CDP..."
  $session = Start-JavisWithCdp
  $msgId = $session.Id

  Start-Sleep -Seconds 3
  $countBefore = Get-DbRowCount "task_history"
  Write-Host "  task_history rows before task: $countBefore"

  # Submit task via CDP
  $js = "(() => { var input = document.querySelector('textarea'); var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, 'what is 2+2?'); input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('button[type=submit]').click(); return 'submitted'; })()"
  Eval-Js $session.Socket ([ref]$msgId) $js | Out-Null

  # Wait for completion
  if (!(Wait-ForText $session.Socket ([ref]$msgId) "Answered" 60)) {
    Write-Warning "Task may not have completed in time"
  }
  Start-Sleep -Seconds 2

  Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "task-history-before-restart.png")
  $countAfter = Get-DbRowCount "task_history"
  $rowsAfter = Get-DbRows "task_history"
  Write-Host "  task_history rows after task: $countAfter"
  Write-Host $rowsAfter

  Stop-Javis $session
  $session = $null

  # Phase 2: Restart and verify
  Write-Host "Phase 2: Restarting Javis..."
  Start-Sleep -Seconds 2
  $restartSession = Start-JavisWithCdp
  $restartId = $restartSession.Id
  Start-Sleep -Seconds 5

  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "task-history-restored-after-restart.png")
  $countRestart = Get-DbRowCount "task_history"
  $rowsRestart = Get-DbRows "task_history"
  Write-Host "  task_history rows after restart: $countRestart"
  Write-Host $rowsRestart

  # Phase 3: Delete test
  $jsDel = "(() => { var buttons = Array.from(document.querySelectorAll('button')); var btn = buttons.find(function(b) { return b.textContent.includes('Delete') || b.textContent.includes('Clear'); }); if (btn) { btn.click(); return 'clicked'; } return 'not found'; })()"
  Eval-Js $restartSession.Socket ([ref]$restartId) $jsDel | Out-Null
  Start-Sleep -Seconds 2
  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "task-history-deleted-after-restart.png")

  # Results
  Write-Host ""
  Write-Host "========================================"
  Write-Host "Task History QA Results"
  Write-Host "========================================"
  Write-Host "DB path: $dbPath"
  Write-Host "Count before: $countBefore | after: $countAfter | restart: $countRestart"
  Write-Host ""

  if ($countAfter -gt 0 -and $countRestart -ge $countAfter) {
    Write-Host "VERDICT: PASS"
  } else {
    Write-Host "VERDICT: FAIL"
    if ($countAfter -le 0) { Write-Host "  - No task history rows after task" }
    if ($countRestart -lt $countAfter) { Write-Host "  - Task history count decreased after restart" }
  }
} finally {
  Stop-Javis $session
  Stop-Javis $restartSession
}
