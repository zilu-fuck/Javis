# Product Workflow QA

This is the complete-product QA layer above the historical MVP scenarios. MVP
QA proves the workbench, basic routing, and first confirmed-write flow. Product
workflow QA proves that a packaged desktop user can connect a real workspace,
run research and coding tasks, approve risky writes, recover after restart, and
ship or roll back a build with evidence.

## Assumptions

- Product workflow QA is run against the packaged Tauri app after
  `pnpm --filter @javis/desktop tauri build`.
- Fixture-backed QA is valid for deterministic permission and patch safety, but
  live provider QA is still required before a Code Agent path is product-ready.
- Screenshots and command outputs must live under `docs/qa/YYYY-MM-DD/`.
- Development inventory can span multiple dated folders. Strict release
  readiness must target one dated evidence folder with its own `notes.md`.

## Verification Gate

Run the strict product evidence gate before calling a build product-ready:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/qa/check-product-workflow-evidence.ps1 -QaRoot docs/qa/YYYY-MM-DD
```

During development, use `-AllowKnownBlockers` to inventory current coverage
without pretending unresolved product blockers are release-ready:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/qa/check-product-workflow-evidence.ps1 -AllowKnownBlockers
```

## Required Workflow Matrix

| Workflow | Product QA objective | Required evidence |
| --- | --- | --- |
| MVP baseline | The historical read-only and first approval scenarios still work. | Idle workbench, Markdown scan, project inspection, URL research, PDF approval, PDF denial, and a failed verification screenshot. |
| Search-backed research | Search providers produce excerpt-backed reports, provider metadata stays visible, and weak/no-result/fetch-failure paths fail clearly. | `research-search-qa.ps1` screenshots for `github-cli`, Agent Chrome fallback, weak evidence, failed fetch, and no results; live smoke screenshots for `github-cli` and Agent Chrome. |
| Workspace management | A user can select a project, complete a workspace-aware task, restart the packaged app, and see the workspace restored. | `workspace-restart-qa.ps1` screenshots and output. |
| Code Agent fixture safety | Code Agent shows a diff/proposal before writes, deny leaves files unchanged, approve applies only the proposal, and verification runs. | `code-agent-opencode-qa.ps1` fixture deny/apply screenshots and output. |
| Code Agent live provider | A real configured provider produces a parseable proposal, Javis stops for confirmed-write approval, approve applies only the proposed patch, and post-apply verification runs. | Live provider pass notes, provider/model status without API keys, live proposal screenshot, approved apply screenshot, and output showing verification. |
| Durable PDF approval | Pending PDF approval restores after restart; approve, deny, and expiry resolve safely. | `pdf-durable-approval-qa.ps1` screenshots and output. |
| Durable Code Patch approval | Pending Code Patch approval restores after restart; approve/apply, deny, and expiry resolve safely. | `code-patch-durable-approval-qa.ps1` screenshots and output. |
| Task history persistence | Completed, failed, and cancelled tasks can be restored and deleted after restart without losing the selected workspace. | Restart screenshots and output showing restore and delete states. |
| Model settings and secret handling | Provider settings persist by reference, secrets are not written to localStorage, logs, screenshots, or notes. | Model settings restart evidence, secret-reference output, and `model-secret-redaction-qa-output.txt` or `secret-scan-output.txt` showing no API key findings. |
| Error recovery | Failed product workflows show actionable recovery text and do not perform partial writes. | Failure screenshots for research, Code Agent provider failure, and write approval failure or expiry. |
| Release and rollback | A signed/versioned build can be verified, recorded, and rolled back to a previous known-good build. | Version check output, signed MSI/NSIS hashes, signature status, and rollback notes. |

## Blocking Rule

A product workflow is not product-ready when evidence only proves the MVP path,
only proves a unit test, or requires editing docs, scripts, fixtures, local
storage, or credentials by hand during the end-user flow. Such cases are useful
development evidence, but they must stay marked as blockers until repeatable QA
or a documented manual release step closes them.
