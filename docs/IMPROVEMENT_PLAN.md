# Improvement Plan

Last updated: 2026-05-26

> **Companion documents**:
> - [MULTI_AGENT_FIX_PLAN.md](./MULTI_AGENT_FIX_PLAN.md) — specific bugs with
>   file:line references and minimal code fixes.
> - [CHINESE_OPTIMIZATION.md](./CHINESE_OPTIMIZATION.md) — two-layer strategy
>   for Chinese-native agent output (prompt layer + system prompt layer).

This document records the architectural improvement path for Javis after the
current codebase review. The central finding is that Javis is architecturally
ready for multi-agent work, but its current runtime is still closer to
single-task serial role routing than true multi-agent collaboration.

**Status as of 2026-05-26**: Phases 1.1-1.3 complete. Phase 2.1 complete
(ModelProvider in desktop layer). Phase 2.2 partially complete (multi-route
scoring exists, weighted scoring not yet). Phase 2.3 (SQLite) not started.
Phase 3.3 (shared context) complete. Phase 3.5 (DAG executor) implemented.
Phase 4.1 (streaming events) infrastructure complete, Tauri SSE in progress.

The goal is not to add parallelism early. The safer path is to first strengthen
the foundation: modular runtime boundaries, reusable write approval, durable
state, model access, and explicit state transitions. Multi-agent scheduling can
sit on top of that once the single-task core is reliable.

## Current Diagnosis

Javis currently behaves as a single-task role router:

- `routing.ts` still uses rule-based route checks, although PDF routing has
  already been tightened to require file or PDF context and avoid broad false
  positives such as a Chinese request meaning "organize my thoughts".
- `plans.ts` defines static linear `TaskStep[]` plans.
- `createFileScanTaskRuntime` chooses one task flow and runs it serially.
- Agent metadata in `agents.ts` describes identity and allowed tools, but the
  real capabilities still live inside task-flow functions.
- Model access now covers Commander planning, Verifier checks, Chinese review,
  and Code Agent proposal generation. Commander-driven routing falls back to
  keyword routing when the model call fails.

Recent cleanup has already started reducing the largest files:

- `packages/core/src/pdf-organization-flow.ts` now owns the PDF organization
  task flow.
- `apps/desktop/src/App.tsx` has been split into runtime, workspace, model, and
  restored-approval modules.
- `packages/ui/src/index.tsx` is now a public export surface, with workbench
  components split into smaller files.
- `packages/tools/src/index.ts` is now a public export surface, with contracts,
  descriptors, and Markdown helpers split out.

That means the next work should continue the same pattern: small, verifiable
extractions and infrastructure changes, not a large scheduler rewrite.

## Non-Negotiable Safety Constraints

These constraints apply to every later phase:

- Model calls may propose or classify work, but must not bypass the permission
  system.
- Every write path must go through confirmed-write approval and the native
  boundary checks.
- Tool calls should remain auditable: inputs, outputs, permission decisions,
  affected paths, and verification results must be recoverable after the fact.
- Multi-agent parallelism must not create hidden writes or unreviewed state
  transitions.
- Streaming should expose user-visible events, evidence, summaries, and tool
  progress, not private model reasoning.

## Phase 1: Foundation (P0) — Mostly Complete

### 1.1 Continue Splitting `packages/core/src/index.ts` — Partial

`index.ts` has already been reduced, but it is still too large and still mixes
route dispatch, task execution, permission handling, and verification.

Target structure:

```text
packages/core/src/
  index.ts              # public API re-exports only
  runtime.ts            # createFileScanTaskRuntime factory
  tasks/
    file-scan.ts        # document scan flow
    project-inspect.ts  # project inspection flow
    research.ts         # URL and search-backed research flows
    pdf-org.ts          # PDF organization flow
    code-review.ts      # code review and code patch flow
  permission/
    confirmed-write.ts  # reusable confirmed-write pipeline
  state/
    task-state.ts       # transition helpers and validation
```

Do this incrementally. Each extraction should keep behavior unchanged and be
covered by the existing runtime tests.

### 1.2 Add Generic Confirmed-Write Middleware — Complete

This is the highest-return safety refactor. Rust already shares native approval
binding behavior, but TypeScript still has separate approval/execute/verify
loops for PDF organization and Code Patch application.

Introduce a shared pipeline that every future write tool can use:

