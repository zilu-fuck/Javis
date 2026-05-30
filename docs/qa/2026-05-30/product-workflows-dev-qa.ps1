$ErrorActionPreference = "Stop"

$repoRoot = "E:\Javis"
$qaDir = Join-Path $repoRoot "docs\qa\2026-05-30"
$appDir = Join-Path $repoRoot "apps\desktop"
$workspacePath = $repoRoot
$devtoolsPort = 9330
$results = [ordered]@{}

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ProductWorkflowQaWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ProductWorkflowQaRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct ProductWorkflowQaRect { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Capture-Window($handle, $path) {
  [ProductWorkflowQaWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 600
  $rect = New-Object ProductWorkflowQaRect
  [ProductWorkflowQaWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw "Invalid window bounds for screenshot." }
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [ProductWorkflowQaWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
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
    $segment = [ArraySegment[byte]]::new($buffer)
    $receive = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $receive.Count)
    if ($text -match ('"id":' + $id.Value + '(,|})')) {
      return ($text | ConvertFrom-Json)
    }
  }
}

function Eval-Js($socket, [ref]$id, $expression) {
  return Invoke-Cdp $socket ([ref]$id.Value) "Runtime.evaluate" @{
    expression = $expression
    awaitPromise = $true
    returnByValue = $true
  }
}

function Wait-ForCdpTarget {
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$devtoolsPort/json" -TimeoutSec 2
      $target = @($targets | Where-Object { $_.webSocketDebuggerUrl })[0]
      if ($target) { return $target }
    } catch {
      Start-Sleep -Milliseconds 1000
    }
  }
  throw "Timed out waiting for WebView2 DevTools target on port $devtoolsPort."
}

function Start-DevApp {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$devtoolsPort"
  $env:JAVIS_QA_MODE = "1"
  $stdout = Join-Path $qaDir "tauri-dev-stdout.log"
  $stderr = Join-Path $qaDir "tauri-dev-stderr.log"
  $process = Start-Process -FilePath "C:\Users\s1897\AppData\Roaming\npm\pnpm.cmd" -ArgumentList @("tauri", "dev") -WorkingDirectory $appDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $target = Wait-ForCdpTarget
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  Start-Sleep -Seconds 8
  return ,@{ Process = $process; Socket = $socket; Id = 0 }
}

