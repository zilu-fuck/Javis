$ErrorActionPreference = "Stop"

$qaDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $qaDir "..\..\..")).Path
$sourceDir = Join-Path $qaDir "research-search-sources"
$fixturePath = Join-Path $qaDir "research-search-fixture.json"
$exe = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"
$serverJob = $null
$process = $null
$socket = $null

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null
New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null

if (!(Test-Path $exe)) {
  throw "Release executable not found. Run pnpm --filter @javis/desktop tauri build first."
}

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

Write-Utf8NoBom (Join-Path $sourceDir "alpha.html") "<html><head><title>Alpha Search Source</title></head><body>Alpha searched evidence excerpt for Javis product QA. This page proves the search-backed research report can cite fetched evidence.</body></html>"
Write-Utf8NoBom (Join-Path $sourceDir "beta.html") "<html><head><title>Beta Search Source</title></head><body>Beta searched evidence excerpt for Javis product QA. This source is intentionally local and repeatable.</body></html>"
Write-Utf8NoBom (Join-Path $sourceDir "gamma.html") "<html><head><title>Gamma Search Source</title></head><body>Gamma searched evidence excerpt for Javis product QA. Provider metadata should remain visible in the UI.</body></html>"
Write-Utf8NoBom (Join-Path $sourceDir "empty.html") "<html><body></body></html>"

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class NativeQaWin32Research {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECTResearch lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct RECTResearch { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Capture-Window($handle, $path) {
  [NativeQaWin32Research]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object RECTResearch
  [NativeQaWin32Research]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [NativeQaWin32Research]::PrintWindow($handle, $hdc, 2) | Out-Null
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
  Invoke-Cdp $socket ([ref]$id.Value) "Runtime.evaluate" @{
    expression = $expression
    awaitPromise = $true
    returnByValue = $true
  } | Out-Null
}

function Submit-Goal($socket, [ref]$id, $goal) {
  $jsonGoal = $goal | ConvertTo-Json -Compress
  $expression = @"
(() => {
 const goal = $jsonGoal;
 const input = document.querySelector('textarea');
 const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
 setter.call(input, goal);
 input.dispatchEvent(new Event('input', { bubbles: true }));
 return new Promise((resolve) => {
   requestAnimationFrame(() => {
     input.form.requestSubmit();
     resolve(document.body.innerText);
   });
 });
})()
"@
  Eval-Js $socket ([ref]$id.Value) $expression
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
  throw "Timed out waiting for text: $text"
}

function Set-SearchFixture {
  param([object[]]$Items)
  $tempPath = "$fixturePath.tmp"
  if ($Items.Count -eq 0) {
    $json = "[]"
  } else {
    $json = ConvertTo-Json -InputObject $Items -Depth 10
  }
  [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $fixturePath -Force
}

function Source-Item($name, $provider, $path) {
  @{
    url = "http://127.0.0.1:8766/$path"
    title = "$name Search Source"
    excerpt = "$name candidate excerpt from $provider."
    fetchedAt = "2026-05-23T00:00:00.000Z"
    provider = $provider
  }
}

try {
  $serverJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    python -m http.server 8766 --bind 127.0.0.1
  } -ArgumentList $sourceDir

  $serverReady = $false
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    try {
      Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8766/alpha.html" | Out-Null
      $serverReady = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (!$serverReady) {
    throw "Local research QA source server did not start."
  }

  Start-Sleep -Seconds 2
  Set-SearchFixture -Items @()
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
  $env:JAVIS_QA_MODE = "1"
  $env:JAVIS_SEARCH_FIXTURE_PATH = $fixturePath
  $process = Start-Process -FilePath $exe -WorkingDirectory $repoRoot -PassThru
  Start-Sleep -Seconds 8
  $appProcess = Get-Process -Id $process.Id
  $target = (Invoke-RestMethod -Uri "http://127.0.0.1:9223/json")[0]
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $id = 0
  Eval-Js $socket ([ref]$id) "localStorage.clear(); location.reload();"
  Start-Sleep -Seconds 2

  Set-SearchFixture -Items @(
    (Source-Item "Alpha" "github-cli" "alpha.html"),
    (Source-Item "Beta" "github-cli" "beta.html"),
    (Source-Item "Gamma" "github-cli" "gamma.html")
  )
  Submit-Goal $socket ([ref]$id) "Research Javis github-cli product QA"
  Wait-ForText $socket ([ref]$id) "Research sources collected" 20 | Out-Null
  Wait-ForText $socket ([ref]$id) "github-cli" 5 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "09-search-github-cli-completed.png")

  Set-SearchFixture -Items @(
    (Source-Item "Alpha" "agent-chrome" "alpha.html"),
    (Source-Item "Beta" "agent-chrome" "beta.html"),
    (Source-Item "Gamma" "agent-chrome" "gamma.html")
  )
  Submit-Goal $socket ([ref]$id) "Research Javis agent chrome fallback product QA"
  Wait-ForText $socket ([ref]$id) "Research sources collected" 20 | Out-Null
  Wait-ForText $socket ([ref]$id) "agent-chrome" 5 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "10-search-agent-chrome-fallback-completed.png")

  Set-SearchFixture -Items @((Source-Item "Weak" "agent-chrome" "empty.html"))
  Submit-Goal $socket ([ref]$id) "Research Javis weak evidence product QA"
  Wait-ForText $socket ([ref]$id) "0/1 searched sources" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "11-search-weak-evidence-failed.png")

  Set-SearchFixture -Items @(
    @{
      url = "http://127.0.0.1:9876/missing.html"
      title = "Missing Search Source"
      excerpt = "Missing candidate excerpt."
      fetchedAt = "2026-05-23T00:00:00.000Z"
      provider = "github-cli"
    }
  )
  Submit-Goal $socket ([ref]$id) "Research Javis failed fetch product QA"
  Wait-ForText $socket ([ref]$id) "Add source URLs manually as a fallback" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "12-search-failed-fetch-state.png")

  Set-SearchFixture -Items @()
  Submit-Goal $socket ([ref]$id) "Research Javis no results product QA"
  Wait-ForText $socket ([ref]$id) "Research search returned no sources" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "13-search-no-results-state.png")

  $socket.Dispose()
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
finally {
  if ($socket) {
    $socket.Dispose()
  }
  if ($process) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  Remove-Item Env:JAVIS_QA_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:JAVIS_SEARCH_FIXTURE_PATH -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $fixturePath -Force -ErrorAction SilentlyContinue
  if ($serverJob) {
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -Force -ErrorAction SilentlyContinue
  }
}

Get-ChildItem $qaDir -Filter "*-search-*.png" | Sort-Object Name | Select-Object Name,Length