```typescript
async function executeWithApproval<T>(params: {
  toolName: string;
  dryRun: DryRunSummary;
  requestPermission: (dryRun: DryRunSummary) => Promise<ApprovalDecision>;
  execute: (approvalId: string) => Promise<T>;
  verify: (result: T) => Promise<VerificationResult>;
}): Promise<T>;
```

The first implementation should support only the existing PDF and Code Patch
flows. Avoid designing for hypothetical tools until the two real flows are
using the same abstraction.

### 1.3 Introduce Task Transition Helpers — Complete

Nine task statuses exist today, but transitions are still scattered across task
flows. A full state machine can be useful, but the first version should be
conservative: centralize transition helpers and tests before enforcing every
edge.

Start with helpers such as:

```typescript
function transitionTask(
  snapshot: TaskSnapshot,
  nextStatus: TaskStatus,
  details?: { updatedAt?: string },
): TaskSnapshot;
```

Then add tests for real flows:

- created -> planning -> running -> completed
- running -> waiting_permission -> running -> verifying -> completed
- waiting_permission -> completed when the user denies a write
- waiting_permission -> failed when restored approval execution fails
- running/verifying -> failed
- terminal states do not re-enter running flows

Do not blindly implement a narrow transition table until restored approvals,
denials, retries, and cancellations are represented.

## Phase 2: Core Infrastructure (P1) — Partially Complete

### 2.1 Unified Model Provider Abstraction — Complete

This should come before Commander LLM routing. Today model settings are wired
only into opencode-based Code Agent proposal generation. A shared provider
interface lets any agent request model output through one audited path.

```typescript
interface ModelProvider {
  id: string;
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
  stream?(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionChunk>;
}
```

Keep the first implementation narrow:

- Wrap the existing provider/model/base URL settings.
- Preserve opencode as the Code Agent backend.
- Do not create a second unaudited model invocation path.
- Keep API keys in the existing native secret storage path.

### 2.2 Multi-Signal Route Scoring — Partial

Rule routing should evolve before model routing. The short-term goal is not an
LLM router; it is fewer false positives and more explainable route choices.

```typescript
interface RouteScore {
  route: "pdf" | "code" | "research" | "project" | "file-scan";
  score: number;
  signals: string[];
}
```

Signals should combine explicit user intent with lightweight context:

- PDF: `pdf`, file organization wording, Downloads/file context.
- Code: review/diff/patch wording, git status context.
- Research: URL presence, research/search/source wording.
- Project: package scripts, test/start/environment wording.
- File scan: document/Markdown/workspace scan wording.

If no route clears a threshold, fall back to the safe file-scan/default flow or
ask for clarification once Commander model calls exist.

### 2.3 SQLite Persistence — Not Started

`task-history.ts`, `approval-records.ts`, `recent-workspaces.ts`, and
`model-settings.ts` currently rely on localStorage. That is acceptable for small
session preferences, but not for durable task and audit records.

Move durable records into SQLite through the Tauri SQL plugin or another
approved local database layer:

- tasks
- agent runs
- tool calls
- approvals
- verification records
- settings metadata

Migration needs to be explicit:

- Keep backward-compatible import from current localStorage keys.
- Add schema versions.
- Preserve approval recovery behavior.
- Keep secrets in native secret storage, not SQLite.

## Phase 3: Agent Architecture (P2) — Partially Complete

### 3.1 Agent Capability Registry — Not Started

Do not introduce heavy schema machinery too early. The current TypeScript tool
contracts are enough for now. Start with a lightweight registry that decouples
agent capabilities from task-flow functions:

```typescript
interface AgentCapability {
  id: string;
  kind: AgentKind;
  requiredTools: string[];
  produces: string[];
  consumes: string[];
  permissionLevel: PermissionLevel;
  canRunInParallel: boolean;
  preferredModels?: string[];
}
```

Add Zod input/output schemas later, when third-party plugins or dynamic agent
registration make runtime validation necessary.

Initial product workflow blueprints now live in
`packages/core/src/workflows.ts`. They translate the target workbench scenarios
into structured Commander-led collaborations:

- read current project
- research trending topics
- plan a Spring Boot project
- find a local document
- create a daily reminder

Treat these as scheduler inputs and UI/documentation source data. They are not
yet a general DAG executor, and they should not bypass the existing route,
permission, tool-call, or verification paths.

### 3.2 Standardize Agent -> Tool Call -> Tool — Partial

