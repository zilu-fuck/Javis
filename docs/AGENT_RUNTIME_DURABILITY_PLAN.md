# Agent Runtime Durability Plan

## Purpose

This document turns the external framework comparison report into a concrete
Javis modification plan. The goal is not to wrap Javis with Microsoft Agent
Framework, OpenHands, LangGraph, Magentic-One, or AgentScope. The goal is to
borrow their durable runtime ideas while keeping the current TypeScript + Tauri
+ Rust safety model.

## Assumptions

- Javis is already beyond a multi-agent chat demo: Commander DAG planning,
  capability dispatch, SharedContext handoff, verifier output, approval records,
  task history, and desktop UI are all product foundations.
- The next reliability gap is step-level recovery, not another agent role or
  another planning prompt.
- Native write enforcement remains the final authority. Runtime changes may
  improve risk analysis, approval policy, and recovery, but must not bypass the
  Rust approval binding, preview hash, path guard, or one-shot approval checks.
- The first implementation should be a narrow vertical slice that proves a real
  DAG run can recover after restart.

## Non-Goals

- Do not replace the current runtime with a third-party agent framework.
- Do not introduce dynamic sub-agent write execution in the first phase.
- Do not redesign the UI before the underlying event, artifact, and checkpoint
  contracts are stable.
- Do not weaken existing durable approval behavior for PDF, Code Patch, Git, or
  terminal/browser confirmed-write paths.

## Current Runtime Anchors

The modification should build on these existing code areas:

- `packages/core/src/task-event-bus.ts`: current `TaskRuntimeEvent` union and
  log conversion.
- `packages/core/src/delta-reducer.ts`: folds runtime events into snapshots.
- `packages/core/src/shared-context.ts`: `SharedTaskContext`, schema validation,
  and handoff reports.
- `packages/core/src/workflow-dag-executor.ts`: DAG scheduling, replan, timeout,
  and step lifecycle callbacks.
- `packages/core/src/workflow-executor.ts`: Commander DAG normalization,
  execution-mode routing, request_input/replan flow, and final reports.
- `apps/desktop/src/task-history.ts`: task snapshot persistence.
- `apps/desktop/src/restored-approval.ts`: durable approval restoration.
- `apps/desktop/src/app-runtime.ts`: desktop runtime wiring and restored state
  integration.

## Target Runtime Shape

```text
User goal
  -> CommanderDagPlan
  -> append-only RuntimeEventEnvelope sequence
  -> WorkflowCheckpoint snapshots
  -> ArtifactEnvelope-backed SharedContext
  -> approval-aware resume
  -> verifier / final report
```

The first durable runtime should prove that Javis can answer:

- Which run and plan version is active?
- Which DAG steps are complete, running, pending, abandoned, or waiting?
- Which context values are durable artifacts, who produced them, and what schema
  version they use?
- Which approval requests are linked to the current run?
- After restart, where can execution safely resume?

## P0 Durable Runtime Slice

The first implementation should stay narrow:

1. Add an append-only runtime event store.
2. Add ArtifactEnvelope support for the minimum context keys needed by a real
   Commander DAG.
3. Generate WorkflowCheckpoint records from DAG lifecycle callbacks.
4. Resume from a restored approval without rerunning completed upstream steps.

Progress ledgers, stuck detection, WorkspaceRuntime, and dynamic delegation are
useful follow-ups, but they should not block the first restart-resume proof.

## Phase 1: Runtime Event Envelope

### Goal

Make runtime events durable enough to support replay, debugging, and checkpoint
generation.

### Proposed Contract

```ts
interface RuntimeEventEnvelope<T> {
  eventId: string;
  eventVersion: number;
  sequence: number;

  taskId: string;
  runId: string;
  workflowId?: string;
  stepId?: string;
  agentId?: string;

  correlationId: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;

  occurredAt: string;
  recordedAt: string;
  payload: T;
}
```

### Implementation Notes

- Keep the existing `TaskRuntimeEvent` payload union.
- Wrap emitted events at the runtime boundary instead of changing every event
  payload at once.
- Add a `step.failed` runtime event or an equivalent envelope payload before
  relying on event replay for failure checkpoints. The current DAG executor has
  `onStepFailed` callbacks, but the durable event stream must represent the
  same lifecycle transition explicitly.
- Sequence numbers must be monotonic per `runId`.
- `occurredAt` records when the runtime event happened; `recordedAt` records
  when persistence accepted it. Tests should not assume these are always equal.
