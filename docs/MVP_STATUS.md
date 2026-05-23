# MVP Status

Last updated: 2026-05-23

This document maps the current implementation against the MVP scenarios in
`docs/MVP.md`.

The current project target has moved beyond MVP to complete product usability.
Use `docs/PRODUCT_READINESS.md` for the active release target and blockers.
This file remains the baseline record for what the verified MVP already covers.

## Summary

| Scenario | Status | Notes |
| --- | --- | --- |
| Desktop workbench shell | Implemented | Sidebar, main thread, agent inspector, activity log, composer, and confirmation cards render in the desktop UI. |
| Local file scan and summary | Implemented | Markdown documents are scanned through Tauri, summarized in `packages/tools`, displayed in the UI, and verified for path/time/size/purpose fields. |
| Research report with sources | Implemented for MVP | User-provided URLs are fetched and converted into a source-backed report. Automated public search is deferred to Milestone B. |
| Project inspection and check run | Implemented | Project scripts are inspected, start/check commands are recommended, and allowlisted checks are executed with exit codes and output. |
| High-risk file dry-run and confirmation | Implemented | PDF organization creates a dry-run, asks for approval, executes approved matching moves with a one-time approval id, skips conflicts, and reports moved/skipped/failed results. |
| Code Agent / opencode backend | Deferred | Current project inspection does not call opencode; Code Agent is Milestone C. |
| Persistent task history | Deferred | Runtime state is in-memory only; persistence is Milestone D. |
| Core runtime tests | Implemented for MVP | Route selection, permission state changes, research reporting, selected failure paths, file-scan failure, PDF no-op/preview/execution failures, and native PDF safety boundaries have focused coverage. |

## Scenario Details

### 1. Local File Scan

User goal examples:

```text
Find recently modified Markdown documents in this project and summarize them.
```

Implemented flow:

1. Commander selects the document scan path.
2. File Agent calls `scan_markdown_documents`.
3. Tool layer summarizes document purpose.
4. Verifier checks path, modified time, size, and purpose fields.
5. UI shows documents, activity logs, agent state, and verification summary.

Limitations:

- Summary is rule-based, not model-generated.
- Scan is scoped to the resolved workspace and skips sensitive-looking names.

### 2. Research Report

User goal examples:

```text
Collect these sources and produce a report: https://example.com/a https://example.com/b
```

Implemented flow:

1. Commander detects URLs in the goal.
2. Research Agent fetches each public URL.
3. Core builds a source-backed report with claim, source URL, and evidence.
4. Verifier checks sources and report evidence.
5. UI shows sources, report rows, unknowns, and verification summary.

Limitations:

- No search provider is integrated yet; manual URL input is the accepted MVP
  research workflow.
- The MVP scenario expects at least three accessible sources for a full
  comparison report; fewer sources are explicitly marked as incomplete.

### 3. Project Inspection

User goal examples:

```text
Inspect the current project, explain how to start it, and run one check.
```

Implemented flow:

1. Project Tool reads `package.json`.
2. Package manager is inferred from lockfiles.
3. Start and test/check commands are recommended.
4. Shell Tool runs allowlisted checks such as `node --version`,
   `pnpm --version`, `git status --short`, and the recommended check script.
5. Verifier checks exit codes and output summaries.

Limitations:

- Test execution is limited to a small allowlist.
- Code Agent / opencode is not integrated and is deferred to Milestone C.

### 4. PDF Organization Dry-Run and Confirmation

User goal examples:

```text
Organize PDFs in Downloads by topic.
```

Implemented flow:

1. File Agent scans `Downloads` for PDF files.
2. A dry-run lists source path, target path, action, and conflicts.
3. UI shows confirmation cards in the main thread and Activity area.
4. Approve records a one-time approval id for the current dry-run.
5. Execution runs only the approved `move` operations when the submitted paths
   still match the dry-run exactly.
6. Deny performs no write.
7. Execution reports moved, skipped, and failed files.

Safety constraints:

- Only `move` operations are supported.
- Only PDF files are moved.
- Source and target paths must stay inside `Downloads`.
- The confirmed-write command requires a current one-time approval id.
- The executed operations must match the approved dry-run.
- Parent directory traversal is rejected.
- Existing targets are skipped by default.
- Target parent directories are checked to avoid escaping through existing
  symlinked directories.

## Release Readiness

The documented MVP release criteria are complete for the 2026-05-23 QA pass:

- `pnpm check` passes.
- `git diff --check` passes.
- The packaged Tauri build passes and produces MSI/NSIS artifacts.
- Native release-app QA screenshots are captured in `docs/qa/2026-05-23/`.
- PDF approval, denial, and conflict-skip paths are covered by native QA and
  Rust tests. Rust tests also cover missing approval rejection, changed dry-run
  rejection, one-time approval consumption, non-move rejection, source/target
  boundary rejection, non-PDF rejection, traversal rejection, and missing-source
  failure.

Remaining work is not blocking for the verified MVP baseline, but it is blocking
for a complete product release:

- Automated search integration.
- Code Agent / opencode integration.
- Persistent task history.
- Workspace selection.
- Generalized confirmed-write enforcement for all write-capable tools.
- Signed/versioned release builds with rollback notes.
