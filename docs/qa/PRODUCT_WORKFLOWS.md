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

To run the source-level helper tests plus known-blocker inventory in one step:

```powershell
corepack pnpm qa:product-workflows:source
```

Live/package workflow output files must record packaged-app provenance, not
just scenario `PASS` lines. The gate checks for packaged app context, app
version or build, a concrete QA date, and referenced artifacts such as
screenshots or JSON reports. Every referenced artifact must exist in the QA
evidence folder.

## Required Workflow Matrix

| Workflow | Product QA objective | Required evidence |
| --- | --- | --- |
| MVP baseline | The historical read-only and first approval scenarios still work. | Idle workbench, Markdown scan, project inspection, URL research, PDF approval, PDF denial, and a failed verification screenshot. |
| Search-backed research | Search providers produce excerpt-backed reports, provider metadata stays visible, and weak/no-result/fetch-failure paths fail clearly. | `research-search-qa.ps1` screenshots and structured `research-search-qa-output.txt` for `github-cli`, Agent Chrome fallback, weak evidence, failed fetch, and no results; `research-live-smoke-qa.ps1` screenshots and structured `research-live-smoke-qa-output.txt` for `github-cli` and Agent Chrome. |
| Workspace management | A user can select a project, complete a workspace-aware task, restart the packaged app, and see the workspace restored. | `workspace-restart-qa.ps1` screenshots and output. |
| Code Agent fixture safety | Code Agent shows a diff/proposal before writes, deny leaves files unchanged, approve applies only the proposal, and verification runs. | `code-agent-opencode-qa.ps1` fixture deny/apply screenshots and output. |
| Code Agent live provider | A real configured provider produces a parseable proposal, Javis stops for confirmed-write approval, approve applies only the proposed patch, and post-apply verification runs. | `docs/qa/2026-05-24/code-agent-opencode-qa.ps1 -RequireLiveProvider` with temporary provider env vars. Required evidence includes live provider pass notes, packaged app provenance, provider/model status without API keys, `20-code-agent-live-proposal-before-approve.png`, `20-code-agent-live-approved.png`, and output showing `LiveResult` as `live-approved` / `pass` while explicitly referencing both live screenshots. |
| Repository intelligence package/live | A packaged desktop Code Agent can search before editing, show ranked key files, trace a cross-file symbol graph, record resolver/package evidence, and expose fallback diagnostics. | Start from `docs/qa/2026-06-10/repo-intelligence/README.md`. Required evidence is `42-repo-search-key-files.png`, `43-repo-trace-symbol-graph.png`, and `repo-intelligence-package-live-qa-output.txt` showing key files, symbol graph, resolver evidence, local package hints, external registry evidence, and fallback diagnostics pass. |
| Structured hot-list research | A packaged desktop user can request a top-N live hot list through a typed read-only tool, preserve provider/source metadata, and turn the structured list into a research report with sources and diagnostics. | Start from `docs/qa/2026-06-10/trend-hot-list/README.md`. Required evidence is `38-trend-hot-list-report.png` or `38-structured-hot-list-report.png` plus `trend-hot-list-live-qa-output.txt` or `structured-hot-list-live-qa-output.txt` showing `trend.fetchHotList`, a provider id, requested count 20, non-empty item count, source URL, completed diagnostics, and report sources. |
| Durable PDF approval | Pending PDF approval restores after restart; approve, deny, and expiry resolve safely. | `pdf-durable-approval-qa.ps1` screenshots plus output proving approved moves the PDF, denied leaves source/target unchanged, expired fails closed, and stored statuses are `approved`, `denied`, and `expired`. |
| Durable Code Patch approval | Pending Code Patch approval restores after restart; approve/apply, deny, and expiry resolve safely. | `code-patch-durable-approval-qa.ps1` screenshots plus output proving approved file text is `hello approved`, denied/expired file text stays `hello reviewed`, and stored statuses are `approved`, `denied`, and `expired`. |
| Git remote and PR writes | A packaged desktop user can review Git status/remote/PRs, prepare and approve stage, commit, push, draft PR creation, and PR comment writes, and restored pending approvals recover safely after restart. | Git workflow screenshots for Review panel previews/approval cards/results plus `git-remote-pr-qa-output.txt` showing stage, commit, push, PR create, PR comment, denial, and restore checks. Start from `docs/qa/2026-06-09/git-remote-pr/README.md`. |
| Browser and Terminal approvals | Packaged Browser writes and interactive Terminal start/input require visible approval, denial fails closed, stale previews are rejected, and each approval can execute only once. | Required evidence is `39-terminal-start-approval-card.png`, `40-terminal-input-approval-card.png`, `41-browser-write-approval-card.png`, and `browser-terminal-approval-qa-output.txt` showing terminal start, terminal input, browser write, denial, stale-preview, and one-shot checks pass. |
| Task history persistence | Completed, failed, and cancelled tasks can be restored and deleted after restart without losing the selected workspace. | Restart screenshots and `task-history-qa-output.txt` from `docs/qa/2026-05-27/task-history-qa.ps1` showing restore and delete states. |
| Model settings and secret handling | Provider settings persist by reference, secrets are not written to localStorage, logs, screenshots, or notes. | Model settings restart evidence, secret-reference output, and `model-secret-redaction-qa-output.txt` from `docs/qa/2026-05-27/model-secret-redaction-qa.ps1` or `secret-scan-output.txt` showing no API key findings. |
| Agent memory embedding provider | A packaged desktop user can keep local embeddings or switch to a native OpenAI-compatible embedding provider by key reference, without exposing the API key to frontend state, logs, or QA artifacts. | Required evidence is `44-agent-memory-embedding-settings.png` plus `agent-memory-embedding-provider-live-qa-output.txt` showing local embedding, native OpenAI-compatible embedding, secret-reference redaction, and vector search checks pass. |
| Capability scoring evidence ingestion | A packaged desktop user can see agent capability scores updated from product QA/live evidence and recent tool failure signals, with evidence references visible in the inspector. | Required evidence is `45-capability-scoring-evidence-ingestion.png` plus `capability-scoring-evidence-ingestion-qa-output.txt` showing QA evidence, live evidence, evidence refs, and recent failure rate checks pass. |
| Error recovery | Failed product workflows show actionable recovery text and do not perform partial writes. | Failure screenshots for research, Code Agent provider failure, and write approval failure or expiry. |
| Release and rollback | A signed/versioned build can be verified, recorded, and rolled back to a previous known-good build. | `release-build-summary.json` generated by `scripts/release/build-windows-signed.ps1` plus `release-rollback-notes.md` generated by `scripts/release/write-release-rollback-notes.ps1`, recording matching version, commit, signed MSI/NSIS paths, valid signatures, signer thumbprints, SHA-256 hashes, previous known-good build, and previous artifact SHA-256. |

## Blocking Rule

A product workflow is not product-ready when evidence only proves the MVP path,
only proves a unit test, or requires editing docs, scripts, fixtures, local
storage, or credentials by hand during the end-user flow. Such cases are useful
development evidence, but they must stay marked as blockers until repeatable QA
or a documented manual release step closes them.
