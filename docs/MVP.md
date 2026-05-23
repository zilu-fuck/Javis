# MVP Specification

This document defines the historical MVP target for Javis. Implementation
status is tracked in `MVP_STATUS.md`. The active project target is now complete
product usability, defined in `PRODUCT_READINESS.md`.

## Product Promise

Javis should let a user give a local desktop task, watch how the system plans
and executes it, approve risky actions, and see verification evidence before
the task is considered done.

The MVP does not try to be a general autonomous agent. It proves the workbench,
tool boundary, permission flow, and verification loop. Code Agent, persistence,
and automated public search are roadmap milestones, not blockers for the MVP
defined here.

## Primary Scenarios

### 1. Local Markdown Scan

User asks Javis to find and summarize Markdown documents in the workspace.

Acceptance criteria:

- The task routes to the File Agent.
- The file scan is read-only.
- Results include path, modified time, size, and purpose.
- Verifier reports whether all records contain required evidence.

### 2. Project Inspection

User asks Javis how to run or test the current project.

Acceptance criteria:

- Project Tool inspects package scripts.
- Shell Agent runs allowlisted read-only checks.
- Recommended start and test/check commands are shown when available.
- Failed checks produce a failed verification state.

### 3. Source-Backed Research

User provides public URLs and asks for a short report.

Acceptance criteria:

- Each provided URL is fetched once through the Web Tool.
- Report rows contain claim, source URL, and excerpt evidence.
- Unknowns are listed when sources are missing or fewer than three sources are
  available.
- No unsupported claim is marked as verified.

### 4. PDF Organization With Confirmation

User asks Javis to organize PDFs in Downloads.

Acceptance criteria:

- File Agent creates a dry-run before any move.
- UI displays source paths, target paths, conflicts, and risk summary.
- Deny performs no write.
- Approve executes only the approved PDF move operations.
- Conflicts are skipped by default.
- Verifier reports moved, skipped, and failed counts.

## Non-Goals For The MVP

- Autonomous browser purchasing, messaging, or account changes.
- Plugin marketplace.
- Cross-device control.
- Long-term memory or vector database.
- Editable agent graph.
- General shell execution.
- Silent filesystem writes.

## Success Criteria

The MVP is complete when:

- All primary scenarios above are implemented with the documented MVP scope.
- `pnpm check` passes.
- Manual QA has screenshots for the required states in `QA_CHECKLIST.md`.
- The security model is documented and reflected in implementation.
- Current docs no longer contain encoding-corrupted operational guidance.

## Current Status

See `MVP_STATUS.md` for the live status matrix. At the time of this document,
Markdown scan, project inspection, manual URL research, and PDF organization are
implemented and verified for the baseline. Automated search, Code Agent,
persistence, workspace selection, and product release hardening are required for
the current complete-product target.