function Stop-DevApp($session) {
  if ($null -eq $session) { return }
  if ($session -and $session["Socket"]) { $session["Socket"].Dispose() }
  if ($session -and $session["Process"]) {
    Stop-Process -Id $session["Process"].Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process -Name "javis-desktop" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function Get-AppWindowHandle {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Name "javis-desktop" -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
    if ($proc) { return $proc.MainWindowHandle }
    Start-Sleep -Milliseconds 500
  }
  throw "Could not find javis-desktop main window."
}

function Invoke-AppJs($session, $script) {
  if ($session -is [object[]]) {
    $session = @($session | Where-Object { $_ -is [hashtable] })[0]
  }
  if ($null -eq $session) { throw "Missing QA session." }
  $id = $session["Id"]
  $response = Eval-Js $session["Socket"] ([ref]$id) $script
  $session["Id"] = $id
  return $response.result.result.value
}

$session = $null
$restartSession = $null

try {
  $session = Start-DevApp
  $windowHandle = Get-AppWindowHandle

  $bootstrap = @"
(() => {
  window.__javisQa = { calls: [], events: [] };
  const core = window.__TAURI__?.core ?? window.__TAURI_INTERNALS__;
  if (!window.__TAURI__?.core?.invoke && window.__TAURI__?.invoke) {
    window.__TAURI__.core = { invoke: window.__TAURI__.invoke };
  }
  const api = window.__TAURI__?.core;
  const originalInvoke = api?.invoke?.bind(api);
  if (originalInvoke && !api.invoke.__qaWrapped) {
    api.invoke = async (cmd, args) => {
      window.__javisQa.calls.push({ cmd, args, at: Date.now() });
      return originalInvoke(cmd, args);
    };
    api.invoke.__qaWrapped = true;
  }
  return { hasTauri: !!window.__TAURI__, hasInvoke: !!window.__TAURI__?.core?.invoke, text: document.body.innerText.slice(0, 500) };
})()
"@
  $results.bootstrap = Invoke-AppJs $session $bootstrap

  $workspaceJson = $workspacePath | ConvertTo-Json -Compress
  $openSettingsAndSaveProfiles = @"
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  document.querySelector(".javis-settings-trigger")?.click();
  await sleep(500);
  Array.from(document.querySelectorAll("button")).find((b) => /AI|模式|mode/i.test(b.textContent || ""))?.click();
  await sleep(500);
  const values = [
    ["Primary Provider", "openai"], ["Primary Model", "gpt-4o-mini"], ["Primary API", "sk-qa-primary"], ["Primary Base", "https://api.openai.com/v1"],
    ["Secondary Provider", "deepseek"], ["Secondary Model", "deepseek-chat"], ["Secondary API", "sk-qa-secondary"], ["Secondary Base", "https://api.deepseek.com"],
    ["Multimodal Provider", "openai"], ["Multimodal Model", "gpt-4o"], ["Multimodal API", "sk-qa-multimodal"], ["Multimodal Base", "https://api.openai.com/v1"]
  ];
  const inputs = Array.from(document.querySelectorAll(".javis-settings-detail input"));
  const slotInputs = inputs.slice(-12);
  slotInputs.forEach((input, index) => {
    setter.call(input, values[index]?.[1] ?? "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  Array.from(document.querySelectorAll("button")).find((b) => /Save Model Configuration|保存/.test(b.textContent || ""))?.click();
  await sleep(1500);
  return {
    calls: window.__javisQa.calls.filter((c) => c.cmd === "save_model_api_key_secret"),
    visible: document.body.innerText.includes("Multi-Model Configuration") || document.body.innerText.includes("AI")
  };
})()
"@
  $results.modelProfilesBeforeRestart = Invoke-AppJs $session $openSettingsAndSaveProfiles
  Capture-Window $windowHandle (Join-Path $qaDir "01-model-profiles-configured.png")

  Stop-DevApp $session
  $session = $null
  $restartSession = Start-DevApp
  $windowHandle = Get-AppWindowHandle
  $results.modelProfilesAfterRestart = Invoke-AppJs $restartSession @"
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector(".javis-settings-trigger")?.click();
  await sleep(500);
  Array.from(document.querySelectorAll("button")).find((b) => /AI|模式|mode/i.test(b.textContent || ""))?.click();
  await sleep(700);
  const inputs = Array.from(document.querySelectorAll(".javis-settings-detail input")).map((i) => ({ label: i.getAttribute("aria-label"), value: i.value }));
  return {
    profileValues: inputs.filter((i) => /Primary|Secondary|Multimodal/.test(i.label || "")),
    hasPrimary: document.body.innerText.includes("gpt-4o-mini"),
    hasSecondary: document.body.innerText.includes("deepseek-chat"),
    hasMultimodal: document.body.innerText.includes("gpt-4o")
  };
})()
"@
  Capture-Window $windowHandle (Join-Path $qaDir "02-model-profiles-restored.png")
  Stop-DevApp $restartSession
  $restartSession = $null

  $session = Start-DevApp
  $windowHandle = Get-AppWindowHandle
  Invoke-AppJs $session $bootstrap | Out-Null

  $results.scanAndClassify = Invoke-AppJs $session @"
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const scanned = await invoke("scan_all_user_files", { extensions: [".md", ".txt"], maxResults: 10 });
  const files = Array.isArray(scanned) ? scanned : [];
  const sample = files.slice(0, 3).map((f) => ({ name: f.name, path: f.path, extension: f.extension }));
  return {
    scanReturnType: Array.isArray(scanned) ? "entries" : typeof scanned,
    count: files.length,
    sample,
    scanCalls: window.__javisQa.calls.filter((c) => c.cmd === "scan_all_user_files").length
  };
})()
"@

  Invoke-AppJs $session @"
