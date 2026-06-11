# Agent Handoff Report Source QA

Date: 2026-06-11

Scope: source-level QA only. This does not close packaged/saveable handoff
evidence requirements.

## What Changed

- `packages/core/src/shared-context.ts` exposes `buildHandoffReport`.
- The report is generic across agents and tools. It records step input/output
  context keys, producer step ids, consumer step ids, missing inputs,
  unconsumed outputs, status, and compact value summaries.
- Value summaries avoid serializing full objects or arrays. Strings are
  bounded by a caller-supplied preview length.
- `packages/core/src/index.ts` exports the report builder and types, and
  `TaskSnapshot` can carry a `handoffReport`.
- `packages/core/src/workflow-executor.ts` attaches a handoff report to final
  Commander DAG snapshots.
- `packages/ui/src/components/AgentDetailSections.tsx` displays report status,
  missing inputs, unconsumed outputs, and producer/consumer links when a task
  snapshot contains a handoff report.
- `apps/desktop/src/task-history.ts` preserves valid `handoffReport` payloads
  and step context keys during task-history sanitization, while dropping
  malformed handoff reports.
- `apps/desktop/src/task-session-log.ts` keeps valid handoff reports in
  session snapshot JSONL through the shared sanitizer path.
- `packages/core/src/shared-context.ts` can format a handoff report as stable
  JSON and Markdown artifacts through `createHandoffReportArtifacts`, with
  sanitized base filenames and compact value summaries.
- `packages/ui/src/handoff-report-export.ts` mirrors the workbench report shape
  into stable JSON and Markdown artifacts without depending on `@javis/core`.
- `packages/ui/src/components/AgentDetailSections.tsx` exposes source-level
  JSON and Markdown download controls for task handoff reports.

## Verification

Command:

```powershell
corepack pnpm --filter @javis/core test -- src/shared-context.test.ts
```

Result:

```text
Test Files 29 passed (29)
Tests 425 passed (425)
```

Additional source-level checks:

```powershell
corepack pnpm --filter @javis/core typecheck
corepack pnpm --filter @javis/core test -- src/workflow-executor.test.ts src/shared-context.test.ts
corepack pnpm --filter @javis/ui test -- src/index.test.tsx
corepack pnpm --filter @javis/ui typecheck
corepack pnpm --filter @javis/desktop test -- src/task-history.test.ts src/task-session-log.test.ts
corepack pnpm --filter @javis/desktop build
corepack pnpm qa:product-workflows:source
```

Results:

```text
@javis/core typecheck: passed
@javis/core tests: Test Files 29 passed (29), Tests 427 passed (427)
@javis/ui tests: Test Files 12 passed (12), Tests 174 passed (174)
@javis/ui typecheck: passed
@javis/desktop tests: Test Files 55 passed (55), Tests 661 passed (661)
@javis/desktop build: passed
qa:product-workflows:source: passed with known blockers still BLOCKED
```

Additional UI export checks:

```powershell
corepack pnpm --filter @javis/ui typecheck
corepack pnpm --filter @javis/ui test -- src/index.test.tsx
```

Results:

```text
@javis/ui typecheck: passed
@javis/ui tests: Test Files 12 passed (12), Tests 174 passed (174)
```

## Remaining Risk

- No packaged app screenshot or export/download flow was run.
- Product evidence still needs a saved handoff report artifact from a packaged
  app workflow before this can be treated as product-ready. Source-level JSON
  and Markdown artifact formatting plus UI download controls are present, but
  no desktop packaged save/download UI evidence was captured.
