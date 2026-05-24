# Manual QA Checklist

Use this checklist before tagging a build or after changing desktop UI, Tauri
commands, Core routing, or permission flows.

The scenarios below are the verified MVP baseline. A complete product release
must also cover the product-readiness scenarios in `PRODUCT_READINESS.md`,
including automated research search, Code Agent approved edits, persistence,
workspace selection, generalized confirmed-write approvals, and release rollback
notes.

## Setup

- Run `pnpm install` if dependencies changed.
- Run `pnpm check` and keep the command output with the QA notes.
- Start the desktop app with `pnpm dev`.
- Create a screenshot folder such as `docs/qa/2026-05-23/`.
- For repeatable search-backed research evidence, build the release app and run
  `docs/qa/2026-05-23/research-search-qa.ps1`.
- For live `github-cli` and Agent Chrome provider smoke evidence, run
  `docs/qa/2026-05-23/research-live-smoke-qa.ps1`.

## Required Screenshots

Capture these states for each manual QA pass:

- Idle workbench before a task starts.
- Markdown scan completed state.
- Project inspection completed state.
- Research report completed state.
- PDF organization permission card before approval.
- PDF organization approved execution result.
- PDF organization denied no-op result.
- Error or failed verification state, if the change touches failure handling.

Additional product-release screenshots are required once the related features
exist:

- Search-backed research completed state with at least three sources.
- `github-cli` research completed state.
- IntelliSearch-backed research completed state after Code Agent integration.
- Agent Chrome fallback research completed state.
- Search failure or no-results state.
- Code Agent diff preview before continuing to read-only verification.
- Code Agent approved edit result with verification output.
- Code Agent denied no-op result.
- Task history after app restart.
- Workspace path selection, recent workspace state, and restart persistence.
- General confirmed-write approval for a non-PDF write tool.

## Scenarios

### Markdown Scan

- Submit: `Find Markdown documents in this workspace`.
- Verify the plan shows File Agent and Verifier steps.
- Verify results include paths, modified times, file sizes, and purpose text.
- Verify the final message says the scan was verified.

### Project Inspection

- Submit: `test project environment`.
- Verify project scripts are detected.
- Verify read-only checks run through the Shell Agent.
- Verify the recommended test/check command appears when available.
- Verify failing commands produce a failed verification state.

### Workspace Selection

- Enter a valid workspace path, submit `test project environment`, and verify
  the Project Inspection workspace path matches the selected path.
- Use Browse to select a workspace with the native directory picker, submit
  `test project environment`, and verify the Project Inspection workspace path
  matches the Browse-selected path.
- Enter an invalid workspace path, submit `test project environment`, and verify
  the failure message explains that the selected workspace path is not
  accessible or does not contain `package.json`.
- Verify invalid workspace paths are not added to recent workspaces.
- Verify a Browse-selected valid workspace is added to recent workspaces only
  after the task completes.
- Delete a recent workspace entry and verify it is removed from the sidebar.
- Restart the app and verify valid recent workspaces are restored.

### URL Research Baseline

- Submit a task with at least two public `https://` URLs.
- Verify each URL is fetched once.
- Verify the report only makes claims backed by source excerpts.
- Verify the report lists unknowns when fewer than three sources are provided.

### Search-Backed Research

- Submit a research task without URLs.
- Verify Javis uses `github-cli` when available.
- Verify Javis falls back to `agent-chrome` when `github-cli` is unavailable or
  returns no usable results.
- Run `research-search-qa.ps1` to capture repeatable fixture evidence for
  `github-cli`, `agent-chrome`, weak evidence, failed fetch, and no-results
  states.
- Run `research-live-smoke-qa.ps1` to capture live `github-cli` and Agent Chrome
  provider smoke evidence.
- After Code Agent integration, verify Javis can use `opencode-intellisearch`
  through the OpenCode plugin path.
- Verify the source list shows provider metadata.
- Verify the report includes at least three excerpt-backed sources when results
  are available.
- Verify no-results and failed-fetch paths produce failed verification states
  with useful messages.

### PDF Organization

- Place test PDFs in Downloads.
- Submit: `Organize PDFs in Downloads`.
- Verify the dry-run lists source and target paths before any move.
- Deny once and verify no files moved.
- Approve once and verify only the listed PDF paths moved.
- Re-run with a target conflict and verify the conflict is skipped.

### Code Agent Diff Preview

- Create a small local code change without committing it.
- Submit: `Review code changes`.
- Verify changed files and the diff preview are shown before any verification
  command runs.
- Deny once and verify no verification command runs.
- Approve once and verify `git diff --check` runs through the Shell Agent.
- Verify the final state distinguishes a clean diff check from a failed diff
  check.
- Do not treat this scenario as approved edit QA. Core/UI now include the
  proposed-edit and confirmed-write approval contract, and desktop includes a
  proposal-only opencode adapter plus local approved-patch apply command.
  Separate approved-edit QA still needs an opencode proposal that produces a
  reviewable patch.

### Code Agent Approved Edit

- Ensure `opencode --version` works in the release environment.
- Configure provider, model, API key, and optional base URL in the desktop
  workbench model settings before running live opencode QA.
- Create a small local code change without committing it.
- Submit: `Review code changes`.
- Verify Javis shows a Code Agent patch proposal before requesting write
  approval.
- Deny once and verify no files change.
- Re-run, approve the patch proposal, and verify only the approved patch paths
  are modified.
- Verify post-apply `git diff --check` runs and the final state records the
  apply result.
- For repeatable provider parsing evidence, set `JAVIS_QA_MODE=1` with
  `JAVIS_CODE_PROPOSAL_FIXTURE_PATH` pointing at a proposal JSON fixture.
- For packaged-app repeatable Code Agent evidence, run
  `docs/qa/2026-05-24/code-agent-opencode-qa.ps1`. It covers proposal denial,
  approved patch application, and reports live provider smoke as blocked until
  API keys can be injected without writing them to localStorage. The script
  accepts bare provider model names such as `deepseek-v4-flash` and normalizes
  them to the provider/model form used by opencode.
  Do not write live API keys into QA notes or committed scripts.

### PDF Durable Approval Restart

- Run `pnpm --filter @javis/desktop tauri build` before packaged restart QA.
- Run `docs/qa/2026-05-24/pdf-durable-approval-qa.ps1`.
- Verify the packaged app restores a pending PDF organization approval card
  from `javis.approvalRecords.v1` after restart.
- Approve the restored card and verify the source PDF is moved to the approved
  target path.
- Verify `javis.approvalRecords.v1` records the approval as `approved` with the
  same `previewHash`.
- Deny a restored card and verify the source PDF remains in place, no target
  PDF is created, and the durable record is `denied`.
- Inject an expired pending approval and verify no approval card is restored,
  no file is moved, and the durable record is `expired`.
- Capture screenshots for restored, approved, denied, and expired states.

### Product Readiness Scenarios

Before calling a build complete-product-ready, add and pass scenario scripts for
every blocker listed in `PRODUCT_READINESS.md`.

## Regression Notes

Record:

- Date and commit or branch.
- Operating system.
- Commands run.
- Screenshots captured.
- Any failed scenario and whether it blocks release.