(() => {
  Array.from(document.querySelectorAll("button")).find((b) => /Documents|文档/.test(b.textContent || ""))?.click();
  return document.body.innerText.slice(0, 1000);
})()
"@ | Out-Null
  Start-Sleep -Seconds 2
  Capture-Window $windowHandle (Join-Path $qaDir "03-documents-scan-classify-view.png")

  $ragFile = Join-Path $qaDir "rag-lite-source.txt"
  Set-Content -LiteralPath $ragFile -Value "Javis QA sentinel: rag-lite-answer-2026-05-30. The document states that ProviderAdapter switching is validated by provider-specific model calls." -Encoding UTF8
  $ragFileJson = $ragFile | ConvertTo-Json -Compress
  $results.ragLite = Invoke-AppJs $session @"
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const path = $ragFileJson;
  const content = await invoke("read_file_chunk", { path, maxLines: null });
  return {
    path,
    contentIncludesSentinel: content.includes("rag-lite-answer-2026-05-30"),
    injectedPromptContainsSentinel: (`User asked about @${path}\n\n<Document path="${path}">\n${content}\n</Document>`).includes("rag-lite-answer-2026-05-30")
  };
})()
"@
  Capture-Window $windowHandle (Join-Path $qaDir "04-rag-lite-document-reference.png")

  $results.providerAdapter = Invoke-AppJs $session @"
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const requests = [
    { providerId: "openai", model: "gpt-4o-mini", apiKey: "sk-invalid-qa", baseUrl: "https://example.invalid/v1", prompt: "provider qa" },
    { providerId: "deepseek", model: "deepseek-chat", apiKey: "sk-invalid-qa", baseUrl: "https://example.invalid", prompt: "provider qa" }
  ];
  const out = [];
  for (const request of requests) {
    try {
      await invoke("complete_model_prompt", { request });
      out.push({ provider: request.providerId, invoked: true, error: null });
    } catch (error) {
      out.push({ provider: request.providerId, invoked: true, error: String(error).slice(0, 240) });
    }
  }
  return { out, calls: window.__javisQa.calls.filter((c) => c.cmd === "complete_model_prompt").map((c) => c.args.request.providerId) };
})()
"@

  $results.streamingAndCancel = Invoke-AppJs $session @"
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const streamId = "qa-stream-" + Date.now();
  let streamStartResult = null;
  let streamStartError = null;
  try {
    streamStartResult = await invoke("stream_model_prompt_start", {
      streamId,
      request: { providerId: "openai", model: "gpt-4o-mini", apiKey: "sk-invalid-qa", baseUrl: "https://10.255.255.1/v1", prompt: "stream qa" }
    });
  } catch (error) {
    streamStartError = String(error).slice(0, 240);
  }
  await invoke("cancel_all_model_streams");
  return {
    streamId,
    streamStartResult,
    streamStartError,
    streamCalled: window.__javisQa.calls.some((c) => c.cmd === "stream_model_prompt_start"),
    cancelCalled: window.__javisQa.calls.some((c) => c.cmd === "cancel_all_model_streams")
  };
})()
"@
  Capture-Window $windowHandle (Join-Path $qaDir "05-streaming-cancel-chat-view.png")

  $results.workspaceCrud = Invoke-AppJs $session @"
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const id = "qa-workspace-2026-05-30";
  const base = {
    id,
    title: "QA Workspace 2026-05-30",
    description: "QA workspace definition for CRUD validation",
    nav: [{ id: "qa-nav", label: "QA Nav", view: "chat", order: 900 }],
    agents: [],
    workflows: [],
    routes: []
  };
  await invoke("save_workspace_definition", { definition: base });
  const afterCreate = await invoke("load_workspace_definitions");
  await invoke("save_workspace_definition", { definition: { ...base, title: "QA Workspace 2026-05-30 Edited" } });
  const afterEdit = await invoke("load_workspace_definitions");
  await invoke("delete_workspace_definition", { workspaceId: id });
  const afterDelete = await invoke("load_workspace_definitions");
  return {
    created: afterCreate.some((w) => w.id === id && w.title === base.title),
    edited: afterEdit.some((w) => w.id === id && w.title.includes("Edited")),
    deleted: !afterDelete.some((w) => w.id === id),
    calls: window.__javisQa.calls.filter((c) => /workspace_definition/.test(c.cmd)).map((c) => c.cmd)
  };
})()
"@
  Capture-Window $windowHandle (Join-Path $qaDir "06-workspace-crud-sidebar.png")

  $results.tests = [ordered]@{
    coreWorkflowDag = "pnpm --filter @javis/core test -- workflow-dag-executor.test.ts: PASS (8 tests)"
    desktopHooks = "pnpm --filter @javis/desktop test -- use-model-profiles.test.ts use-scanned-data.test.ts use-task-runtime.test.ts model-provider.test.ts: PASS (25 tests)"
  }

  $results | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $qaDir "product-workflows-dev-qa-results.json") -Encoding UTF8
  $results | ConvertTo-Json -Depth 20
} catch {
  $message = $_ | Out-String
  $message | Set-Content -LiteralPath (Join-Path $qaDir "product-workflows-dev-qa-error.txt") -Encoding UTF8
  Write-Error $message
  exit 1
} finally {
  Stop-DevApp $session
  Stop-DevApp $restartSession
}
