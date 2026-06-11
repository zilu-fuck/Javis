param(
  [string]$RepoRoot = "",
  [int]$DevtoolsPort = 9341,
  [string]$ModelPath = "",
  [ValidateSet("auto", "onnxruntime", "openvino", "tensorrt")]
  [string]$Runtime = "onnxruntime",
  [int]$LocalVisionTimeoutMs = 2000,
  [switch]$SkipLocalVision,
  [switch]$RequireLocalVision
)

$ErrorActionPreference = "Stop"

if (!$RepoRoot.Trim()) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
}

$qaDir = $PSScriptRoot
$exe = Join-Path $RepoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"
$resultsPath = Join-Path $qaDir "computer-use-release-qa-output.json"
$reportPath = Join-Path $qaDir "computer-use-release-qa-report.md"
$appScreenshotPath = Join-Path $qaDir "01-computer-use-release-app.png"
$checks = [System.Collections.Generic.List[object]]::new()
$session = $null
$previousWebViewArgs = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")
$previousQaMode = [Environment]::GetEnvironmentVariable("JAVIS_QA_MODE", "Process")

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ComputerUseReleaseQaWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ComputerUseReleaseQaRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct ComputerUseReleaseQaRect { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

function Add-Check($id, $passed, $detail) {
  $checks.Add([ordered]@{
    id = $id
    passed = [bool]$passed
    detail = [string]$detail
  }) | Out-Null
}

function Capture-Window($handle, $path) {
  [ComputerUseReleaseQaWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 600
  $rect = New-Object ComputerUseReleaseQaRect
  [ComputerUseReleaseQaWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    throw "Invalid window bounds for screenshot."
  }
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [ComputerUseReleaseQaWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
  $graphics.ReleaseHdc($hdc)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

function Invoke-Cdp($socket, [ref]$id, $method, $params) {
  $id.Value += 1
  $payload = @{ id = $id.Value; method = $method; params = $params } | ConvertTo-Json -Depth 40 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $buffer = New-Object byte[] 4194304
  while ($true) {
    $message = [System.Text.StringBuilder]::new()
    while ($true) {
      $segment = [ArraySegment[byte]]::new($buffer)
      $receive = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($receive.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        throw "CDP socket closed while waiting for $method."
      }
      [void]$message.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $receive.Count))
      if ($receive.EndOfMessage) {
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
  return Invoke-Cdp $socket $id "Runtime.evaluate" @{
    expression = $expression
    awaitPromise = $true
    returnByValue = $true
  }
}

function Invoke-AppJs($session, $script) {
  if ($session -is [object[]]) {
    $session = @($session | Where-Object { $_ -is [hashtable] })[0]
  }
  $id = [int]$session["Id"]
  $response = Eval-Js $session["Socket"] ([ref]$id) $script
  $session["Id"] = $id
  if ($response.result.exceptionDetails) {
    $text = $response.result.exceptionDetails.text
    $description = $response.result.exceptionDetails.exception.description
    throw "App JS failed: $text $description"
  }
  return $response.result.result.value
}

function Wait-ForCdpTarget {
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$DevtoolsPort/json" -TimeoutSec 2
      $target = @($targets | Where-Object { $_.webSocketDebuggerUrl })[0]
      if ($target) {
        return $target
      }
    } catch {
      Start-Sleep -Milliseconds 600
    }
  }
  throw "Timed out waiting for WebView2 DevTools target on port $DevtoolsPort."
}

function Get-AppWindowHandle($process) {
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if ($null -ne $process) {
      $process.Refresh()
      if ($process.MainWindowHandle -ne 0) {
        return $process.MainWindowHandle
      }
    }
    $candidate = Get-Process -Name "javis-desktop" -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.MainWindowHandle
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Could not find javis-desktop main window."
}

function Start-ReleaseApp {
  if (!(Test-Path $exe)) {
    throw "Release executable not found: $exe. Run corepack pnpm desktop:build first."
  }
  [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=$DevtoolsPort", "Process")
  [Environment]::SetEnvironmentVariable("JAVIS_QA_MODE", "1", "Process")
  $process = Start-Process -FilePath $exe -PassThru
  $target = Wait-ForCdpTarget
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  Start-Sleep -Seconds 4
  return ,@{
    Process = $process
    Socket = $socket
    Id = 0
  }
}

function Stop-ReleaseApp($session) {
  if ($null -eq $session) {
    return
  }
  if ($session["Socket"]) {
    $session["Socket"].Dispose()
  }
  if ($session["Process"]) {
    Stop-Process -Id $session["Process"].Id -Force -ErrorAction SilentlyContinue
  } else {
    Get-Process -Name "javis-desktop" -ErrorAction SilentlyContinue |
      Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}

function Format-CheckLine($check) {
  $mark = if ($check.passed) { "PASS" } else { "FAIL" }
  return "- [$mark] $($check.id): $($check.detail)"
}

$result = [ordered]@{
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  repoRoot = $RepoRoot
  exe = $exe
  devtoolsPort = $DevtoolsPort
  screenshotEvidence = $appScreenshotPath
  basic = $null
  localVision = $null
  checks = @()
}

try {
  $session = Start-ReleaseApp
  Add-Check "release-app-start" $true "release executable launched and DevTools target attached"
  $windowHandle = Get-AppWindowHandle $session["Process"]
  Capture-Window $windowHandle $appScreenshotPath
  Add-Check "release-app-screenshot" (Test-Path $appScreenshotPath) "captured app evidence image"

  $basicScript = @'
(async () => {
  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core) ||
    window.__TAURI__?.invoke?.bind(window.__TAURI__) ||
    window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
  if (!invoke) {
    throw new Error("Tauri invoke API is unavailable");
  }
  const screenshot = await invoke("computer_screenshot", { request: {} });
  const windows = await invoke("computer_list_windows", { request: {} });
  const foreground = (windows.windows || []).find((window) => window.isForeground && window.title) ||
    (windows.windows || []).find((window) => window.isVisible && window.title);
  let leaseCreated = false;
  if (foreground) {
    await invoke("computer_approve_action", {
      approvalId: `qa-computer-use-lease-${Date.now()}`,
      taskId: "qa-computer-use-release",
      toolName: "computer.focusWindow",
      paramsJson: JSON.stringify({ handle: foreground.handle }),
      sessionWide: true,
    });
    leaseCreated = true;
    await invoke("computer_cancel_approvals", { taskId: "qa-computer-use-release" });
  }
  let sensitiveSessionWideRejected = false;
  try {
    await invoke("computer_approve_action", {
      approvalId: `qa-computer-use-sensitive-${Date.now()}`,
      taskId: "qa-computer-use-sensitive",
      toolName: "computer.type",
      paramsJson: JSON.stringify({ text: "qa" }),
      sessionWide: true,
    });
  } catch (error) {
    sensitiveSessionWideRejected = /per-action|fresh/i.test(String(error));
  } finally {
    await invoke("computer_cancel_approvals", { taskId: "qa-computer-use-sensitive" }).catch(() => undefined);
  }
  let dangerousKeyComboRejected = false;
  try {
    await invoke("computer_approve_action", {
      approvalId: `qa-computer-use-dangerous-key-${Date.now()}`,
      taskId: "qa-computer-use-dangerous-key",
      toolName: "computer.keyCombo",
      paramsJson: JSON.stringify({ keys: ["Win", "R"] }),
      sessionWide: false,
    });
  } catch (error) {
    dangerousKeyComboRejected = /denied|key combination/i.test(String(error));
  } finally {
    await invoke("computer_cancel_approvals", { taskId: "qa-computer-use-dangerous-key" }).catch(() => undefined);
  }
  let emergencyHotkeyToggled = false;
  try {
    await invoke("computer_set_emergency_hotkey_enabled", { enabled: true });
    await invoke("computer_set_emergency_hotkey_enabled", { enabled: false });
    emergencyHotkeyToggled = true;
  } finally {
    await invoke("computer_set_emergency_hotkey_enabled", { enabled: false }).catch(() => undefined);
  }
  const missingModel = await invoke("computer_detect_ui_objects", {
    request: {
      imageDataUrl: screenshot.dataUrl,
      screenshotId: "qa-missing-model",
      modelPath: "Z:\\javis-missing-yolo26n-ui.onnx",
      runtime: "onnxruntime",
      timeoutMs: 50,
      maxDetections: 5,
      minConfidence: 0.75,
    },
  });
  return {
    bodyTextChars: document.body.innerText.length,
    screenshot: {
      hasPngDataUrl: /^data:image\/png;base64,/.test(screenshot.dataUrl),
      dataUrlChars: screenshot.dataUrl.length,
      width: screenshot.width,
      height: screenshot.height,
      sourceWidth: screenshot.sourceWidth,
      sourceHeight: screenshot.sourceHeight,
      methodUsed: screenshot.methodUsed,
      health: screenshot.health,
    },
    windows: {
      count: (windows.windows || []).length,
      foregroundPresent: !!foreground,
      foregroundHandle: foreground?.handle || null,
    },
    approval: {
      leaseCreated,
      sensitiveSessionWideRejected,
      dangerousKeyComboRejected,
    },
    emergencyHotkey: {
      toggled: emergencyHotkeyToggled,
    },
    missingLocalVision: {
      returned: !!missingModel,
      detections: (missingModel.detections || []).length,
      timedOut: !!missingModel.timedOut,
      error: missingModel.error || "",
      latencyMs: missingModel.latencyMs,
      runtime: missingModel.runtime,
    },
  };
})()
'@
  $basic = Invoke-AppJs $session $basicScript
  $result.basic = $basic

  Add-Check "computer-screenshot-read" ($basic.screenshot.hasPngDataUrl -and $basic.screenshot.width -gt 0 -and $basic.screenshot.height -gt 0) "desktop screenshot returned $($basic.screenshot.width)x$($basic.screenshot.height) via $($basic.screenshot.methodUsed)"
  Add-Check "computer-screenshot-health" (-not [bool]$basic.screenshot.health.suspiciousBlank) "screenshot health reason: $($basic.screenshot.health.reason)"
  Add-Check "computer-list-windows" ($basic.windows.count -gt 0) "listed $($basic.windows.count) windows; foregroundPresent=$($basic.windows.foregroundPresent)"
  Add-Check "computer-approval-lease" ([bool]$basic.approval.leaseCreated) "created and cancelled a scoped Computer Use task approval lease"
  Add-Check "computer-sensitive-approval" ([bool]$basic.approval.sensitiveSessionWideRejected) "session-wide approval for computer.type was rejected"
  Add-Check "computer-dangerous-key-combo" ([bool]$basic.approval.dangerousKeyComboRejected) "approval preflight rejected computer.keyCombo Win+R without executing it"
  Add-Check "computer-emergency-hotkey-command" ([bool]$basic.emergencyHotkey.toggled) "global Escape hotkey command enabled and disabled"
  $missingModelFailOpen = [bool]$basic.missingLocalVision.returned -and
    $basic.missingLocalVision.detections -eq 0 -and
    ([bool]$basic.missingLocalVision.timedOut -or [bool]$basic.missingLocalVision.error)
  Add-Check "local-vision-missing-model-fail-open" $missingModelFailOpen "missing model returned structured empty result: timedOut=$($basic.missingLocalVision.timedOut), error='$($basic.missingLocalVision.error)'"

  if (!$SkipLocalVision) {
    if (!$ModelPath.Trim()) {
      $ModelPath = Join-Path $RepoRoot "artifacts\local-vision\yolo26n-ui.onnx"
    }
    if (Test-Path $ModelPath) {
      $resolvedModelPath = (Resolve-Path $ModelPath).Path
      $modelPathJson = $resolvedModelPath | ConvertTo-Json -Compress
      $runtimeJson = $Runtime | ConvertTo-Json -Compress
      $timeoutValue = [Math]::Max(20, [Math]::Min(2000, $LocalVisionTimeoutMs))
      $localVisionScript = @"
(async () => {
  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core) ||
    window.__TAURI__?.invoke?.bind(window.__TAURI__) ||
    window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
  if (!invoke) {
    throw new Error("Tauri invoke API is unavailable");
  }
  const screenshot = await invoke("computer_screenshot", { request: {} });
  const started = performance.now();
  const detection = await invoke("computer_detect_ui_objects", {
    request: {
      imageDataUrl: screenshot.dataUrl,
      screenshotId: "qa-yolo26-ui",
      modelPath: $modelPathJson,
      runtime: $runtimeJson,
      timeoutMs: $timeoutValue,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      reuseWorker: true,
    },
  });
  return {
    model: detection.model,
    runtime: detection.runtime,
    latencyMs: detection.latencyMs,
    wallMs: Math.round(performance.now() - started),
    timedOut: !!detection.timedOut,
    error: detection.error || "",
    detections: (detection.detections || []).length,
    diagnosticsKeys: Object.keys(detection.diagnostics || {}),
  };
})()
"@
      $localVision = Invoke-AppJs $session $localVisionScript
      $result.localVision = $localVision
      $localVisionPassed = (-not [bool]$localVision.timedOut) -and !$localVision.error
      Add-Check "local-vision-real-model" $localVisionPassed "runtime=$($localVision.runtime), detections=$($localVision.detections), latency=$($localVision.latencyMs)ms, wall=$($localVision.wallMs)ms, error='$($localVision.error)'"
    } else {
      $detail = "model not found: $ModelPath"
      Add-Check "local-vision-real-model" (-not $RequireLocalVision) $detail
    }
  } else {
    Add-Check "local-vision-real-model" (-not $RequireLocalVision) "skipped by -SkipLocalVision"
  }
} finally {
  Stop-ReleaseApp $session
  [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $previousWebViewArgs, "Process")
  [Environment]::SetEnvironmentVariable("JAVIS_QA_MODE", $previousQaMode, "Process")
}

$result.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
$result.checks = @($checks)
$json = $result | ConvertTo-Json -Depth 30
if ($json -match "data:image") {
  throw "QA result JSON unexpectedly contains an image data URL."
}
Write-Utf8NoBom $resultsPath $json

$failed = @($checks | Where-Object { -not $_.passed })
$reportDate = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
$reportLines = @(
  "# Computer Use Release QA",
  "",
  "Date: $reportDate",
  "",
  ('Executable: `{0}`' -f $exe),
  "",
  "Evidence:",
  "",
  '- App screenshot: `01-computer-use-release-app.png`',
  '- JSON output: `computer-use-release-qa-output.json`',
  "",
  "Checks:",
  ""
) + @($checks | ForEach-Object { Format-CheckLine $_ })

if ($failed.Count -gt 0) {
  $reportLines += @("", "Result: FAIL")
} else {
  $reportLines += @("", "Result: PASS")
}
Write-Utf8NoBom $reportPath ($reportLines -join "`n")

if ($failed.Count -gt 0) {
  throw "Computer Use release QA failed $($failed.Count) check(s). See $reportPath."
}

Write-Host "Computer Use release QA passed. Report: $reportPath"
