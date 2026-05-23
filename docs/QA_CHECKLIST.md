# Manual QA Checklist

Use this checklist before tagging a build or after changing desktop UI, Tauri
commands, Core routing, or permission flows.

The scenarios below are the verified MVP baseline. A complete product release
must also cover the product-readiness scenarios in `PRODUCT_READINESS.md`,
including automated research search, Code Agent edits, persistence, workspace
selection, generalized confirmed-write approvals, and release rollback notes.

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
- Code Agent diff preview before approval.
- Code Agent approved edit result with verification output.
- Code Agent denied no-op result.
- Task history after app restart.
- Workspace selection and recent workspace state.
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