- Store event envelopes in a dedicated append-only `runtime_events` table.
  `task_history` remains the UI/history snapshot store and must not become the
  authoritative event log.
- Persist enough event metadata to reconstruct the last known task state,
  rebuild a checkpoint, and compare the result with `TaskSnapshot`.
- Keep backward compatibility for existing UI log rendering during migration.
- Update the native database guard for the new table. The implementation must
  add `runtime_events` to the Rust database allowlist, extend schema validation
  where required, register the migration during app startup, and add native SQL
  guard tests.

### Proposed Storage

```sql
CREATE TABLE IF NOT EXISTS runtime_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_version INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  workflow_id TEXT,
  step_id TEXT,
  agent_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
```

Indexes:

- `(task_id, recorded_at)`
- `(run_id, sequence)`
- `(workflow_id, recorded_at)`
- `(event_kind, recorded_at)`

Migration checklist:

- Add `RUNTIME_EVENT_MIGRATIONS` in a desktop persistence module.
- Register those migrations in `apps/desktop/src/App.tsx` with the other
  database migrations.
- Add `runtime_events` to `apps/desktop/src-tauri/src/database.rs`
  `ALLOWED_TABLES`.
- Extend Rust schema validation for the required columns.
- Add known Rust SQL signatures for event insert, replay select, latest-event
  select, and retention prune paths in `require_known_execute_shape()` and
  `require_known_select_shape()`.
- Register index migrations for every index listed above.
- Add tests that allowed `CREATE TABLE` / `CREATE INDEX` statements pass and
  unsafe SQL against the table is still rejected.

### Retention Policy

The event store is append-only for live runs, but not unbounded forever.

- Keep all events for active, waiting, and non-terminal tasks.
- Keep all structural events for completed tasks: task lifecycle, step
  lifecycle, permission, ask-user, replan, tool planned/completed, and artifact
  metadata events.
- Compact high-volume streaming events after terminal state:
  - merge `agent.chunk` sequences into a bounded summary plus hash
  - merge or truncate `tool.partial` output
  - preserve enough metadata to replay UI state and audit tool behavior
- Initial limits:
  - at most 20,000 persisted text characters per compacted stream
  - at most 1,000 retained event rows per terminal task before compaction
  - retain latest checkpoints and the final reconstructed task snapshot
- Retention must never delete events needed to validate a pending approval or
  resume a waiting task.

### Verification

- Unit test event sequencing for a multi-step DAG.
- Unit test that old `TaskRuntimeEvent` payloads still reduce into the same
  `TaskSnapshot`.
- Persistence test that records and reloads an event sequence without losing
  `taskId`, `runId`, `stepId`, or ordering.
- Persistence test that duplicate `(runId, sequence)` writes are rejected.
- Unit test `step.failed` is emitted or enveloped when `onStepFailed` fires.
- Unit test terminal-task compaction preserves structural events and summarizes
  chunk/partial streams.

## Phase 2: ArtifactEnvelope for SharedContext

### Goal

Turn SharedContext values from anonymous key-value data into versioned,
traceable artifacts.

### Proposed Contract

```ts
interface ArtifactEnvelope<T = unknown> {
  artifactId: string;
  type: string;
  schemaVersion: number;

  taskId: string;
  runId: string;
  producer: ArtifactProducerRef;

  createdAt: string;
  contentHash: string;
  hashAlgorithm: "sha256-canonical-json-v1" | "sha256-bytes-v1";

  payload: T;
  sourceRefs?: EvidenceReference[];
  sensitivity?: "public" | "workspace" | "secret";
}

interface ArtifactProducerRef {
  stepId: string;
  agentKind?: string;
  agentId?: string;
  toolName?: string;
}
```

### Implementation Notes

- Add envelope-aware methods to `SharedTaskContext` without removing the current
  `get`, `set`, and `snapshot` behavior immediately.
- Migrate high-value keys first: `diffPreview`, `verificationResult`,
  `uiEvidence`, `computerResult`, and step outputs from Commander DAG execution.
- `validateStepInputContext()` should validate `payload` while preserving
  envelope metadata.
- `buildHandoffReport()` should report producer, consumer, schema, and artifact
  identity when available.
- Secret or sensitive artifacts must not persist raw secret payloads.
- P0 should not introduce a separate artifact table. Persist artifact envelopes
  inside checkpoint/context snapshots and event payloads first. A dedicated
  `runtime_artifacts` table can be evaluated later if artifact lookup,
  retention, or deduplication requires it.

