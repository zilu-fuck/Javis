$ErrorActionPreference = "Stop"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"

taskkill /F /IM javis-desktop.exe 2>$null
rm -Force "$env:APPDATA\app.javis.desktop\javis.db" -ErrorAction SilentlyContinue
Write-Host "Starting Javis release binary with CDP..."

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 8

$target = (Invoke-RestMethod -Uri "http://127.0.0.1:9223/json")[0]
Write-Host "URL: $($target.url)"
Write-Host "Title: $($target.title)"

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
$id = 0

function Eval($e) {
  $script:id += 1
  $p = @{ id = $id; method = 'Runtime.evaluate'; params = @{ expression = $e; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Depth 10 -Compress
  $ws.SendAsync([ArraySegment[byte]]::new([Text.Encoding]::UTF8.GetBytes($p)), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $b = New-Object byte[] 1048576
  while ($true) {
    $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($b), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $x = [Text.Encoding]::UTF8.GetString($b, 0, $r.Count)
    if ($x.Contains('"id":' + $id)) { return ($x | ConvertFrom-Json).result.result.value }
  }
}

# Check Tauri bridge
$t1 = Eval 'JSON.stringify(Object.keys(window).filter(k => k.includes("TAURI") || k.includes("ipc") || k.includes("__")))'
Write-Host "Tauri globals: $t1"

$t2 = Eval 'JSON.stringify({ internals: "__TAURI_INTERNALS__" in window, invoke: typeof window.__TAURI_INTERNALS__?.invoke, ipc: typeof window.__TAURI_INTERNALS__?.ipc })'
Write-Host "Tauri bridge status: $t2"

# Check localStorage for migration evidence
$t3 = Eval 'JSON.stringify({ modelSettings: !!localStorage.getItem("javis.modelSettings.v1"), taskHistory: !!localStorage.getItem("javis.taskHistory.v1"), scheduled: !!localStorage.getItem("javis.scheduledTasks.v1") })'
Write-Host "localStorage state: $t3"

# Check if React root has content
$t4 = Eval 'document.getElementById("root")?.innerText?.substring(0, 200) || "EMPTY ROOT"'
Write-Host "Root content: $t4"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

Write-Host "DB exists: $(Test-Path "$env:APPDATA\app.javis.desktop\javis.db")"
Write-Host "DB size: $((Get-Item "$env:APPDATA\app.javis.desktop\javis.db" -ErrorAction SilentlyContinue).Length) bytes"
