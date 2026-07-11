# QA Notes - 2026-06-16

## Agent Runtime Durability Restart-Resume

- Scope: packaged-app restart-resume evidence for `docs/AGENT_RUNTIME_DURABILITY_PLAN.md` P0.
- Runner: `agent-runtime-durability-restart-qa.ps1`.
- Output: `agent-runtime-durability-restart-qa-output.txt`.
- Verified: packaged app launched, WebView2 CDP attached, durable runtime state was seeded, and the restored Code Agent approval card appeared after restart.
- Evidence collected: `46-agent-runtime-restored-approval-linked.png`; `agent-runtime-durability-restart-qa-output.txt` records `webView2CdpEndpoint: attached`, `restoredApprovalScreenshotExists: true`, `workspaceFileText: hello reviewed`, and `downstreamScreenshotExists: false`.
- Blocked: the downstream approval execution path could not complete in this environment because the Windows sandbox backend was unavailable, so the restored patch did not update `src/message.txt` and `47-agent-runtime-resumed-downstream.png` was not produced.
- Remaining proof: rerun the packaged QA on a machine with the Windows sandbox backend available and collect `47-agent-runtime-resumed-downstream.png`.

Source-level coverage for the same slice is recorded in `agent-runtime-durability-source-qa.md`, including `pnpm check` passing.
