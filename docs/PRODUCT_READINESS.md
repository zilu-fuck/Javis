# Product Readiness

Last updated: 2026-05-24

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
| Research | Search or collect public sources, fetch evidence, compare at least three sources, cite excerpts, and label unknowns. | Partial. User-provided URL flow works; automated search has `github-cli` and Agent Chrome provider paths. Fixture QA covers success/failure states, live `github-cli` plus Agent Chrome smoke QA passes, and source-comparison summaries now call out overlap and differences. |
| Code Agent | Inspect code, propose changes, produce diffs, apply approved edits, and run verification. | Partial. Core can route code review goals to a Code Agent scaffold that lists changed files, shows a diff preview, asks before continuing, runs read-only `git diff --check`, requests an opencode-backed JSON patch proposal using desktop-managed model/provider settings, and applies approved patches through the local confirmed-write backend. Packaged-app fixture QA covers proposal denial and approved patch application. The proposal backend now has a DeepSeek/custom OpenAI-compatible fallback, stricter proposal-file binding, and parser hardening; live provider smoke still needs to be rerun with temporary credentials. |
| Persistence | Save task history, results, permission decisions as scoped records, and allow deletion. | Partial. Completed, failed, and cancelled task snapshots are stored locally with sidebar restore and delete controls; resolved permission decisions are retained as audit evidence. Durable approval record storage covers PDF approvals and Code Patch pending/resolved audit records. Packaged restart QA verifies PDF and Code Patch approve/apply, deny, and expiry recovery paths. |
| Workspace management | Select and remember workspaces without relying on the launch directory. | Implemented. Desktop sidebar accepts manual workspace paths and a native directory picker, restores recent workspaces from local storage after app restart, persists only completed workspace runs, supports recent deletion, and routes workspace-aware read/project/code tools through the selected path. Manual restart screenshots are recorded in `docs/qa/2026-05-24/`. |
| Permission enforcement | Confirmed writes require visible approval and native enforcement for the current dry-run. | Partial. PDF organization has one-time native approval-state enforcement and now validates restored/approved operations through a native path/source guard before they enter pending state. Code Agent patch apply is gated by Core confirmed-write plus native approval id, proposal hash, one-shot consumption, path checks, and current-file hashes. Code Patch proposal/apply now share the native relative path, approved-file, and current-file guard. |
| Error recovery | Failed tools show actionable errors and allow retry or alternate paths. | Partial. MVP failure states exist, failed tasks expose an initial retry action, and failed research tasks now point users to manual URL fallback; broader alternate-path recovery is not complete. |
| Release operations | Signed/versioned builds, repeatable QA evidence, release notes, and rollback notes. | Partial. Unsigned Windows build and QA evidence exist. |

## Product Release Blockers

Do not call Javis a complete usable product while any of these are true:

- Code Agent live opencode proposal/apply QA is not complete for real
  providers. Packaged-app fixture QA passes for proposal denial and approved
  patch application, and the native proposal runner now has timeout,
  OpenAI-compatible fallback, fenced/pretty JSON parsing, limited real-provider
  alias/wrapper parsing, redacted provider diagnostics, and approved-file
  binding hardening. Live DeepSeek-compatible smoke now runs with temporary
  credentials injected through the native secret-reference path, but needs to be
  rerun after this parser/prompt hardening before live approved apply can move
  beyond fixture QA.
- Model API keys are no longer persisted in browser local storage. The desktop
  stores only provider/model/base URL plus a key reference there, writes the key
  through native commands, and on Windows protects the secret with DPAPI before
  the proposal command reads it for a single provider request.
- Pending confirmed-write approval recovery is not fully generalized into a
  shared abstraction, but packaged restart QA now proves PDF and Code Patch
  approval cards survive app restart, can approve/apply or deny from persisted
  previews, and expire stale pending records fail-closed.
- Task history persistence is limited to local completed/failed/cancelled
  snapshots and needs broader QA across app restart and future storage
  migrations.
- Confirmed-write enforcement now shares native approval binding for PDF and
  Code Patch approval id / approved-state checks. PDF approval/restore validates
  operation paths and PDF sources before pending state is accepted, while Code
  Patch apply validates proposal hash, approved files, and current-file hashes
  with one-shot consumption. Remaining guard work is task/tool binding,
  generalized preview hash checks, and broader write-command migration.
- Manual QA covers only MVP scenarios.
- Release builds are unsigned or lack version/rollback notes.
- A primary user workflow requires editing docs, scripts, or fixtures by hand.

## Current Stage

The project has a verified MVP foundation. The next stage is product completion:

1. Rerun the live DeepSeek-compatible Code Agent proposal smoke after the
   real-provider prompt/parser hardening and inspect the redacted provider
   diagnostic if it still fails.
2. Keep live approved apply disabled until real-provider proposal output is
   stable; continue covering apply through fixture QA.
3. Expand QA from MVP scenarios to complete-product workflows and add release
   signing/versioning/rollback documentation.

`docs/MVP_STATUS.md` remains useful as a baseline acceptance record, but it is
not the current finish line.
