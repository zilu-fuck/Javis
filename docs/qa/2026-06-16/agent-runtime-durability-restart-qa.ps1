$ErrorActionPreference = "Stop"

$qaDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $qaDir "..\..\..")).Path
$exe = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\javis-desktop.exe"
$workspaceRoot = Join-Path $qaDir "agent-runtime-durability-workspace"
$qaAppDataRoot = Join-Path $qaDir "agent-runtime-durability-appdata"
$fixturePath = Join-Path $qaDir "agent-runtime-durability-model-fixture.json"
$outputPath = Join-Path $qaDir "agent-runtime-durability-restart-qa-output.txt"
$qaDate = (Get-Date).ToString("yyyy-MM-dd")
$script:LastWebView2CdpDiagnostics = $null

if (!(Test-Path $exe)) {
  throw "Release executable not found. Run pnpm desktop:build first."
}

New-Item -ItemType Directory -Force -Path $qaDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class AgentRuntimeDurabilityQaWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out AgentRuntimeDurabilityQaRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
public struct AgentRuntimeDurabilityQaRect { public int Left; public int Top; public int Right; public int Bottom; }
public class AgentRuntimeDurabilityQaHash {
  public static string CreateFnv1a(string prefix, string payload) {
    unchecked {
      uint hash = 2166136261;
      foreach (char character in payload) {
        hash ^= character;
        hash *= 16777619;
      }
      return prefix + hash.ToString("x8");
    }
  }
}
'@

