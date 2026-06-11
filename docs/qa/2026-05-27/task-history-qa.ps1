param(
  [int]$DevtoolsPort = 9223,
  [switch]$StopExistingJavis
)

$ErrorActionPreference = "Stop"

$qaDir = "E:\Javis\docs\qa\2026-05-27"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"
$workspacePath = "E:\Javis"
$dbPath = "$env:APPDATA\app.javis.desktop\javis.db"
$legacyKey = "javis.taskHistory.v1"
$outputPath = Join-Path $qaDir "task-history-qa-output.txt"
$previousWebviewArgs = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")

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

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
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

function Get-EvalValue($response) {
  if ($response.result.exceptionDetails) {
    $details = $response.result.exceptionDetails | ConvertTo-Json -Depth 8 -Compress
    throw "App JS failed: $details"
  }
  if ($response -and $response.result -and $response.result.result) {
    return $response.result.result.value
  }
  return $null
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
  $existing = @(Get-Process -Name "javis-desktop" -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    if (!$StopExistingJavis) {
      throw "Existing javis-desktop process(es) detected: $($existing.Id -join ', '). Close them first or rerun with -StopExistingJavis."
    }
    $existing | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=$DevtoolsPort", "Process")
  $proc = Start-Process -FilePath $exe -WorkingDirectory $workspacePath -PassThru
  try {
    $deadline = (Get-Date).AddSeconds(90)
    $target = $null
    while ((Get-Date) -lt $deadline) {
      try {
        $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$DevtoolsPort/json" -TimeoutSec 2
        $target = @($targets | Where-Object { $_.webSocketDebuggerUrl } | Select-Object -First 1)[0]
        if ($target) {
          break
        }
      } catch {
        Start-Sleep -Milliseconds 600
      }
    }
    if (!$target) {
      throw "Timed out waiting for WebView2 DevTools target on port $DevtoolsPort."
    }
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    Start-Sleep -Seconds 3
    return @{ Process = $proc; Socket = $ws; Id = 0 }
  } catch {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw
  }
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

function Get-TaskHistoryExists {
  param($taskId)
  if (!(Test-Path $dbPath)) { return $false }
  $escaped = $taskId.Replace("'", "''")
  $val = cmd /c "echo SELECT COUNT(*) FROM task_history WHERE id = '$escaped'; | sqlite3 `"$dbPath`"" 2>&1
  if ($LASTEXITCODE -ne 0 -or !$val) { return $false }
  $num = 0
  return [int]::TryParse($val.Trim(), [ref]$num) -and $num -gt 0
}

$session = $null
$restartSession = $null

try {
  $qaTaskId = "qa-task-history-" + [Guid]::NewGuid().ToString("N")
  $qaTitle = "QA Task History Restore Delete " + $qaTaskId.Substring($qaTaskId.Length - 8)
  $qaGoal = "Verify packaged task history restore and delete"
  $qaUpdatedAt = (Get-Date).ToUniversalTime().ToString("o")

  # Phase 1: Insert a unique QA history entry through the packaged app DB bridge.
  Write-Host "Phase 1: Starting Javis with CDP..."
  $session = Start-JavisWithCdp
  $msgId = $session.Id

  Start-Sleep -Seconds 3
  $countBefore = Get-DbRowCount "task_history"
  Write-Host "  task_history rows before QA insert: $countBefore"

  $qaTaskIdJson = $qaTaskId | ConvertTo-Json -Compress
  $qaTitleJson = $qaTitle | ConvertTo-Json -Compress
  $qaGoalJson = $qaGoal | ConvertTo-Json -Compress
  $qaUpdatedAtJson = $qaUpdatedAt | ConvertTo-Json -Compress
  $insertJs = @"
(async () => {
  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core) ||
    window.__TAURI__?.invoke?.bind(window.__TAURI__) ||
    window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
  if (!invoke) {
    throw new Error("Tauri invoke API is unavailable");
  }
  const snapshot = {
    id: $qaTaskIdJson,
    title: $qaTitleJson,
    userGoal: $qaGoalJson,
    status: "completed",
    updatedAt: $qaUpdatedAtJson,
    originMode: "chat",
    commanderMessage: "QA inserted task history snapshot",
    plan: [],
    agents: [],
    logs: [],
    conversationMessages: [
      { id: $qaTaskIdJson + "-user", role: "user", content: $qaGoalJson, createdAt: $qaUpdatedAtJson },
      { id: $qaTaskIdJson + "-assistant", role: "assistant", content: "QA task history snapshot restored.", createdAt: $qaUpdatedAtJson }
    ],
    verificationSummary: "QA task history fixture"
  };
  await invoke("db_execute", {
    sql: "INSERT INTO task_history (id, title, user_goal, status, updated_at, snapshot_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, user_goal = excluded.user_goal, status = excluded.status, updated_at = excluded.updated_at, snapshot_json = excluded.snapshot_json",
    bindValues: [$qaTaskIdJson, $qaTitleJson, $qaGoalJson, "completed", $qaUpdatedAtJson, JSON.stringify(snapshot)]
  });
  location.reload();
  return snapshot.title;
})()
"@
  Eval-Js $session.Socket ([ref]$msgId) $insertJs | Out-Null
  if (!(Wait-ForText $session.Socket ([ref]$msgId) $qaTitle 30)) {
    throw "Inserted QA task history entry did not appear before restart."
  }
  Start-Sleep -Seconds 2

  Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "task-history-before-restart.png")
  $countAfter = Get-DbRowCount "task_history"
  $existsAfter = Get-TaskHistoryExists $qaTaskId
  $rowsAfter = Get-DbRows "task_history"
  Write-Host "  task_history rows after QA insert: $countAfter"
  Write-Host $rowsAfter

  Stop-Javis $session
  $session = $null

  # Phase 2: Restart and verify
  Write-Host "Phase 2: Restarting Javis..."
  Start-Sleep -Seconds 2
  $restartSession = Start-JavisWithCdp
  $restartId = $restartSession.Id
  Start-Sleep -Seconds 5
  if (!(Wait-ForText $restartSession.Socket ([ref]$restartId) $qaTitle 30)) {
    throw "Inserted QA task history entry did not restore after restart."
  }

  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "task-history-restored-after-restart.png")
  $countRestart = Get-DbRowCount "task_history"
  $existsRestart = Get-TaskHistoryExists $qaTaskId
  $rowsRestart = Get-DbRows "task_history"
  Write-Host "  task_history rows after restart: $countRestart"
  Write-Host $rowsRestart

  # Phase 3: Delete test
  $qaTitleJson = $qaTitle | ConvertTo-Json -Compress
  $jsDel = @"
(() => {
  const title = $qaTitleJson;
  const previousConfirm = window.confirm;
  window.confirm = () => true;
  try {
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((item) => {
      const label = item.getAttribute('aria-label') || '';
      return item.classList.contains('javis-history-delete') && label.includes(title);
    });
    if (!button) {
      return 'not found';
    }
    button.click();
    return 'clicked';
  } finally {
    window.confirm = previousConfirm;
  }
})()
"@
  $deleteResult = Get-EvalValue (Eval-Js $restartSession.Socket ([ref]$restartId) $jsDel)
  Start-Sleep -Seconds 2
  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "task-history-deleted-after-restart.png")
  $countAfterDelete = Get-DbRowCount "task_history"
  $existsAfterDelete = Get-TaskHistoryExists $qaTaskId

  $restorePassed = $existsAfter -and $existsRestart
  $deletePassed = $deleteResult -eq "clicked" -and -not $existsAfterDelete
  $verdict = if ($restorePassed -and $deletePassed) { "PASS" } else { "FAIL" }

  $outputLines = @(
    "# Task History QA Output",
    "",
    "generatedAt: $((Get-Date).ToUniversalTime().ToString("o"))",
    "dbPath: $dbPath",
    "qa task id: $qaTaskId",
    "qa title: $qaTitle",
    "count before: $countBefore",
    "count after: $countAfter",
    "count restart: $countRestart",
    "count after delete: $countAfterDelete",
    "exists after insert: $existsAfter",
    "exists after restart: $existsRestart",
    "exists after delete: $existsAfterDelete",
    "delete result: $deleteResult",
    "",
    "restore: $(if ($restorePassed) { "PASS" } else { "FAIL" })",
    "delete: $(if ($deletePassed) { "PASS" } else { "FAIL" })",
    "verdict: $verdict"
  )
  Write-Utf8NoBom $outputPath ($outputLines -join "`n")

  # Results
  Write-Host ""
  Write-Host "========================================"
  Write-Host "Task History QA Results"
  Write-Host "========================================"
  Write-Host "DB path: $dbPath"
  Write-Host "Count before: $countBefore | after: $countAfter | restart: $countRestart | after delete: $countAfterDelete"
  Write-Host "Output: $outputPath"
  Write-Host ""

  if ($verdict -eq "PASS") {
    Write-Host "VERDICT: PASS"
  } else {
    Write-Host "VERDICT: FAIL"
    if (!$existsAfter) { Write-Host "  - QA task history row was not inserted" }
    if (!$existsRestart) { Write-Host "  - QA task history row did not restore after restart" }
    if (!$deletePassed) { Write-Host "  - Task history delete was not verified" }
    exit 1
  }
} finally {
  if ($qaTaskId) {
    $escaped = $qaTaskId.Replace("'", "''")
    cmd /c "echo DELETE FROM task_history WHERE id = '$escaped'; | sqlite3 `"$dbPath`"" | Out-Null
  }
  Stop-Javis $session
  Stop-Javis $restartSession
  [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $previousWebviewArgs, "Process")
}