Task flows currently call `fileTool`, `shellTool`, `codeTool`, and `webTool`
directly. Move toward a single tool-call path so logging, retries, permission
checks, and audit records are consistent.

This should be implemented before a task graph scheduler. A DAG scheduler is
much easier to reason about if every node emits the same tool-call records.

### 3.3 Shared Task Context — Complete

Agents need a lightweight per-task context so one flow can consume another
flow's output without going through UI props.

```typescript
interface SharedTaskContext {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  snapshot(): Record<string, unknown>;
}
```

This is not long-term memory. It should be cleared per task and persisted only
as part of task audit state.

### 3.4 Commander LLM Routing — Complete

Commander-driven routing is valuable, but it depends on the unified Model
Provider. Once that exists, Commander can choose routes from the available
agent list.

Rules should remain:

- Regex/scoring router stays as a fast path for unambiguous goals.
- Commander routing is used for ambiguous or multi-intent goals.
- The Commander can select routes and propose a plan, but cannot bypass
  permission checks.

### 3.5 Task Graph (DAG) — Complete

Task Graph should stay P2, not P1. The current product risk is single-task
reliability and provider QA, not lack of parallelism.

When the foundation is ready, replace linear plans with a dependency graph:

```typescript
interface TaskNode {
  id: string;
  agentKind: AgentKind;
  dependsOn: string[];
  action: string;
}
```

Start with a serial graph that mirrors today's behavior. Only add parallel
branches after state transitions, tool-call records, and shared context are
stable.

## Phase 4: Experience and Advanced Runtime (P3) — In Progress

### 4.1 Streaming Events — In Progress

Move from snapshot-only updates toward streaming event updates:

- task status changes
- agent run status
- tool call started/completed
- permission requested/resolved
- verification events
- user-visible model summaries or streamed final text

Avoid presenting private model reasoning as a product feature.

### 4.2 Multi-Task UI

Once the runtime supports multiple active tasks or a task graph, the UI should
support multiple task panels/tabs instead of one global current task.

### 4.3 Agent Collaboration Visualization

Show dependency graph nodes, active agents, blocked approvals, and completed
branches. This should reflect real scheduler state rather than a decorative
diagram.

### 4.4 Tool Call Detail Panel and Approval Queue

Logs should become structured, expandable tool-call records. If multiple
parallel branches request approval, approvals should appear in a queue rather
than blocking only the current task view.

### 4.5 Sandbox Mode

For exploratory write tasks, support execution in a temporary workspace before
touching the real project. This depends on the confirmed-write middleware and
native path guards being generalized.

## Deferred Until the Core Is Product-Ready

These should not distract from the foundation:

- Plugin marketplace
- Long-term agent memory or vector database
- Cross-device control
- Editable visual agent graph
- Production deployment automation beyond basic CI

Long-term memory is useful, but it should come after durable task/audit storage
and explicit user controls for retention and deletion.

## Revised Priority Order

| Priority | Work | Reason |
| --- | --- | --- |
| P0 | Generic confirmed-write middleware | Highest ROI safety abstraction; Rust already has shared binding behavior |
| P0 | Continue splitting `core/index.ts` | Still the largest maintainability bottleneck |
| P1 | Unified Model Provider abstraction | Prerequisite for Commander routing and model-enabled agents |
| P1 | Multi-signal route scoring | Improves routing now without adding model risk |
| P1 | SQLite persistence | localStorage is not enough for durable audit and migration |
| P2 | Task transition helpers/state machine | Needed before complex scheduling; must model real restored approval flows |
| P2 | Agent registry and standardized tool calls | Prepares plugin-style agents without heavy schema overdesign |
| P2 | Commander LLM routing | Depends on Model Provider |
| P2 | Task Graph and parallel agents | Valuable, but only after single-task reliability is solid |
| P3 | Streaming events and multi-panel UI | UX layer on top of stable runtime events |
| P3 | Sandbox mode | Advanced safety mode after write pipeline is generalized |

## Dependency Map

```text
P0 Foundation
  confirmed-write middleware
  core runtime split
  transition helpers
        |
        v
P1 Infrastructure
  Model Provider  ---> Commander LLM routing
  route scoring   ---> safer rule fallback
  SQLite          ---> durable audit / task recovery
        |
        v
P2 Agent Architecture
  capability registry
  standardized tool-call path
  shared task context
  task graph scheduler
        |
        v
P3 Experience
  streaming events
  multi-task UI
  collaboration graph
  approval queue
  sandbox mode
```