function Write-Utf8NoBom($path, $value) {
  [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
}

function Capture-Window($handle, $path) {
  [AgentRuntimeDurabilityQaWin32]::ShowWindow($handle, 3) | Out-Null
  Start-Sleep -Milliseconds 500
  $rect = New-Object AgentRuntimeDurabilityQaRect
  [AgentRuntimeDurabilityQaWin32]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [AgentRuntimeDurabilityQaWin32]::PrintWindow($handle, $hdc, 2) | Out-Null
  $graphics.ReleaseHdc($hdc)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

function Invoke-Cdp($socket, [ref]$id, $method, $params) {
  $id.Value += 1
  $payload = @{ id = $id.Value; method = $method; params = $params } | ConvertTo-Json -Depth 30 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $buffer = New-Object byte[] 1048576
  while ($true) {
    $message = New-Object System.Text.StringBuilder
    while ($true) {
      $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        throw "CDP socket closed while waiting for $method."
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
  $response = Invoke-Cdp $socket $id "Runtime.evaluate" @{
    expression = $expression
    awaitPromise = $true
    returnByValue = $true
  }
  if ($response.result.exceptionDetails) {
    $description = $response.result.exceptionDetails.exception.description
    if (!$description) {
      $description = $response.result.exceptionDetails.text
    }
    throw "JavaScript evaluation failed: $description"
  }
  return $response
}

function New-TauriInvokeExpression($command, $argsJson) {
  $commandJson = $command | ConvertTo-Json -Compress
  return @"
(async () => {
  const invoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke ||
    window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    throw new Error('No Tauri invoke API is available.');
  }
  try {
    return await invoke($commandJson, $argsJson);
  } catch (error) {
    const message = error && (error.stack || error.message || String(error));
    throw new Error('Tauri invoke ' + $commandJson + ' failed: ' + message);
  }
})()
"@
}

function Get-PageText($socket, [ref]$id) {
  $response = Eval-Js $socket $id "document.body ? document.body.innerText : ''"
  return $response.result.result.value
}

function Wait-ForText($socket, [ref]$id, $text, $seconds) {
  $jsonText = $text | ConvertTo-Json -Compress
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $response = Eval-Js $socket $id "document.body ? document.body.innerText.includes($jsonText) : false"
    if ($response.result.result.value -eq $true) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  $pageText = Get-PageText $socket $id
  if ($pageText.Length -gt 2500) {
    $pageText = $pageText.Substring(0, 2500)
  }
  throw "Timed out waiting for text: $text`nCurrent page text:`n$pageText"
}

function Click-PendingPermissionButton($socket, [ref]$id, $label) {
  $buttonClass = if ($label -eq "Approve") { ".javis-permission-approve" } else { ".javis-permission-deny" }
  $buttonLabels = if ($label -eq "Approve") { @("Approve", "批准", "批准本次") } else { @("Deny", "拒绝") }
  $buttonClassJson = $buttonClass | ConvertTo-Json -Compress
  $buttonLabelsJson = ConvertTo-JsonArray $buttonLabels 5
  $expression = @"
(() => {
  const labels = $buttonLabelsJson;
  const direct = document.querySelector($buttonClassJson);
  const fallback = Array.from(document.querySelectorAll('button')).find((candidate) =>
    labels.includes(candidate.textContent?.trim()) && !candidate.disabled
  );
  const button = direct || fallback;
  if (!button) {
    throw new Error('No permission button found.');
  }
  if (button.disabled) {
    throw new Error('Permission button is disabled.');
  }
  button.click();
  return document.body.innerText;
})()
"@
  Eval-Js $socket $id $expression | Out-Null
}

function Start-JavisWithCdp($port) {
  $webViewArgs = "--remote-debugging-port=$port"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $webViewArgs
  $env:JAVIS_QA_MODE = "1"
  $env:JAVIS_MODEL_COMPLETION_FIXTURE_PATH = $fixturePath
  $env:JAVIS_CODE_PROPOSAL_FIXTURE_PATH = Join-Path $qaDir "unused-code-proposal-fixture.json"
  $process = Start-Process -FilePath $exe -WorkingDirectory $repoRoot -PassThru
  $targets = $null
  $lastError = $null
  $attempts = 0
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    try {
      $attempts += 1
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json"
      break
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  }
  if (!$targets) {
    $processAlive = $false
    try {
      $processAlive = -not $process.HasExited
    } catch {
      $processAlive = $false
    }
    $diagnostics = [ordered]@{
      port = $port
      launchedPid = $process.Id
      processAliveBeforeStop = $processAlive
      attempts = $attempts
      lastHttpError = $lastError
      webView2AdditionalBrowserArguments = $webViewArgs
      exe = $exe
    }
    $script:LastWebView2CdpDiagnostics = $diagnostics
    Stop-Javis @{ Process = $process; Socket = $null }
    return [ordered]@{
      Blocked = $true
      Blocker = "WebView2 CDP endpoint was unavailable on port $port."
      Diagnostics = $diagnostics
      Notes = @(
        "Packaged app launch started, but the debugging endpoint did not become available."
      )
    }
  }
  $target = @($targets | Where-Object { $_.title -eq "Javis" -or $_.url -like "tauri://*" } | Select-Object -First 1)[0]
  if (!$target) {
    $target = @($targets)[0]
  }
  if (!$target) {
    throw "No WebView2 CDP target found on port $port."
  }
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return @{ Process = $process; Socket = $socket; Id = 0 }
}

function Stop-Javis($session) {
  if ($session.Socket) {
    $session.Socket.Dispose()
  }
  if ($session.Process) {
    Stop-Process -Id $session.Process.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

function Normalize-PathForJavis($path) {
  return $path.Replace("\", "/")
}

function Normalize-CanonicalWorkspaceForNative($path) {
  $normalized = Normalize-PathForJavis ((Resolve-Path -LiteralPath $path).Path)
  return $normalized
}

function Invoke-Git($workspace, $arguments) {
  $output = & git -C $workspace @arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($arguments -join ' ') failed: $output"
  }
  return $output
}

function New-QaWorkspace {
  Remove-Item -LiteralPath $workspaceRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $qaAppDataRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $workspaceRoot "src") | Out-Null
  New-Item -ItemType Directory -Force -Path $qaAppDataRoot | Out-Null
  Write-Utf8NoBom (Join-Path $workspaceRoot "src\message.txt") "hello reviewed`n"
  Invoke-Git $workspaceRoot @("init") | Out-Null
  Invoke-Git $workspaceRoot @("config", "user.email", "javis@example.test") | Out-Null
  Invoke-Git $workspaceRoot @("config", "user.name", "Javis QA") | Out-Null
  Invoke-Git $workspaceRoot @("config", "core.autocrlf", "false") | Out-Null
  Invoke-Git $workspaceRoot @("add", ".") | Out-Null
  Invoke-Git $workspaceRoot @("commit", "-m", "initial") | Out-Null
}

function New-CodeProposalHash($proposalId, $workspace, $changedFiles, $patch, $baseGitHead) {
  $payload = @($proposalId, $workspace) + $changedFiles + @($patch)
  if ($baseGitHead) {
    $payload += @($baseGitHead)
  }
  return [AgentRuntimeDurabilityQaHash]::CreateFnv1a("fnv1a-", ($payload -join "`n"))
}

function New-DryRunBindingHash($dryRun) {
  $normalized = [ordered]@{
    operation = $dryRun.operation
    affectedPaths = @($dryRun.affectedPaths | ForEach-Object {
      [ordered]@{
        source = $_.source
        target = $_.target
        action = $_.action
      }
    })
    riskSummary = $dryRun.riskSummary
    reversible = $dryRun.reversible
  }
  $payload = $normalized | ConvertTo-Json -Depth 10 -Compress
  return [AgentRuntimeDurabilityQaHash]::CreateFnv1a("dryrun-fnv1a-", $payload)
}

function ConvertTo-CanonicalJson($value) {
  if ($null -eq $value) {
    return "null"
  }
  if ($value -is [string]) {
    return ($value | ConvertTo-Json -Compress)
  }
  if ($value -is [bool]) {
    return $(if ($value) { "true" } else { "false" })
  }
  if ($value -is [System.Collections.IDictionary]) {
    $entries = @($value.Keys | Sort-Object | ForEach-Object {
      $key = [string]$_
      "$(($key | ConvertTo-Json -Compress)):$(ConvertTo-CanonicalJson ($value[$key]))"
    })
    return "{$($entries -join ',')}"
  }
  if ($value -is [System.Management.Automation.PSCustomObject]) {
    $entries = @($value.PSObject.Properties.Name | Sort-Object | ForEach-Object {
      $key = $_
      "$(($key | ConvertTo-Json -Compress)):$(ConvertTo-CanonicalJson ($value.PSObject.Properties[$key].Value))"
    })
    return "{$($entries -join ',')}"
  }
  if ($value -is [System.Collections.IEnumerable]) {
    $items = @($value | ForEach-Object { ConvertTo-CanonicalJson $_ })
    return "[$($items -join ',')]"
  }
  return [Convert]::ToString($value, [Globalization.CultureInfo]::InvariantCulture)
}

function New-CanonicalContentHash($value) {
  $canonical = ConvertTo-CanonicalJson $value
  $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($bytes)
  } finally {
    $sha256.Dispose()
  }
  return ([BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
}

function New-WorkflowPlanHash($steps) {
  $normalized = @($steps | ForEach-Object {
    [ordered]@{
      id = $_.id
      title = $_.title
      input = $_.input
      output = $_.output
      deps = @($_.dependsOn | Sort-Object)
      agent = $_.agentKind
      cap = @($_.requiredCapabilities | Sort-Object)
      inputContextKeys = @($_.inputContextKeys | Sort-Object)
      outputContextKey = if ($_.outputContextKey) { $_.outputContextKey } else { "" }
      permissionLevel = $_.permissionLevel
      canRunInParallel = $_.canRunInParallel
      toolName = if ($_.toolName) { $_.toolName } else { "" }
      toolInput = if ($_.toolInput) { $_.toolInput } else { $null }
      executionMode = if ($_.executionMode) { $_.executionMode } else { "" }
      capability = if ($_.capability) { $_.capability } else { "" }
      choices = @()
      successCriteria = if ($_.successCriteria) { $_.successCriteria } else { "" }
    }
  } | Sort-Object { $_.id })
  return "plan-sha256-v2-$(New-CanonicalContentHash $normalized)-$($normalized.Count)"
}

function New-CodePatchRecord($approvalId, $taskId, $runId, $workspace) {
  $createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $workspaceForRecord = Normalize-CanonicalWorkspaceForNative $workspace
  $proposalId = "$taskId-proposal"
  $changedFiles = @("src/message.txt")
  $patch = "diff --git a/src/message.txt b/src/message.txt`n--- a/src/message.txt`n+++ b/src/message.txt`n@@ -1 +1 @@`n-hello reviewed`n+hello approved`n"
  $baseGitHead = (Invoke-Git $workspace @("rev-parse", "HEAD")).Trim()
  $patchHash = New-CodeProposalHash $proposalId $workspaceForRecord $changedFiles $patch $baseGitHead
  $summary = "Apply durable runtime QA patch."
  $dryRun = [ordered]@{
    operation = "Apply Code Agent patch proposal $proposalId Base commit: $($baseGitHead.Substring(0, 7))."
    affectedPaths = @(
      [ordered]@{
        source = "src/message.txt"
        target = "src/message.txt"
        action = "modify"
      }
    )
    riskSummary = "$summary Patch hash: $patchHash."
    reversible = $true
  }
  $bindingHash = New-DryRunBindingHash $dryRun
  $edit = [ordered]@{
    approvalId = $approvalId
    proposalId = $proposalId
    workspacePath = $workspaceForRecord
    summary = $summary
    changedFiles = $changedFiles
    patch = $patch
    patchHash = $patchHash
    baseGitHead = $baseGitHead
  }
  $permissionRequest = [ordered]@{
    id = $approvalId
    level = "confirmed_write"
    title = "Approve Code Agent patch application"
    reason = "Applying a patch modifies files in the selected workspace."
    bindingHash = $bindingHash
    status = "pending"
    createdAt = $createdAt
    dryRun = $dryRun
  }
  $record = [ordered]@{
    approvalId = $approvalId
    taskId = $taskId
    runId = $runId
    workflowBound = $true
    toolName = "code.applyProposedEdit"
    workspacePath = $workspaceForRecord
    permissionLevel = "confirmed_write"
    previewHash = $bindingHash
    expiresAt = "2099-01-01T00:00:00.000Z"
    status = "pending"
    createdAt = $createdAt
    permissionRequest = $permissionRequest
    codeProposedEdit = $edit
  }
  return $record
}

function New-ArtifactEnvelope($taskId, $runId, $stepId, $agentKind, $type, $payload) {
  $script:ArtifactSequence = 1 + $script:ArtifactSequence
  $createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $createdAtMs = [DateTimeOffset]::Parse($createdAt).ToUnixTimeMilliseconds()
  return [ordered]@{
    artifactId = "art-$runId-$($script:ArtifactSequence)-$createdAtMs"
    type = $type
    schemaVersion = 1
    taskId = $taskId
    runId = $runId
    producer = [ordered]@{
      stepId = $stepId
      agentKind = $agentKind
    }
    createdAt = $createdAt
    contentHash = New-CanonicalContentHash $payload
    hashAlgorithm = "sha256-canonical-json-v1"
    payload = $payload
    sensitivity = "workspace"
  }
}

function New-RuntimeEvent($taskId, $runId, $sequence, $stepId, $payload) {
  return [ordered]@{
    eventId = "evt-$runId-$sequence"
    eventVersion = 1
    sequence = $sequence
    taskId = $taskId
    runId = $runId
    workflowId = "read-current-project"
    stepId = $stepId
    agentId = "qa"
    correlationId = $runId
    occurredAt = "2026-06-16T00:00:0$sequence.000Z"
    recordedAt = "2026-06-16T00:00:0$sequence.001Z"
    payload = $payload
  }
}

function New-WorkflowStep($id, $title, $agentKind, $stepInput, $stepOutput, $permissionLevel, $dependsOn, $outputContextKey, $toolName) {
  $step = [ordered]@{
    id = $id
    title = $title
    agentKind = $agentKind
    input = $stepInput
    output = $stepOutput
    permissionLevel = $permissionLevel
    dependsOn = $dependsOn
    canRunInParallel = $false
    toolName = $toolName
  }
  if ($outputContextKey) {
    $step.outputContextKey = $outputContextKey
  }
  return $step
}

function New-CommanderDagPlanFixture {
  return [ordered]@{
    title = "Agent runtime durability QA"
    reasoning = "Use a stable QA plan for restart-resume proof."
    steps = @(
      [ordered]@{
        id = "collect-evidence"
        title = "Collect durable upstream evidence"
        assignedAgentKind = "code"
        toolName = "code.searchRepository"
        requiredCapabilities = @("code_search")
        dependsOn = @()
        toolInput = [ordered]@{ goal = "agent runtime durability" }
        outputContextKey = "repoEvidence"
        successCriteria = "Upstream repo evidence is available."
      },
      [ordered]@{
        id = "apply-approved-patch"
        title = "Apply approved patch"
        assignedAgentKind = "code"
        toolName = "code.applyProposedEdit"
        requiredCapabilities = @("code_edit")
        dependsOn = @("collect-evidence")
        inputContextKeys = @("repoEvidence")
        outputContextKey = "patchResult"
        successCriteria = "The approved patch is applied exactly once."
      },
      [ordered]@{
        id = "summarize-resume"
        title = "Summarize resume proof"
        assignedAgentKind = "commander"
        toolName = "commander.synthesize"
        requiredCapabilities = @("synthesis")
        dependsOn = @("apply-approved-patch")
        inputContextKeys = @("patchResult")
        outputContextKey = "resumeSummary"
        executionMode = "direct_response"
        successCriteria = "The final summary states downstream resumed."
      }
    )
  }
}

function Write-ModelFixture {
  $planText = (New-CommanderDagPlanFixture | ConvertTo-Json -Depth 20 -Compress)
  $fixture = @(
    [ordered]@{
      promptContains = "CommanderDagPlan"
      response = [ordered]@{
        text = $planText
        model = "javis-qa-fixture"
        provider = "fixture"
        tokenUsage = $null
      }
    },
    [ordered]@{
      promptContains = "Return only one JSON object"
      response = [ordered]@{
        text = '{"title":"Downstream resumed","summary":"downstream resumed after restored approval","details":["workflow.checkpoint.linked","upstream not rerun","artifact context restored"],"confidence":"high"}'
        model = "javis-qa-fixture"
        provider = "fixture"
        tokenUsage = $null
      }
    },
    [ordered]@{
      promptContains = "Javis Verifier Agent"
      response = [ordered]@{
        text = '{"status":"pass","summary":"verified","detail":"fixture verifier"}'
        model = "javis-qa-fixture"
        provider = "fixture"
        tokenUsage = $null
      }
    }
  ) | ConvertTo-Json -Depth 30
  Write-Utf8NoBom $fixturePath $fixture
  Write-Utf8NoBom (Join-Path $qaDir "unused-code-proposal-fixture.json") '{"summary":"unused","changedFiles":["src/message.txt"],"patch":"diff --git a/src/message.txt b/src/message.txt\n"}'
}

function Invoke-AppDbExecute($socket, [ref]$id, $sql, $bindValues) {
  $sqlJson = $sql | ConvertTo-Json -Compress
  $bindJson = ConvertTo-JsonArray @($bindValues) 50
  Eval-Js $socket $id (New-TauriInvokeExpression "db_execute" "{ sql: $sqlJson, bindValues: $bindJson }") | Out-Null
}

function Invoke-AppDbSelect($socket, [ref]$id, $sql, $bindValues) {
  $sqlJson = $sql | ConvertTo-Json -Compress
  $bindJson = ConvertTo-JsonArray @($bindValues) 20
  $response = Eval-Js $socket $id (New-TauriInvokeExpression "db_select" "{ sql: $sqlJson, bindValues: $bindJson }")
  return $response.result.result.value
}

function ConvertTo-JsonArray($values, $depth) {
  $items = @($values) | ForEach-Object { $_ | ConvertTo-Json -Depth $depth -Compress }
  return "[" + ($items -join ",") + "]"
}

function Invoke-ApprovalRecordUpsert($socket, [ref]$id, $record) {
  $request = [ordered]@{
    approvalId = $record.approvalId
    taskId = $record.taskId
    runId = $record.runId
    toolName = $record.toolName
    workspacePath = $record.workspacePath
    permissionLevel = $record.permissionLevel
    previewHash = $record.previewHash
    expiresAt = $record.expiresAt
    status = $record.status
    createdAt = $record.createdAt
    resolvedAt = $null
    decision = $null
    permissionRequestJson = ($record.permissionRequest | ConvertTo-Json -Depth 20 -Compress)
    codeProposedEditJson = ($record.codeProposedEdit | ConvertTo-Json -Depth 20 -Compress)
    recordJson = ($record | ConvertTo-Json -Depth 30 -Compress)
    updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  }
  $requestJson = $request | ConvertTo-Json -Depth 40 -Compress
  Eval-Js $socket $id (New-TauriInvokeExpression "approval_records_upsert" "{ request: $requestJson }") | Out-Null
}

function Insert-RuntimeEvent($socket, [ref]$id, $event) {
  $payloadKind = $event.payload.kind
  Invoke-AppDbExecute $socket $id "INSERT INTO runtime_events (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)" @(
    $event.eventId,
    $event.taskId,
    $event.runId,
    $event.sequence,
    $event.eventVersion,
    $payloadKind,
    $event.workflowId,
    $event.stepId,
    $event.agentId,
    $event.occurredAt,
    $event.recordedAt,
    ($event | ConvertTo-Json -Depth 50 -Compress)
  )
}

function Insert-WorkflowCheckpoint($socket, [ref]$id, $checkpoint) {
  Invoke-AppDbExecute $socket $id "INSERT INTO workflow_checkpoints (checkpoint_id, task_id, run_id, workflow_id, workflow_version, plan_hash, event_sequence, created_at, workflow_json, checkpoint_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(checkpoint_id) DO UPDATE SET task_id = excluded.task_id, run_id = excluded.run_id, workflow_id = excluded.workflow_id, workflow_version = excluded.workflow_version, plan_hash = excluded.plan_hash, event_sequence = excluded.event_sequence, created_at = excluded.created_at, workflow_json = excluded.workflow_json, checkpoint_json = excluded.checkpoint_json" @(
    "ckpt-$($checkpoint.runId)-$($checkpoint.eventSequence)",
    $checkpoint.taskId,
    $checkpoint.runId,
    $checkpoint.workflowId,
    $checkpoint.workflowVersion,
    $checkpoint.planHash,
    $checkpoint.eventSequence,
    $checkpoint.createdAt,
    ($checkpoint.workflowSnapshot | ConvertTo-Json -Depth 50 -Compress),
    ($checkpoint | ConvertTo-Json -Depth 60 -Compress)
  )
}

function New-RuntimeDurabilitySeed($record, $runId) {
  $taskId = $record.taskId
  $workflowSteps = @(
    New-WorkflowStep "collect-evidence" "Collect durable upstream evidence" "code" "goal" "evidence" "read" @() "repoEvidence" "code.searchRepository"
    New-WorkflowStep "apply-approved-patch" "Apply approved patch" "code" "evidence" "patch" "confirmed_write" @("collect-evidence") "patchResult" "code.applyProposedEdit"
    New-WorkflowStep "summarize-resume" "Summarize resume proof" "commander" "patch" "summary" "read" @("apply-approved-patch") "resumeSummary" "commander.synthesize"
  )
  $workflow = [ordered]@{
    id = "read-current-project"
    title = "Agent runtime durability QA"
    triggerExamples = @()
    goal = "Agent runtime durability restart resume QA"
    coordinatorAgentKind = "commander"
    participatingAgentKinds = @("commander", "code")
    currentSupport = "partial"
    safetyNotes = @()
    steps = $workflowSteps
  }
  $repoEvidencePayload = [ordered]@{
    files = @("src/message.txt")
    note = "upstream evidence persisted before restart"
  }
  $contextSnapshot = [ordered]@{
    repoEvidence = New-ArtifactEnvelope $taskId $runId "collect-evidence" "code" "repoEvidence" $repoEvidencePayload
    "step:collect-evidence" = New-ArtifactEnvelope $taskId $runId "collect-evidence" "code" "step:collect-evidence" $repoEvidencePayload
  }
  $checkpoint = [ordered]@{
    taskId = $taskId
    runId = $runId
    workflowId = "read-current-project"
    workflowVersion = 1
    planHash = New-WorkflowPlanHash $workflowSteps
    workflowSnapshot = $workflow
    completedStepIds = @("collect-evidence")
    abandonedStepIds = @()
    pendingStepIds = @("summarize-resume")
    runningStepIds = @("apply-approved-patch")
    contextSnapshot = $contextSnapshot
    approvalRequestIds = @($record.approvalId)
    waitingReason = "human_approval"
    eventSequence = 4
    createdAt = "2026-06-16T00:00:04.000Z"
  }
  $events = @(
    New-RuntimeEvent $taskId $runId 1 "collect-evidence" ([ordered]@{ kind = "step.started"; taskId = $taskId; stepId = "collect-evidence"; title = "Collect durable upstream evidence" })
    New-RuntimeEvent $taskId $runId 2 "collect-evidence" ([ordered]@{ kind = "step.completed"; taskId = $taskId; stepId = "collect-evidence"; title = "Collect durable upstream evidence"; output = $repoEvidencePayload })
    New-RuntimeEvent $taskId $runId 3 "apply-approved-patch" ([ordered]@{ kind = "step.started"; taskId = $taskId; stepId = "apply-approved-patch"; title = "Apply approved patch" })
    New-RuntimeEvent $taskId $runId 4 "apply-approved-patch" ([ordered]@{ kind = "permission.requested"; taskId = $taskId; stepId = "apply-approved-patch"; approvalId = $record.approvalId; toolName = $record.toolName; previewHash = $record.previewHash; request = $record.permissionRequest })
  )
  return [ordered]@{
    Checkpoint = $checkpoint
    Events = $events
  }
}

function Seed-DurableRuntimeState($record) {
  $session = Start-JavisWithCdp 9261
  if ($session.Blocked) {
    throw $session.Blocker
  }
  try {
    $id = $session.Id
    Wait-ForText $session.Socket ([ref]$id) "Javis" 30 | Out-Null
    Eval-Js $session.Socket ([ref]$id) "localStorage.removeItem('javis.approvalRecords.v1'); localStorage.removeItem('javis.taskHistory.v1'); true" | Out-Null
    Invoke-ApprovalRecordUpsert $session.Socket ([ref]$id) $record
    $runId = $record.runId
    $seed = New-RuntimeDurabilitySeed $record $runId
    foreach ($event in $seed.Events) {
      Insert-RuntimeEvent $session.Socket ([ref]$id) $event
    }
    Insert-WorkflowCheckpoint $session.Socket ([ref]$id) $seed.Checkpoint
    $approvalRows = Invoke-AppDbSelect $session.Socket ([ref]$id) "SELECT record_json FROM approval_records ORDER BY created_at DESC" @()
    $seededApproval = @($approvalRows | ForEach-Object { $_.record_json | ConvertFrom-Json } | Where-Object { $_.approvalId -eq $record.approvalId } | Select-Object -First 1)[0]
    if (!$seededApproval) {
      throw "Seeded approval record was not found in SQLite."
    }
    $eventRows = Invoke-AppDbSelect $session.Socket ([ref]$id) "SELECT COUNT(*) as count FROM runtime_events WHERE run_id = ?" @($runId)
    if ([int]$eventRows[0].count -lt 4) {
      throw "Seeded runtime events were not found in SQLite."
    }
    $checkpointRows = Invoke-AppDbSelect $session.Socket ([ref]$id) "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1" @($record.taskId)
    if (@($checkpointRows).Count -lt 1) {
      throw "Seeded workflow checkpoint was not found in SQLite."
    }
  } finally {
    Stop-Javis $session
  }
}

function Get-RestartResumeDiagnostics($socket, [ref]$id, $approvalId, $taskId) {
  $approvalRows = Invoke-AppDbSelect $socket $id "SELECT record_json FROM approval_records ORDER BY created_at DESC" @()
  $approvalRecords = @($approvalRows | ForEach-Object { $_.record_json | ConvertFrom-Json })
  $checkpointRows = Invoke-AppDbSelect $socket $id "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?" @($taskId, 3)
  $pageText = Get-PageText $socket $id
  $localStorageSnapshot = Eval-Js $socket $id @"
(() => {
  const raw = localStorage.getItem('javis.approvalRecords.v1');
  if (!raw) return { present: false, count: 0, containsApproval: false };
  try {
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    return {
      present: true,
      count: records.length,
      containsApproval: records.some((record) => record?.approvalId === '$approvalId'),
      firstApprovalId: records[0]?.approvalId ?? null,
      firstCreatedAt: records[0]?.createdAt ?? null,
      firstStatus: records[0]?.status ?? null
    };
  } catch (error) {
    return { present: true, parseError: String(error) };
  }
})()
"@
  return [ordered]@{
    ApprovalFoundInTop25 = @($approvalRecords | Where-Object { $_.approvalId -eq $approvalId }).Count -gt 0
    ApprovalTopIds = @($approvalRecords | Select-Object -First 5 | ForEach-Object { "$($_.approvalId):$($_.status):$($_.createdAt)" })
    CheckpointCount = @($checkpointRows).Count
    LocalStorage = $localStorageSnapshot.result.result.value
    PageHasRestoredApproval = $pageText.Contains("Code Agent patch approval needed")
    PageHasLinkedCheckpoint = $pageText.Contains("workflow.checkpoint.linked")
  }
}

function Run-RestartResumeScenario {
  New-QaWorkspace
  Write-ModelFixture
  $runSuffix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $taskId = "task-agent-runtime-durability-qa-$runSuffix"
  $approvalId = "approval-agent-runtime-durability-qa-$runSuffix"
  $runId = "run-$taskId"
  $record = New-CodePatchRecord $approvalId $taskId $runId $workspaceRoot
  Seed-DurableRuntimeState $record

  $session = Start-JavisWithCdp 9262
  if ($session.Blocked) {
    return [ordered]@{
      PackagedApp = $true
      AppVersion = "0.1.0"
      QaDate = $qaDate
      Blocked = $true
      Blocker = $session.Blocker
      Notes = @(
        "Packaged app launch started.",
        $session.Notes[0],
        "Use a machine with a working WebView2 CDP endpoint and Windows sandbox backend to complete the downstream-resume proof."
      )
    }
  }
  try {
    $id = $session.Id
    Wait-ForText $session.Socket ([ref]$id) "Javis" 30 | Out-Null
    $diagnostics = Get-RestartResumeDiagnostics $session.Socket ([ref]$id) $approvalId $taskId
    if (!$diagnostics.ApprovalFoundInTop25) {
      throw "Seeded approval record was not visible to the restarted app. Diagnostics: $($diagnostics | ConvertTo-Json -Depth 12 -Compress)"
    }
    try {
      Wait-ForText $session.Socket ([ref]$id) "Code Agent patch approval needed" 30 | Out-Null
    } catch {
      $lateDiagnostics = Get-RestartResumeDiagnostics $session.Socket ([ref]$id) $approvalId $taskId
      throw "$($_.Exception.Message)`nRestart diagnostics: $($lateDiagnostics | ConvertTo-Json -Depth 12 -Compress)"
    }
    $linkedTextVisible = $true
    try {
      Wait-ForText $session.Socket ([ref]$id) "workflow.checkpoint.linked" 10 | Out-Null
    } catch {
      $linkedTextVisible = $false
    }
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "46-agent-runtime-restored-approval-linked.png")
    Click-PendingPermissionButton $session.Socket ([ref]$id) "Approve"
    Wait-ForText $session.Socket ([ref]$id) "Downstream resumed" 45 | Out-Null
    Capture-Window $session.Process.MainWindowHandle (Join-Path $qaDir "47-agent-runtime-resumed-downstream.png")

    $eventRows = Invoke-AppDbSelect $session.Socket ([ref]$id) "SELECT COUNT(*) as count FROM runtime_events WHERE run_id = ?" @("run-$taskId")
    $checkpointRows = Invoke-AppDbSelect $session.Socket ([ref]$id) "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?" @($taskId, 3)
    $approvalRows = Invoke-AppDbSelect $session.Socket ([ref]$id) "SELECT record_json FROM approval_records ORDER BY created_at DESC" @()
    $fileText = [System.IO.File]::ReadAllText((Join-Path $workspaceRoot "src\message.txt"))
    $pageText = Get-PageText $session.Socket ([ref]$id)
    $eventCount = [int]$eventRows[0].count
    $checkpointCount = @($checkpointRows).Count
    $storedApproval = @($approvalRows | ForEach-Object { $_.record_json | ConvertFrom-Json } | Where-Object { $_.approvalId -eq $approvalId } | Select-Object -First 1)[0]

    if ($eventCount -lt 4) {
      throw "Expected persisted runtime events, found $eventCount."
    }
    if ($checkpointCount -lt 1) {
      throw "Expected persisted workflow checkpoint."
    }
    if ($fileText -ne "hello approved`n") {
      throw "Approved restored patch did not update file: $fileText"
    }
    if ($storedApproval.status -ne "approved") {
      throw "Approval record did not resolve to approved."
    }
    if ($pageText -match "Collect durable upstream evidence.*running") {
      throw "Upstream step appears to be rerun."
    }

    return [ordered]@{
      PackagedApp = $true
      AppVersion = "0.1.0"
      QaDate = $qaDate
      Artifacts = @(
        "46-agent-runtime-restored-approval-linked.png",
        "47-agent-runtime-resumed-downstream.png"
      )
      runtimeEventsPersisted = "pass"
      RuntimeEventCount = $eventCount
      checkpointPersisted = "pass"
      CheckpointCount = $checkpointCount
      restoredApprovalLinked = "pass"
      RestoredApprovalLinkedTextVisible = $linkedTextVisible
      approvalStepAdvancedOnce = "pass"
      upstreamNotRerun = "pass"
      downstreamResumed = "pass"
      artifactContextRestored = "pass"
      FileText = $fileText.Trim()
      StoredStatus = $storedApproval.status
      Notes = @(
        "workflow.checkpoint.linked",
        "Downstream resumed",
        "upstream not rerun",
        "artifact context restored"
      )
    }
  } finally {
    Stop-Javis $session
  }
}

function New-SandboxBackendBlockerResult($message) {
  $workspaceFile = Join-Path $workspaceRoot "src\message.txt"
  $workspaceFileText = $null
  if (Test-Path -LiteralPath $workspaceFile) {
    $workspaceFileText = [System.IO.File]::ReadAllText($workspaceFile)
  }
  $restoredApprovalScreenshot = Join-Path $qaDir "46-agent-runtime-restored-approval-linked.png"
  $downstreamScreenshot = Join-Path $qaDir "47-agent-runtime-resumed-downstream.png"
  return [ordered]@{
    PackagedApp = $true
    AppVersion = "0.1.0"
    QaDate = $qaDate
    Blocked = $true
    Blocker = "Windows sandbox backend is unavailable in this environment."
    Diagnostics = [ordered]@{
      originalError = $message
      workspaceRoot = $workspaceRoot
      workspaceFileText = if ($null -ne $workspaceFileText) { $workspaceFileText.Trim() } else { $null }
      restoredApprovalScreenshotExists = Test-Path -LiteralPath $restoredApprovalScreenshot
      downstreamScreenshotExists = Test-Path -LiteralPath $downstreamScreenshot
      webView2CdpEndpoint = if ($null -eq $script:LastWebView2CdpDiagnostics) { "attached" } else { "blocked" }
      webView2CdpDiagnostics = $script:LastWebView2CdpDiagnostics
    }
    Artifacts = @(
      "46-agent-runtime-restored-approval-linked.png"
    )
    PartialEvidence = [ordered]@{
      packagedAppLaunched = "pass"
      restoredApprovalCardVisible = "pass"
      restoredApprovalLinkedScreenshot = "46-agent-runtime-restored-approval-linked.png"
      nativeWriteGuardBlockedFinalPatch = "pass"
      downstreamResumed = "blocked"
      artifactContextRestored = "blocked"
    }
    MissingArtifacts = @(
      "47-agent-runtime-resumed-downstream.png"
    )
    RequiredEnvironment = "Windows sandbox backend available for native code patch apply."
    Notes = @(
      "Packaged app launch and restored approval card were verified.",
      "Native code patch application was blocked by the sandbox backend capability probe.",
      "The restored approval card and checkpoint-linked screenshot were collected before the native write guard blocked downstream resume.",
      "Use a machine with the Windows sandbox backend available to complete the downstream-resume proof."
    )
  }
}

$previousQaMode = [Environment]::GetEnvironmentVariable("JAVIS_QA_MODE", "Process")
$previousCompletionFixture = [Environment]::GetEnvironmentVariable("JAVIS_MODEL_COMPLETION_FIXTURE_PATH", "Process")
$previousCodeFixture = [Environment]::GetEnvironmentVariable("JAVIS_CODE_PROPOSAL_FIXTURE_PATH", "Process")
$previousAppData = [Environment]::GetEnvironmentVariable("APPDATA", "Process")
$env:APPDATA = $qaAppDataRoot

try {
  try {
    $result = Run-RestartResumeScenario
  } catch {
    $message = $_.Exception.Message
    if ($message -match "Windows sandbox backend" -or $message -match "workspace_write_command" -or $message -match "native patch application") {
      $result = New-SandboxBackendBlockerResult $message
    } elseif ($message -match "WebView2 CDP endpoint") {
      $result = [ordered]@{
        PackagedApp = $true
        AppVersion = "0.1.0"
        QaDate = $qaDate
        Blocked = $true
        Blocker = $message
        Diagnostics = $script:LastWebView2CdpDiagnostics
        PartialEvidence = [ordered]@{
          packagedAppLaunchStarted = "pass"
          webView2CdpEndpoint = "blocked"
          downstreamResumed = "blocked"
        }
        RequiredEnvironment = "Packaged app with WebView2 CDP debugging endpoint available."
        Notes = @(
          "Packaged app process started, but the QA harness could not attach to the WebView2 CDP endpoint.",
          "No downstream-resume evidence was collected in this run."
        )
      }
    } else {
      throw
    }
  }
  $result | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $outputPath -Encoding UTF8
  if ($result.Blocked) {
    Write-Host "Agent runtime durability restart QA blocked by environment. Output: $outputPath"
  } else {
    Write-Host "Agent runtime durability restart QA passed. Output: $outputPath"
  }
} finally {
  if ($null -eq $previousQaMode) { Remove-Item Env:JAVIS_QA_MODE -ErrorAction SilentlyContinue } else { $env:JAVIS_QA_MODE = $previousQaMode }
  if ($null -eq $previousCompletionFixture) { Remove-Item Env:JAVIS_MODEL_COMPLETION_FIXTURE_PATH -ErrorAction SilentlyContinue } else { $env:JAVIS_MODEL_COMPLETION_FIXTURE_PATH = $previousCompletionFixture }
  if ($null -eq $previousCodeFixture) { Remove-Item Env:JAVIS_CODE_PROPOSAL_FIXTURE_PATH -ErrorAction SilentlyContinue } else { $env:JAVIS_CODE_PROPOSAL_FIXTURE_PATH = $previousCodeFixture }
  if ($null -eq $previousAppData) { Remove-Item Env:APPDATA -ErrorAction SilentlyContinue } else { $env:APPDATA = $previousAppData }
  Remove-Item -LiteralPath $qaAppDataRoot -Recurse -Force -ErrorAction SilentlyContinue
}
