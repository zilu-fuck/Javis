$ErrorActionPreference = "Continue"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"

taskkill /F /IM javis-desktop.exe 2>$null *>$null
Start-Sleep -Seconds 1
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 8
$t = (Invoke-RestMethod "http://127.0.0.1:9223/json")[0]

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$t.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
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

Write-Host "Test 1: db_select via __TAURI_INTERNALS__"
$r1 = Eval 'window.__TAURI_INTERNALS__.invoke("db_select", {sql: "SELECT 1", bindValues: []}).then(r => "OK: " + JSON.stringify(r)).catch(e => "ERR: " + e)'
Write-Host "  result: $r1"

Write-Host "Test 2: db_execute CREATE TABLE"
$r2 = Eval 'window.__TAURI_INTERNALS__.invoke("db_execute", {sql: "CREATE TABLE IF NOT EXISTS test_invoke (id TEXT)", bindValues: []}).then(r => "OK: " + JSON.stringify(r)).catch(e => "ERR: " + e)'
Write-Host "  result: $r2"

Write-Host "Test 3: db_select to verify table created"
$r3 = Eval 'window.__TAURI_INTERNALS__.invoke("db_select", {sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", bindValues: []}).then(r => "OK: " + JSON.stringify(r)).catch(e => "ERR: " + e)'
Write-Host "  result: $r3"

Write-Host ""
Write-Host "DB file: $(Test-Path "$env:LOCALAPPDATA\app.javis.desktop\javis.db")"
Write-Host "DB size: $((Get-Item "$env:LOCALAPPDATA\app.javis.desktop\javis.db" -ErrorAction SilentlyContinue).Length) bytes"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
