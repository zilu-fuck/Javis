$ErrorActionPreference = "Stop"

$qaDir = "E:\Javis\docs\qa\2026-05-23"
$sourceDir = Join-Path $qaDir "local-sources"
$downloads = Join-Path $env:USERPROFILE "Downloads"
$exe = "E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe"

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null
New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

Set-Content -LiteralPath (Join-Path $sourceDir "alpha.html") -Value "<html><head><title>Alpha Source</title></head><body>Alpha evidence excerpt for Javis release QA. This page is served locally for source-backed research verification.</body></html>" -Encoding UTF8
Set-Content -LiteralPath (Join-Path $sourceDir "beta.html") -Value "<html><head><title>Beta Source</title></head><body>Beta evidence excerpt for Javis release QA. This page is served locally for source-backed research verification.</body></html>" -Encoding UTF8
Set-Content -LiteralPath (Join-Path $sourceDir "empty.html") -Value "<html><head><title>Empty Source</title></head><body></body></html>" -Encoding UTF8

$denyPdf = Join-Path $downloads "javis-release-deny.pdf"
$approvePdf = Join-Path $downloads "javis-release-approve.pdf"
$conflictPdf = Join-Path $downloads "javis-release-conflict.pdf"
$conflictTargetDir = Join-Path $downloads "Unsorted"
$conflictTargetPdf = Join-Path $conflictTargetDir "javis-release-conflict.pdf"
Remove-Item -LiteralPath $denyPdf -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $approvePdf -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $conflictPdf -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $downloads "Unsorted\javis-release-deny.pdf") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $downloads "Unsorted\javis-release-approve.pdf") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $conflictTargetPdf -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $denyPdf -Value "%PDF-1.4 disposable deny qa" -Encoding Ascii
Set-Content -LiteralPath $approvePdf -Value "%PDF-1.4 disposable approve qa" -Encoding Ascii

$serverJob = Start-Job -ScriptBlock {
  param($dir)
  Set-Location $dir
  python -m http.server 8765 --bind 127.0.0.1
} -ArgumentList $sourceDir

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class NativeQaWin32D {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECTD lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct RECTD { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Capture-Window($handle, $path) {
  [NativeQaWin32D]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object RECTD
  [NativeQaWin32D]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [NativeQaWin32D]::PrintWindow($handle, $hdc, 2) | Out-Null
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
 const input = document.querySelector('textarea[aria-label="Task input"]');
 const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
 setter.call(input, goal);
 input.dispatchEvent(new Event('input', { bubbles: true }));
 document.querySelector('button[type="submit"]').click();
 return document.body.innerText;
})()
"@
  Eval-Js $socket ([ref]$id.Value) $expression
}

function Click-Button($socket, [ref]$id, $text) {
  $jsonText = $text | ConvertTo-Json -Compress
  $expression = @"
(() => {
 const text = $jsonText;
 const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent.trim() === text && !candidate.disabled);
 if (!button) throw new Error('Button not found: ' + text);
 button.click();
 return document.body.innerText;
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
  return $false
}

try {
  Start-Sleep -Seconds 2
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
  $process = Start-Process -FilePath $exe -WorkingDirectory "E:\Javis" -PassThru
  Start-Sleep -Seconds 8
  $appProcess = Get-Process -Id $process.Id
  $target = (Invoke-RestMethod -Uri "http://127.0.0.1:9222/json")[0]
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $id = 0

  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "01-native-idle-workbench.png")
  Submit-Goal $socket ([ref]$id) "Find Markdown documents in this workspace"
  Wait-ForText $socket ([ref]$id) "Workspace documents scanned" 15 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "02-markdown-scan-completed.png")

  Submit-Goal $socket ([ref]$id) "test project environment"
  Wait-ForText $socket ([ref]$id) "Project environment inspected" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "03-project-inspection-completed.png")

  Submit-Goal $socket ([ref]$id) "Compare https://example.com and https://www.iana.org/domains/reserved"
  Wait-ForText $socket ([ref]$id) "Research sources collected" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "04-research-report-completed.png")

  Submit-Goal $socket ([ref]$id) "Organize PDFs in Downloads"
  Wait-ForText $socket ([ref]$id) "PDF organization approval needed" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "05-pdf-permission-card.png")
  Click-Button $socket ([ref]$id) "Deny"
  Wait-ForText $socket ([ref]$id) "PDF organization denied" 10 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "07-pdf-denied-result.png")

  if (!(Test-Path $approvePdf)) {
    Set-Content -LiteralPath $approvePdf -Value "%PDF-1.4 disposable approve qa" -Encoding Ascii
  }
  Submit-Goal $socket ([ref]$id) "Organize PDFs in Downloads"
  Wait-ForText $socket ([ref]$id) "PDF organization approval needed" 20 | Out-Null
  Click-Button $socket ([ref]$id) "Approve"
  Wait-ForText $socket ([ref]$id) "PDF organization completed" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "06-pdf-approved-result.png")

  if (!(Test-Path $conflictPdf)) {
    Set-Content -LiteralPath $conflictPdf -Value "%PDF-1.4 disposable conflict source qa" -Encoding Ascii
  }
  New-Item -ItemType Directory -Force -Path $conflictTargetDir | Out-Null
  if (!(Test-Path $conflictTargetPdf)) {
    Set-Content -LiteralPath $conflictTargetPdf -Value "%PDF-1.4 disposable conflict target qa" -Encoding Ascii
  }
  Submit-Goal $socket ([ref]$id) "Organize PDFs in Downloads"
  Wait-ForText $socket ([ref]$id) "PDF organization approval needed" 20 | Out-Null
  Click-Button $socket ([ref]$id) "Approve"
  Wait-ForText $socket ([ref]$id) "PDF organization completed" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "06b-pdf-conflict-skipped.png")

  Submit-Goal $socket ([ref]$id) "Compare http://127.0.0.1:8765/empty.html"
  Wait-ForText $socket ([ref]$id) "Research source verification failed" 20 | Out-Null
  Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir "08-failed-verification-state.png")

  $socket.Dispose()
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
finally {
  Stop-Job $serverJob -ErrorAction SilentlyContinue
  Remove-Job $serverJob -Force -ErrorAction SilentlyContinue
}

Get-ChildItem $qaDir -Filter "*.png" | Sort-Object Name | Select-Object Name,Length
