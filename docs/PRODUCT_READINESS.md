# Product Readiness

Last updated: 2026-05-26

This document defines the current target for Javis: a complete usable desktop
product, not only an MVP build.

## Target Definition

Javis is product-ready when a user can install the desktop app, connect it to a
real project, delegate everyday research and coding tasks, review risky actions
before they happen, recover from failures, and return later with useful task
history intact.

## Required Product Capabilities

| Area | Product-ready requirement | Current status |
| --- | --- | --- |
| Desktop workbench | Installable app with stable task thread, logs, agent state, and permission UI. | MVP implemented and packaged on Windows. |
| File and project understanding | Read project files safely, summarize relevant documents, inspect scripts, and recommend/run checks. | MVP implemented with Markdown scan and allowlisted checks. |
| Research | Search or collect public sources, fetch evidence, compare at least three sources, cite excerpts, and label unknowns. | Implemented. User-provided URL flow works; automated search has `github-cli` and Agent Chrome provider paths. Fixture QA covers success/failure states, live `github-cli` plus Agent Chrome smoke QA passes. Source-comparison summaries call out overlap and differences. |
| Code Agent | Inspect code, propose changes, produce diffs, apply approved edits, and run verification. | Partial. Core can route code review goals to a Code Agent scaffold that lists changed files, shows a diff preview, asks before continuing, runs read-only `git diff --check`, requests an opencode-backed JSON patch proposal using desktop-managed model/provider settings, and applies approved patches through the local confirmed-write backend. Packaged-app fixture QA covers proposal denial and approved patch application after preserving provider patch bodies exactly for `git apply`. The proposal backend now has a DeepSeek/custom OpenAI-compatible fallback, stricter proposal-file binding, parser hardening, and redacted diagnostics; live provider smoke still needs to be rerun with temporary credentials. |
| Persistence | Save task history, results, permission decisions as scoped records, and allow deletion. | Implemented. Completed, failed, and cancelled task snapshots stored locally with sidebar restore/delete. Durable approval records cover PDF and Code Patch pending/resolved audit. Packaged restart QA verifies approve/apply, deny, and expiry recovery for both flows. SQLite migration planned for long-term durability. |
| Workspace management | Select and remember workspaces without relying on the launch directory. | Implemented. Desktop sidebar accepts manual paths and native directory picker, restores recent workspaces after restart, persists completed runs, supports deletion. Restart QA screenshots recorded. |
| Permission enforcement | Confirmed writes require visible approval and native enforcement for the current dry-run. | Partial. PDF organization has one-time native approval-state enforcement and now validates restored/approved operations through a native path/source guard before they enter pending state. Code Agent patch apply is gated by Core confirmed-write plus native approval id, proposal hash, one-shot consumption, path checks, current-file hashes, native tool binding, and native preview-hash binding. Restored durable approvals recompute the dry-run binding hash and Code Patch restore checks persisted proposal files against the approved dry-run. Code Patch proposal/apply now share the native relative path, approved-file, and current-file guard. |
| Error recovery | Failed tools show actionable errors and allow retry or alternate paths. | Partial. MVP failure states exist, failed tasks expose retry action. Chinese error messages localized through `error-localizer.ts` (70+ mappings). Keyring errors get readable Chinese messages on non-Windows. Broader alternate-path recovery not yet complete. |
| Release operations | Signed/versioned builds, repeatable QA evidence, release notes, and rollback notes. | Partial. Unsigned Windows build and QA evidence exist. Product workflow QA now has a matrix and evidence gate in `docs/qa/PRODUCT_WORKFLOWS.md`, but strict release evidence still has blockers. |

## Product Release Blockers

Do not call Javis a complete usable product while any of these are true:

- Code Agent live opencode proposal/apply QA is not complete for real
  providers. Packaged-app fixture QA passes for proposal denial and approved
  patch application. The native proposal runner has timeout, OpenAI-compatible
  fallback, fenced/pretty JSON parsing, and redacted provider diagnostics.
  Live DeepSeek-compatible smoke must be rerun with temporary credentials.
- Task history persistence uses localStorage rather than SQLite for durable
  audit records and schema migrations.
- Confirmed-write enforcement shares native approval binding for PDF and Code
  Patch (approval ID, tool, preview hash, one-shot consumption, path guards).
  Remaining guard work is broader write-command migration.
- Product workflow QA gate does not pass strictly, including live Code Agent
  provider apply, task history restore/delete, model secret redaction scan, and
  signed release rollback evidence.
- Release builds are unsigned or lack version/rollback notes.
- A primary user workflow requires editing docs, scripts, or fixtures by hand.

## Current Stage

The project has a verified MVP foundation with Chinese optimization complete and
streaming infrastructure in place. The next stage is product completion:

1. Rerun live DeepSeek-compatible Code Agent proposal smoke with real credentials.
2. Run the complete-product workflow QA matrix in `docs/qa/PRODUCT_WORKFLOWS.md`
   and close any strict gate blockers.
3. Migrate durable records from localStorage to SQLite.
4. Add release signing/versioning/rollback documentation.

`docs/MVP_STATUS.md` remains useful as a baseline acceptance record, but it is
not the current finish line.
