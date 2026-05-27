$ErrorActionPreference = "Continue"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"

taskkill /F /IM javis-desktop.exe 2>$null
rm -Force "$env:LOCALAPPDATA\app.javis.desktop\javis.db" -ErrorAction SilentlyContinue

# Launch with a script that captures errors from the very beginning
# We inject via CDP after connection, but errors before connection are lost.
# Strategy: connect earlier (3s) and wait longer (10s) for initialization to complete
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 3

$target = (Invoke-RestMethod "http://127.0.0.1:9223/json")[0]
Write-Host "Page URL: $($target.url)"

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
$id = 0

function Eval($e) {
  $script:id += 1
  $p = @{ id = $id; method = "Runtime.evaluate"; params = @{ expression = $e; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Depth 10 -Compress
  $ws.SendAsync([ArraySegment[byte]]::new([Text.Encoding]::UTF8.GetBytes($p)), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $b = New-Object byte[] 1048576
  while ($true) {
    $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($b), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $x = [Text.Encoding]::UTF8.GetString($b, 0, $r.Count)
    if ($x.Contains('"id":' + $id)) { return ($x | ConvertFrom-Json).result.result.value }
  }
}

# Check page state after waiting for init
Start-Sleep -Seconds 5

# Check if Tauri bridge was available
$t1 = Eval 'JSON.stringify({ internals: "__TAURI_INTERNALS__" in window, invokeType: typeof window.__TAURI_INTERNALS__?.invoke })'
Write-Host "Tauri bridge: $t1"

# Try to directly call invoke and create tables
$t2 = Eval 'window.__TAURI_INTERNALS__.invoke("db_execute", {sql: "CREATE TABLE IF NOT EXISTS test_fix (id TEXT)", bindValues: []}).then(r => "exec OK: " + JSON.stringify(r)).catch(e => "exec ERR: " + e)'
Write-Host "Direct invoke: $t2"

$t3 = Eval 'window.__TAURI_INTERNALS__.invoke("db_select", {sql: "SELECT name FROM sqlite_master WHERE type=\"table\" ORDER BY name", bindValues: []}).then(r => "tables: " + JSON.stringify(r.map(x => x.name))).catch(e => "ERR: " + e)'
Write-Host "DB tables: $t3"

Write-Host ""
Write-Host "DB file exists: $(Test-Path "$env:LOCALAPPDATA\app.javis.desktop\javis.db")"
Write-Host "DB size: $((Get-Item "$env:LOCALAPPDATA\app.javis.desktop\javis.db" -ErrorAction SilentlyContinue).Length) bytes"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
