# Commander Failure Recovery Classification Source QA

Date: 2026-06-11

## Scope

Source-level evidence only. This QA does not run real external providers, remote Git writes, packaged app flows, live hot-list providers, or screenshot capture.

## Evidence

- `packages/core/src/commander-plan-schema.ts` enriches failed-step replan prompts with a generic failure kind and recovery hint.
- The classifier is task-agnostic and recognizes timeout, permission, unavailable dependency, parse/schema, rate limit, verification, and unknown failures.
- The English recovery prompt tells Commander not to retry the same failed step/params and to choose a different tool, query, source, or record-failure step when no safe alternative exists.
- `packages/core/src/commander-plan-schema.test.ts` covers timeout, permission, parse, and verification failure prompts.
- `packages/core/src/recovery-report.ts` builds a task-agnostic `recoveryReport` with failure kind, replan status, abandoned failed-step flag, recovery step IDs, completed-before context, generic alternate-path suggestions, and redacted error summaries.
- `packages/core/src/workflow-executor.ts` attaches `recoveryReport` to final Commander DAG snapshots when recovery is attempted, both for planned alternate paths and unrecovered failures.
- `packages/ui/src/components/AgentDetailSections.tsx` displays the recovery report in task details.
- `apps/desktop/src/task-history.ts` preserves valid recovery reports and drops malformed report payloads during history sanitization.
- `apps/desktop/src/task-session-log.ts` uses the same task snapshot sanitizer for JSONL session snapshots; `apps/desktop/src/task-session-log.test.ts` now verifies recovery reports survive write/parse session JSONL round trips.
- Source tests passed:
  - `corepack pnpm --filter @javis/core test -- src/recovery-report.test.ts src/workflow-executor.test.ts`
  - `corepack pnpm --filter @javis/core typecheck`
  - `corepack pnpm --filter @javis/ui test -- src/index.test.tsx`
  - `corepack pnpm --filter @javis/desktop test -- src/task-session-log.test.ts src/task-history.test.ts`

## Blockers Remaining

- No packaged/live workflow evidence was collected for automatic recovery behavior.
- Tool-specific fallback policies still need real workflow QA before this can be called product-complete.
- Product blockers such as live provider execution, packaged repo QA, trend hot-list live evidence, remote PR writes, and release/rollback remain open.