### Persistence Policy

- Persist full payload only for small, structured, non-secret artifacts.
- Persist hash, type, schema version, summary, and `sourceRefs` for large
  artifacts, screenshots, binary data, terminal output, model output, and
  workspace-private evidence.
- Never persist raw secrets, API keys, cookies, credentials, private browser
  data, or unredacted credential diagnostics.
- Apply the same sanitization posture used by task history: cap text length,
  cap array/object size, redact image data URLs, and avoid storing local model
  or generated binary paths unless they are required evidence.
- Store `contentHash` for every artifact, including metadata-only artifacts, so
  checkpoint restore can detect stale or replaced context.
- Hash structured payloads with a stable canonical JSON serializer before
  sanitization/redaction, and store only the hash when the raw payload is too
  large or sensitive. Hash binary payloads from bytes. The hash algorithm must
  be recorded so future schema changes do not silently invalidate old hashes.

Initial thresholds should reuse the existing task-history sanitization posture
unless a stricter artifact-specific limit is needed:

- text payload preview: at most 20,000 characters
- arrays: at most 200 items
- objects: at most 120 enumerable entries
- binary, screenshot, and base64 payloads: never persisted inline
- terminal and model output: persist summary plus hash by default; persist full
  text only when it fits the text limit and is not sensitive

### Verification

- Unit test schema validation for both raw legacy values and enveloped values.
- Unit test handoff reports include artifact provenance.
- Unit test that replan cannot silently overwrite a consumed artifact without
  preserving old/new artifact identity.
- Unit test artifact sanitization for secrets, base64 image data, long terminal
  output, and oversized arrays.
- Unit test direct tool-call artifacts can use `producer.toolName` without a
  fabricated `agentId`.

## Phase 3: WorkflowCheckpoint

### Goal

Persist step-level execution state so a DAG can resume from a known point after
restart.

### Proposed Contract

```ts
interface WorkflowCheckpoint {
  taskId: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  planHash: string;
  workflowSnapshot: WorkbenchWorkflow;

  completedStepIds: string[];
  abandonedStepIds: string[];
  pendingStepIds: string[];
  runningStepIds: string[];

  contextSnapshot: Record<string, ArtifactEnvelope>;
  approvalRequestIds: string[];

  waitingReason?:
    | "human_approval"
    | "user_input"
    | "tool_result"
    | "retry_delay";

  eventSequence: number;
  createdAt: string;
}
```

### Proposed Storage

Store checkpoints separately from `task_history` and derive them from the
append-only event stream:

```sql
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  plan_hash TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  workflow_json TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  UNIQUE(run_id, event_sequence)
);
```

Indexes:

- `(task_id, created_at)`
- `(run_id, event_sequence)`

The latest checkpoint is a fast resume index. The event log remains the
authoritative audit trail.

`workflow_json` stores the normalized executable workflow at the checkpoint,
including replanned steps and abandoned-step state needed to resume dependency
resolution. `plan_hash` alone is not sufficient for restart.

### Checkpoint Triggers

- `step.started`
- `step.completed`
- `step.failed`
- `permission.requested`
- `task.replan_started`
- `task.replan_failed`
- `task.waiting`
- `task.completed`
- `task.failed`
- `task.cancelled`

### Implementation Notes

- `workflow-dag-executor.ts` should remain the source of truth for step status.
- Checkpoints should be generated through lifecycle callbacks rather than by
  duplicating scheduler logic elsewhere.
- Running steps should resume conservatively: after restart, a previously
  running step should usually be treated as pending retry unless the step has a
  completed artifact and matching event sequence.
- P0 automatic resume is limited to checkpoints that are waiting before native
  confirmed-write execution, waiting for user input, or retrying read-only work.
  If the app crashed during or immediately after a native confirmed-write, Javis
  must not assume whether the side effect happened. It should enter a
  reconciliation state, rerun read-only verification, and require a fresh user
  decision before continuing downstream.
- Waiting for approval should restore the approval card first, then link it back
  to the checkpoint.
- `planHash` should change when Commander replan mutates the DAG.
- Recovery treats checkpoints as fast indexes and the append-only event log as
  the audit source of truth. If checkpoint state conflicts with the event log,
  Javis should rebuild the checkpoint from events when possible. If it cannot
  reconcile the conflict safely, it should refuse automatic resume and surface a
  clear recovery error.
