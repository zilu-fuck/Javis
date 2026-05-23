$ErrorActionPreference = "Stop"

$qaDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $qaDir "..\..\..")).Path
$exe = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"

if (!(Test-Path $exe)) {
  throw "Release executable not found. Run pnpm --filter @javis/desktop tauri build first."
}

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class NativeQaWin32LiveResearch {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECTLiveResearch lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct RECTLiveResearch { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Capture-Window($handle, $path) {
  [NativeQaWin32LiveResearch]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object RECTLiveResearch
  [NativeQaWin32LiveResearch]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [NativeQaWin32LiveResearch]::PrintWindow($handle, $hdc, 2) | Out-Null
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
    $message = New-Object System.Text.StringBuilder
    while ($true) {
      $receiveTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
      try {
        $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $receiveTimeout.Token).GetAwaiter().GetResult()
      } catch {
        throw "Timed out waiting for CDP response to $method"
      } finally {
        $receiveTimeout.Dispose()
      }
      if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        throw "CDP socket closed while waiting for response to $method"
      }
      [void]$message.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
      if ($result.EndOfMessage) {
        break
      }
    }
    $text = $message.ToString()
    try {
      $parsed = $text | ConvertFrom-Json
    } catch {
      continue
    }
    if ($null -ne $parsed.id -and $parsed.id -eq $id.Value) {
      return $parsed
    }
  }
}

function Eval-Js($socket, [ref]$id, $expression) {
  Invoke-Cdp $socket $id "Runtime.evaluate" @{
    expression = $expression
    awaitPromise = $true
    returnByValue = $true
  } | Out-Null
}

function Get-PageText($socket, [ref]$id) {
  $response = Invoke-Cdp $socket $id "Runtime.evaluate" @{
    expression = "document.body.innerText"
    returnByValue = $true
  }
  return $response.result.result.value
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
  Eval-Js $socket $id $expression
}

function Wait-ForText($socket, [ref]$id, $text, $seconds) {
  $jsonText = $text | ConvertTo-Json -Compress
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $response = Invoke-Cdp $socket $id "Runtime.evaluate" @{
      expression = "document.body.innerText.includes($jsonText)"
      returnByValue = $true
    }
    if ($response.result.result.value -eq $true) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  $pageText = Get-PageText $socket $id
  if ($pageText.Length -gt 2000) {
    $pageText = $pageText.Substring(0, 2000)
  }
  throw "Timed out waiting for text: $text`nCurrent page text:`n$pageText"
}

function Run-LiveSmoke($port, $goal, $provider, $screenshot, $disableGithubCli, $providerWaitSeconds) {
  $process = $null
  $socket = $null
  $previousWebviewArgs = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")
  $previousDisableGithubCli = [Environment]::GetEnvironmentVariable("JAVIS_SEARCH_DISABLE_GITHUB_CLI", "Process")
  try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
    if ($disableGithubCli) {
      $env:JAVIS_SEARCH_DISABLE_GITHUB_CLI = "1"
    } else {
      Remove-Item Env:JAVIS_SEARCH_DISABLE_GITHUB_CLI -ErrorAction SilentlyContinue
    }
    $process = Start-Process -FilePath $exe -WorkingDirectory $repoRoot -PassThru
    Start-Sleep -Seconds 8
    $appProcess = Get-Process -Id $process.Id
    $target = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/json")[0]
    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $id = 0
    Eval-Js $socket ([ref]$id) "localStorage.clear(); location.reload();"
    Start-Sleep -Seconds 2
    Submit-Goal $socket ([ref]$id) $goal
    Wait-ForText $socket ([ref]$id) $provider $providerWaitSeconds | Out-Null
    Wait-ForText $socket ([ref]$id) "searched sources include URL and excerpt" 45 | Out-Null
    Capture-Window $appProcess.MainWindowHandle (Join-Path $qaDir $screenshot)
  }
  finally {
    if ($socket) {
      $socket.Dispose()
    }
    if ($process) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $previousWebviewArgs) {
      Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    } else {
      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebviewArgs
    }
    if ($null -eq $previousDisableGithubCli) {
      Remove-Item Env:JAVIS_SEARCH_DISABLE_GITHUB_CLI -ErrorAction SilentlyContinue
    } else {
      $env:JAVIS_SEARCH_DISABLE_GITHUB_CLI = $previousDisableGithubCli
    }
  }
}

Run-LiveSmoke 9224 "research" "github-cli" "14-search-live-github-cli-smoke.png" $false 45
Run-LiveSmoke 9225 "research" "agent-chrome" "15-search-live-agent-chrome-smoke.png" $true 90

Get-ChildItem $qaDir -Filter "*live-*.png" | Sort-Object Name | Select-Object Name,Length
