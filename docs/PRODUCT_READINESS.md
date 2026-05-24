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
| Persistence | Save task history, results, permission decisions as scoped records, and allow deletion. | Partial. Completed, failed, and cancelled task snapshots are stored locally with sidebar restore and delete controls; resolved permission decisions are retained as audit evidence. Pending confirmed-write approvals are still in-memory only and need durable approval records before approval cards can survive app restart. |
| Workspace management | Select and remember workspaces without relying on the launch directory. | Implemented. Desktop sidebar accepts manual workspace paths and a native directory picker, restores recent workspaces from local storage after app restart, persists only completed workspace runs, supports recent deletion, and routes workspace-aware read/project/code tools through the selected path. Manual restart screenshots are recorded in `docs/qa/2026-05-24/`. |
| Permission enforcement | Confirmed writes require visible approval and native enforcement for the current dry-run. | Partial. PDF organization has one-time native approval-state enforcement, and Code Agent patch apply is gated by Core confirmed-write plus native path checks. A reusable durable approval/native guard layer is still needed across write-capable tools. |
| Error recovery | Failed tools show actionable errors and allow retry or alternate paths. | Partial. MVP failure states exist, failed tasks expose an initial retry action, and failed research tasks now point users to manual URL fallback; broader alternate-path recovery is not complete. |
| Release operations | Signed/versioned builds, repeatable QA evidence, release notes, and rollback notes. | Partial. Unsigned Windows build and QA evidence exist. |

## Product Release Blockers

Do not call Javis a complete usable product while any of these are true:

- Code Agent live opencode proposal/apply QA is not complete for real
  providers. Packaged-app fixture QA passes for proposal denial and approved
  patch application, and the native proposal runner now has timeout,
  OpenAI-compatible fallback, fenced/pretty JSON parsing, and approved-file
  binding hardening. Live DeepSeek-compatible smoke still needs to be rerun
  with temporary credentials before this blocker can close.
- Model API keys are currently persisted in app local storage; OS credential
  storage is still needed before treating secrets as hardened.
- Pending confirmed-write approvals are not durable. Approval cards cannot yet
  survive app restart, and approve/deny decisions cannot resume from a
  persisted preview.
- Task history persistence is limited to local completed/failed/cancelled
  snapshots and needs broader QA across app restart and future storage
  migrations.
- Confirmed-write enforcement has separate PDF and Code Patch implementations
  but not a reusable durable approval/native guard layer.
- Manual QA covers only MVP scenarios.
- Release builds are unsigned or lack version/rollback notes.
- A primary user workflow requires editing docs, scripts, or fixtures by hand.

## Current Stage

The project has a verified MVP foundation. The next stage is product completion:

1. Implement durable approval records, starting with PDF organization as the
   smallest confirmed-write recovery loop.
2. Migrate Code Patch approval to the durable approval record and add proposal
   base/dry-run/hash checks before apply.
3. Refactor PDF and Code Patch native checks into reusable approval/path/hash
   guards.
4. Move model API keys out of browser local storage into hardened secret
   storage.
5. Rerun the live DeepSeek-compatible Code Agent proposal smoke with temporary
   credentials, then decide whether approved live apply is safe to exercise or
   should remain covered only by fixture QA.
6. Expand QA from MVP scenarios to complete-product workflows and add release
   signing/versioning/rollback documentation.

`docs/MVP_STATUS.md` remains useful as a baseline acceptance record, but it is
not the current finish line.