- Update native database guard coverage for `workflow_checkpoints` alongside
  `runtime_events`: allowlist, required-column validation, migration
  registration, known insert/select/prune SQL signatures, and SQL guard tests.

### Verification

- Unit test checkpoint state after successful parallel steps.
- Unit test checkpoint state after failure and replan.
- Unit test pending approval checkpoint includes approval request IDs.
- Unit test checkpoint/event-log mismatch either rebuilds or blocks resume.
- Persistence test that records and reloads the latest checkpoint by `runId`.
- Persistence test that duplicate `(runId, eventSequence)` checkpoints are
  rejected.
- Persistence test that native DB guards allow only the intended checkpoint
  insert/select/prune query shapes.
- Unit test crash-after-confirmed-write checkpoints enter reconciliation instead
  of automatically running downstream steps.
- Restart-style QA: start a DAG, reach a durable waiting state, reload, and
  verify the same step can continue without rerunning completed upstream steps.

## Phase 4: Resume Path

### Goal

Use event sequence, artifacts, checkpoints, and durable approvals to resume a
real task safely.

### Minimum Resume Slice

1. Start a Commander DAG with at least three steps:
   - read-only upstream step that writes an artifact
   - confirmed-write preview step that requests approval
   - downstream verification step
2. Persist event envelopes, artifact envelopes, checkpoint, and approval record.
3. Restart the app while waiting for approval.
4. Restore the task with completed upstream step intact.
5. Approve or deny the restored request.
6. Continue the DAG to verified completion or clean denial state.

### Confirmed-Write Restore Rules

After restart, any restored `confirmed_write` operation must recheck all safety
bindings before native execution:

- `approvalId`
- `taskId` and `runId`
- `toolName`
- workspace path
- preview hash
- current file hash or current git head, when the tool depends on repository
  state
- approved operation scope, including paths and requested action
- one-shot native approval consumption

Restoring the UI card is not enough. The native approval binding must still be
valid at execution time, and stale previews must be denied or regenerated.

P0 must also align `runId` with durable approval storage. The implementation
must choose one of:

- add a nullable `run_id` column to `approval_records` and populate it for new
  restored approvals; legacy records without `run_id` may restore only through
  the existing task/tool/workspace/preview-hash checks
- if adding `run_id`, update the desktop approval-record repository, the
  specialized desktop database IPC path, Rust `approval_records_upsert` request
  validation, bind-value count tests, schema validation, and approval-record
  prune/list SQL signatures together
- keep `approval_records` unchanged and derive `approvalId -> runId` from
  `runtime_events` / `workflow_checkpoints`; if the mapping is missing or
  ambiguous, resume must fall back to the existing non-run-scoped approval
  restore path and must not claim run-scoped recovery

New P0 durable-resume QA should use records with an unambiguous `runId`.

### Verification

- Add a focused packaged-app QA script under `docs/qa/YYYY-MM-DD/`.
- The QA evidence must show that completed upstream artifacts were not
  regenerated after restart.
- The final task history entry must include recovery metadata, approval outcome,
  and verifier result.
- QA must include stale-preview denial: modify the target file or git head
  after restart but before approval execution, then verify native execution is
  rejected.
- QA must verify the restored approval is associated with the expected `runId`
  for new P0 records.

## P1 Runtime Intelligence

The following phases are valuable after P0 proves durable resume. They should be
tracked separately from the first checkpoint/resume implementation.

## Phase 5: Progress Ledger and Stuck Detection

### Goal

Give Commander explicit memory of progress and repeated failure patterns before
asking for a replan.

### Proposed Contracts

```ts
interface TaskLedger {
  goal: string;
  facts: string[];
  unknowns: string[];
  assumptions: string[];
  constraints: string[];
  acceptanceCriteria: string[];
}

interface ProgressLedger {
  completed: StepSummary[];
  failed: FailureSummary[];
  blocked: BlockedSummary[];
  currentHypothesis?: string;
  repeatedActions: ActionFingerprint[];
  remainingWork: string[];
}
```

### Stuck Signals

- Same tool fails repeatedly with the same input.
- Same action fingerprint is executed repeatedly with no new artifact.
- Replan returns the same step shape more than once.
- Verifier result does not improve across recovery attempts.
- Multiple steps fail because the same input context key is missing or invalid.

### Required Commander Response

When stuck signals cross the threshold, Commander must choose one of:

- switch tool
- switch agent kind
- narrow the goal
- request user input
- stop with a clear blocked reason

### Verification

