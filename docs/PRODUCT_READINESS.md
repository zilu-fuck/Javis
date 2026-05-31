# Product Readiness

Last updated: 2026-05-31

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
| Code Agent | Inspect code, propose changes, produce diffs, apply approved edits, and run verification. | Partial. Core routes code review goals to the Code Agent: lists changed files, shows diff preview, requests opencode-backed JSON patch proposals using desktop-managed model/provider settings, and applies approved patches through confirmed-write + native guard. Packaged-app fixture QA covers proposal denial and approved patch application. Proposal backend has DeepSeek/custom OpenAI-compatible fallback, stricter proposal-file binding, parser hardening, and redacted diagnostics. Agent optimization: 11/13 issues resolved; safePlanWorkflow dynamic agent reading fixed. Live provider smoke QA pending rerun with temporary credentials. |
| Persistence | Save task history, results, permission decisions as scoped records, and allow deletion. | Implemented. Completed, failed, and cancelled task snapshots stored locally with sidebar restore/delete. Durable approval records cover PDF and Code Patch pending/resolved audit. Packaged restart QA verifies approve/apply, deny, and expiry recovery for both flows. SQLite migration complete: all 9 migration sets deployed, model-settings migrated; task history, approval records, and workspaces migration verification in progress. |
| Workspace management | Select and remember workspaces without relying on the launch directory. | Implemented. Desktop sidebar accepts manual paths and native directory picker, restores recent workspaces after restart, persists completed runs, supports deletion. Restart QA screenshots recorded. |
| Permission enforcement | Confirmed writes require visible approval and native enforcement for the current dry-run. | Partial. PDF organization has one-time native approval-state enforcement and validates restored/approved operations through a native path/source guard. Code Agent patch apply is gated by confirmed-write plus native approval id, proposal hash, one-shot consumption, path checks, current-file hashes, native tool binding, and native preview-hash binding. File Write tool (file.planWriteText / file.writeText) added but full confirmed-write wiring pending. Restored durable approvals recompute the dry-run binding hash and Code Patch restore checks persisted proposal files against the approved dry-run. |
| Error recovery | Failed tools show actionable errors and allow retry or alternate paths. | Partial. MVP failure states exist, failed tasks expose retry action. Chinese error messages localized through `error-localizer.ts` (70+ mappings). Keyring errors get readable Chinese messages on non-Windows. Broader alternate-path recovery not yet complete. |
| Release operations | Signed/versioned builds, repeatable QA evidence, release notes, and rollback notes. | Partial. Unsigned Windows build and QA evidence exist. Product workflow QA now has a matrix and evidence gate in `docs/qa/PRODUCT_WORKFLOWS.md`, but strict release evidence still has blockers. |

## Product Release Blockers

Do not call Javis a complete usable product while any of these are true:

- Code Agent live opencode proposal/apply QA is not complete for real
  providers. Packaged-app fixture QA passes for proposal denial and approved
  patch application. The native proposal runner has reqwest 0.12 + native-tls,
  OpenAI-compatible fallback, fenced/pretty JSON parsing, and redacted provider
  diagnostics. Agent optimization: 11/13 issues resolved; safePlanWorkflow
  dynamic agent reading fixed. Live DeepSeek-compatible smoke previously failed
  with safe-fail (no writes attempted); reqwest request construction needs
  debugging against the working Python verification script.
- Task history, approval records, and workspaces migration status needs
  verification. SQLite migration system is fully deployed (rusqlite + Tauri
  commands + 9 migration sets, model-settings migrated). Remaining work is
  verifying the three localStorage consumers have been migrated into the
  existing SQLite database.
- Confirmed-write enforcement shares native approval binding for PDF, Code
  Patch, and File Write (approval ID, tool, preview hash, one-shot consumption,
  path guards). File Write tool (file.planWriteText / file.writeText) needs
  confirmed-write integration. Remaining guard work is broader write-command
  migration.
- Product workflow QA gate does not pass strictly, including live Code Agent
  provider apply, task history restore/delete, model secret redaction scan, and
  signed release rollback evidence.
- Release builds are unsigned or lack version/rollback notes.
- A primary user workflow requires editing docs, scripts, or fixtures by hand.

## Current Stage

The project has a verified MVP foundation with Chinese optimization complete and
streaming UI consumption fully implemented (Rust SSE → Tauri events →
delta-reducer → ThreadView StreamingMessage → useSmoothStream typewriter
animation with cancel). The next stage is product completion:

1. Debug reqwest HTTP request construction for DeepSeek API calls (fix the gap
   between Rust and the working Python verification script).
2. Complete migration verification for task history, approval records, and
   workspaces from localStorage into the existing SQLite database.
3. Run the complete-product workflow QA matrix in `docs/qa/PRODUCT_WORKFLOWS.md`
   and close any strict gate blockers.
4. Add release signing/versioning/rollback documentation.
5. Wire LLM vision API backend calls for the Vision Agent.
6. Integrate Browser Agent, Workspace Agent, and File Write tools into
   complete-product workflow QA.

`docs/MVP_STATUS.md` remains useful as a baseline acceptance record, but it is
not the current finish line.
