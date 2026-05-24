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
| Code Agent | Inspect code, propose changes, produce diffs, apply approved edits, and run verification. | Partial. Core can route code review goals to a Code Agent scaffold that lists changed files, shows a diff preview, asks before continuing, runs read-only `git diff --check`, and supports a hash-bound confirmed-write approval for proposed patch application when a backend is configured; opencode/backend integration is still not implemented. |
| Persistence | Save task history, results, permission decisions as scoped records, and allow deletion. | Partial. Completed, failed, and cancelled task snapshots are stored locally with sidebar restore and delete controls; resolved permission decisions are retained as audit evidence, while pending approvals are not persisted. |
| Workspace management | Select and remember workspaces without relying on the launch directory. | Implemented. Desktop sidebar accepts manual workspace paths and a native directory picker, restores recent workspaces from local storage after app restart, persists only completed workspace runs, supports recent deletion, and routes workspace-aware read/project/code tools through the selected path. Manual restart screenshots are recorded in `docs/qa/2026-05-24/`. |
| Permission enforcement | Confirmed writes require visible approval and native enforcement for the current dry-run. | Implemented for PDF organization; needs to generalize to future write tools. |
| Error recovery | Failed tools show actionable errors and allow retry or alternate paths. | Partial. MVP failure states exist, failed tasks expose an initial retry action, and failed research tasks now point users to manual URL fallback; broader alternate-path recovery is not complete. |
| Release operations | Signed/versioned builds, repeatable QA evidence, release notes, and rollback notes. | Partial. Unsigned Windows build and QA evidence exist. |

## Product Release Blockers

Do not call Javis a complete usable product while any of these are true:

- Code Agent still lacks opencode integration and a real desktop edit proposal /
  patch application backend, though the Core/UI approval contract now exists.
- Task history persistence is limited to local completed/failed/cancelled
  snapshots and needs broader QA across app restart and future storage
  migrations.
- Confirmed-write enforcement is implemented only for one narrow PDF flow.
- Manual QA covers only MVP scenarios.
- Release builds are unsigned or lack version/rollback notes.
- A primary user workflow requires editing docs, scripts, or fixtures by hand.

## Current Stage

The project has a verified MVP foundation. The next stage is product completion:

1. Connect the Code Agent proposed-edit and approved-apply contract to an
   opencode-backed implementation workflow.
2. Harden local persistence across app restart, storage migration, and future
   scoped permission records.
3. Generalize the permission model to all write-capable tools.
4. Expand QA from MVP scenarios to complete-product workflows.
5. Add release signing/versioning/rollback documentation.

`docs/MVP_STATUS.md` remains useful as a baseline acceptance record, but it is
not the current finish line.
