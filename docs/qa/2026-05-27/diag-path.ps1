$ErrorActionPreference = "Continue"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"

taskkill /F /IM javis-desktop.exe 2>$null *>$null
Start-Sleep -Seconds 1
rm -Force "$env:LOCALAPPDATA\app.javis.desktop\javis.db" -ErrorAction SilentlyContinue
rm -Force "$env:LOCALAPPDATA\app.javis.desktop\javis.db-*" -ErrorAction SilentlyContinue

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 5

$target = (Invoke-RestMethod "http://127.0.0.1:9223/json")[0]
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

# Test db_debug_path
$r1 = Eval 'window.__TAURI_INTERNALS__.invoke("db_debug_path").then(r => "PATH: " + r).catch(e => "ERR: " + e)'
Write-Host "db_debug_path: $r1"

# Check Tauri bridge at this point
$r2 = Eval 'JSON.stringify({ t: typeof window.__TAURI_INTERNALS__?.invoke })'
Write-Host "bridge: $r2"

# Try db_execute and check immediately
$r3 = Eval 'window.__TAURI_INTERNALS__.invoke("db_execute", {sql: "CREATE TABLE IF NOT EXISTS pathtest (id TEXT)", bindValues: []}).then(() => "exec ok").catch(e => "exec err: " + e)'
Write-Host "create table: $r3"

$r4 = Eval 'window.__TAURI_INTERNALS__.invoke("db_select", {sql: "SELECT name FROM sqlite_master WHERE type=\"table\"", bindValues: []}).then(r => "tables: " + JSON.stringify(r.map(x => x.name))).catch(e => "ERR: " + e)'
Write-Host "tables: $r4"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
