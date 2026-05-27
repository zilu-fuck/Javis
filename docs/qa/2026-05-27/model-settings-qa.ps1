$ErrorActionPreference = "Stop"

$qaDir = "E:\Javis\docs\qa\2026-05-27"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"
$workspacePath = "E:\Javis"
$dbPath = "$env:APPDATA\app.javis.desktop\javis.db"
$legacyKey = "javis.modelSettings.v1"

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ModelSettingsWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ModelSettingsRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct ModelSettingsRect { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Capture-Window($handle, $path) {
  [ModelSettingsWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object ModelSettingsRect
  [ModelSettingsWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [ModelSettingsWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
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

function Start-JavisWithCdp() {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9224"
  $proc = Start-Process -FilePath $exe -WorkingDirectory $workspacePath -PassThru
  Start-Sleep -Seconds 8
  $target = (Invoke-RestMethod -Uri "http://127.0.0.1:9224/json")[0]
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return @{ Process = $proc; Socket = $ws; Id = 0 }
}

function Stop-Javis($sess) {
  if ($sess -and $sess.Socket) { $sess.Socket.Dispose() }
  if ($sess -and $sess.Process) { Stop-Process -Id $sess.Process.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Get-ModelSettingsRow {
  if (!(Test-Path $dbPath)) { return "" }
  $val = cmd /c "echo SELECT id, provider, model, base_url, updated_at FROM model_settings WHERE id = 'default'; | sqlite3 `"$dbPath`"" 2>&1
  if ($LASTEXITCODE -ne 0) { return "" }
  return $val.Trim()
}

$session = $null
$restartSession = $null

try {
  # Phase 1: Configure settings
  Write-Host "Phase 1: Starting Javis with CDP..."
  $session = Start-JavisWithCdp
  $msgId = $session.Id

  Start-Sleep -Seconds 3
  $dbBefore = Get-ModelSettingsRow
  Write-Host "  model_settings before config: $dbBefore"

  # Open settings
  $jsOpen = "(() => { var buttons = Array.from(document.querySelectorAll('button')); var btn = buttons.find(function(b) { return b.textContent.includes('Settings') || b.textContent.includes('设置'); }); if (btn) { btn.click(); return 'opened'; } return 'not found'; })()"
  Eval-Js $session.Socket ([ref]$msgId) $jsOpen | Out-Null
  Start-Sleep -Seconds 2

  # Configure provider + model + base URL
  $jsCfg = "(() => { var selects = Array.from(document.querySelectorAll('select')); var psel = selects.find(function(s) { var label = s.closest('label') || s.parentElement; return label && label.textContent && (label.textContent.includes('Provider') || label.textContent.includes('提供商')); }); if (psel) { psel.value = 'openai'; psel.dispatchEvent(new Event('change', { bubbles: true })); } var inputs = Array.from(document.querySelectorAll('input')); var minp = inputs.find(function(i) { var label = i.closest('label') || i.parentElement; return label && label.textContent && (label.textContent.includes('Model') || label.textContent.includes('模型')); }); if (minp) { var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(minp, 'gpt-4o'); minp.dispatchEvent(new Event('input', { bubbles: true })); } var binp = inputs.find(function(i) { var label = i.closest('label') || i.parentElement; return label && label.textContent && label.textContent.includes('Base URL'); }); if (binp) { var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(binp, 'https://api.openai.com/v1'); binp.dispatchEvent(new Event('input', { bubbles: true })); } return 'configured'; })()"
  Eval-Js $session.Socket ([ref]$msgId) $jsCfg | Out-Null
  Start-Sleep -Seconds 2

  Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "model-settings-before-restart.png")
  $dbAfter = Get-ModelSettingsRow
  Write-Host "  model_settings after config: $dbAfter"

  Stop-Javis $session
  $session = $null

  # Phase 2: Restart and verify
  Write-Host "Phase 2: Restarting Javis..."
  Start-Sleep -Seconds 2
  $restartSession = Start-JavisWithCdp
  $restartId = $restartSession.Id
  Start-Sleep -Seconds 5

  # Open settings again
  $jsOpen2 = "(() => { var buttons = Array.from(document.querySelectorAll('button')); var btn = buttons.find(function(b) { return b.textContent.includes('Settings') || b.textContent.includes('设置'); }); if (btn) { btn.click(); return 'opened'; } return 'not found'; })()"
  Eval-Js $restartSession.Socket ([ref]$restartId) $jsOpen2 | Out-Null
  Start-Sleep -Seconds 2

  Capture-Window $restartSession.Process.MainWindowHandle (Join-Path $qaDir "model-settings-restored-after-restart.png")
  $dbRestart = Get-ModelSettingsRow
  Write-Host "  model_settings after restart: $dbRestart"

  # Results
  Write-Host ""
  Write-Host "========================================"
  Write-Host "Model Settings QA Results"
  Write-Host "========================================"
  Write-Host "DB path: $dbPath"
  Write-Host "Before: $dbBefore"
  Write-Host "After:  $dbAfter"
  Write-Host "Restart: $dbRestart"
  Write-Host ""

  # Compare ignoring updated_at timestamp (last field)
  $fieldsAfter = ($dbAfter -split '\|')[0..3] -join '|'
  $fieldsRestart = ($dbRestart -split '\|')[0..3] -join '|'
  $ok = ($dbAfter -ne "") -and ($fieldsAfter -eq $fieldsRestart)
  if ($ok) {
    Write-Host "VERDICT: PASS"
  } else {
    Write-Host "VERDICT: FAIL"
    if ($dbAfter -eq "") { Write-Host "  - Settings not saved to SQLite" }
    if ($fieldsAfter -ne $fieldsRestart) { Write-Host "  - Settings changed after restart" }
  }
} finally {
  Stop-Javis $session
  Stop-Javis $restartSession
}