- Unit test repeated failed tool calls trigger a different recovery hint.
- Unit test duplicate replan shape is detected.
- Unit test `request_input` failures are classified as handoff failures with
  actionable missing keys.

## Phase 6: WorkspaceRuntime Abstraction

### Goal

Make local, sandbox, disposable-copy, and remote workspaces share one runtime
shape before expanding dynamic sub-agent execution. This is a later-phase
architecture boundary, not a requirement for the first durable resume slice.

### Proposed Contract

```ts
interface WorkspaceRuntime {
  readonly kind: "local" | "sandbox" | "remote";

  readFile(path: string): Promise<Uint8Array>;
  listFiles(path: string): Promise<FileEntry[]>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  createSnapshot(): Promise<WorkspaceSnapshot>;
  diff(snapshot: WorkspaceSnapshot): Promise<WorkspaceDiff>;
  dispose(): Promise<void>;
}
```

### Initial Implementations

- `LocalReadOnlyWorkspace`
- `DisposableCopyWorkspace`
- `WindowsSandboxWorkspace`

Remote workspace support should remain a later phase unless a concrete product
workflow requires it.

### Verification

- Unit test that Code, Shell, and Git paths resolve through the runtime boundary.
- Rust safety tests must still enforce path containment and approval binding for
  write-capable operations.
- Sandbox QA must prove workspace cleanup and diff extraction.

## Suggested Priority

P0 order:

1. Dedicated append-only runtime event table and envelope persistence.
2. `step.failed` event coverage for DAG failure replay.
3. ArtifactEnvelope-compatible SharedContext.
4. WorkflowCheckpoint table generated from DAG lifecycle.
5. Approval-aware resume path.

P1 follow-up order:

1. Progress ledger and stuck detection.
2. WorkspaceRuntime abstraction.
3. Read-only dynamic sub-agent delegation.

Dynamic sub-agent delegation should wait until the durable runtime slice is
working. Sub-agents should initially be limited to read and preview operations;
confirmed-write execution should remain parent-coordinated.

## Acceptance Criteria

- A DAG task can restart from a checkpoint without rerunning completed upstream
  steps.
- Restored approvals are linked to a checkpoint and still require native
  approval binding before execution.
- Stale restored approvals are rejected when preview hash, workspace path,
  current file hash, current git head, tool name, task/run binding, or approved
  operation scope no longer matches.
- SharedContext artifacts record producer step, agent, schema version, content
  hash, and sensitivity.
- P0 artifact envelopes are persisted through checkpoint/context snapshots or
  event payloads; no separate artifact table is required for the first slice.
- Replan can distinguish old artifacts from new recovery artifacts.
- Runtime events are replayable in order for a single `runId`.
- Terminal event streams are compacted without losing structural audit events.
- Checkpoint restore is derived from or reconciled with the append-only event
  log; unreconciled conflicts block automatic resume.
- Checkpoints persist the normalized executable workflow snapshot, not only the
  plan hash.
- Crash-after-confirmed-write states do not auto-run downstream steps; they
  enter explicit reconciliation.
- Native database allowlists and schema guards explicitly cover
  `runtime_events` and `workflow_checkpoints`.
- Native database known SQL-shape guards explicitly cover the insert/select/prune
  paths used by runtime events and checkpoints.
- Existing task snapshot UI and logs continue to render during migration.
- `pnpm check` passes after non-document implementation changes.
- Restart QA evidence is stored under `docs/qa/YYYY-MM-DD/`.

## Risks

- Adding checkpoints without event sequencing can create two competing sources
  of truth.
- Persisting artifacts without sensitivity labels can accidentally store secrets
  or private workspace data.
- Resuming a previously running step too aggressively can duplicate writes or
  tool side effects.
- Treating `recordedAt` as the event occurrence time can make replay and
  timeout analysis misleading.
- Persisting a checkpoint without the executable workflow snapshot can make
  replan recovery impossible after restart.
- Overbuilding WorkspaceRuntime before the resume path is proven can spread the
  migration across too many modules.
- Adding dynamic sub-agents before artifact provenance is stable can make
  conflicts and stale context harder to debug.

## Open Questions

- What is the smallest stable `planHash` input: full Commander DAG JSON, sorted
  step IDs plus dependencies, or normalized executable workflow?
- Which artifacts are safe to persist by default, and which should persist only
  metadata plus redacted previews?
- Should a restored running step always retry, or should some read-only steps be
  resumable from artifact hash alone?
- How much of the checkpoint should be visible in the Inspector UI during the
  first release?
