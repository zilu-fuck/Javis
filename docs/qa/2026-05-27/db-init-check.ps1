$ErrorActionPreference = "Stop"

$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"
$workspacePath = "E:\Javis"
$dbPath = "$env:APPDATA\app.javis.desktop\javis.db"

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
    if ($text.Contains($marker)) { return ($text | ConvertFrom-Json) }
  }
}

function Eval-Js($socket, [ref]$msgId, $expr) {
  return Invoke-Cdp $socket ([ref]$msgId.Value) "Runtime.evaluate" @{ expression = $expr; awaitPromise = $true; returnByValue = $true }
}

# Enable console capture
function Enable-ConsoleCapture($socket, [ref]$msgId) {
  Invoke-Cdp $socket ([ref]$msgId.Value) "Runtime.enable" @{} | Out-Null
  Invoke-Cdp $socket ([ref]$msgId.Value) "Log.enable" @{} | Out-Null
}

function Get-ConsoleMessages($socket, [ref]$msgId) {
  return Invoke-Cdp $socket ([ref]$msgId.Value) "Runtime.evaluate" @{ expression = "JSON.stringify(window.__javisDbErrors || [])"; returnByValue = $true }
}

# Start Javis with CDP
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$proc = Start-Process -FilePath $exe -WorkingDirectory $workspacePath -PassThru
Start-Sleep -Seconds 8
$target = (Invoke-RestMethod -Uri "http://127.0.0.1:9223/json")[0]
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
$msgId = 0

Write-Host "Connected to Javis CDP. Checking app state..."

# Check if database tables exist via Tauri invoke
Start-Sleep -Seconds 3
$checkDb = Eval-Js $ws ([ref]$msgId) "(async () => { try { var r = await window.__TAURI__.invoke('db_select', { sql: \"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\", bindValues: [] }); return JSON.stringify(r); } catch(e) { return 'TAURI_ERROR: ' + e.message; } })()"
Write-Host "DB tables via Tauri: $($checkDb.result.result.value)"

# Check localStorage state (to see if migration ran and fell back)
$ls = Eval-Js $ws ([ref]$msgId) "(function() { var keys = []; for (var i = 0; i < localStorage.length; i++) { keys.push(localStorage.key(i) + '=' + (localStorage.getItem(localStorage.key(i)) || '').substring(0, 80)); } return keys.join(' | '); })()"
Write-Host "localStorage keys: $($ls.result.result.value)"

# Check console errors
Enable-ConsoleCapture $ws ([ref]$msgId)
Start-Sleep -Seconds 1
$consoleMsgs = Eval-Js $ws ([ref]$msgId) "(function() { return 'checked'; })()"
Write-Host "Console check: $($consoleMsgs.result.result.value)"

# Check database file
Write-Host ""
Write-Host "DB file size: $((Get-Item $dbPath -ErrorAction SilentlyContinue).Length) bytes"
Write-Host "DB file exists: $(Test-Path $dbPath)"

# Check if app has __TAURI__ (Tauri bridge available)
$tauriCheck = Eval-Js $ws ([ref]$msgId) "JSON.stringify({ hasTauri: !!window.__TAURI__, hasInvoke: !!(window.__TAURI__ && window.__TAURI__.invoke) })"
Write-Host "Tauri bridge: $($tauriCheck.result.result.value)"

# Cleanup
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
