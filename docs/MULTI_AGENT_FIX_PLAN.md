# Multi-Agent Collaboration Fix Plan

Last updated: 2026-05-26

> **Status: ALL 9 FIXES RESOLVED** as of 2026-05-26. This document is retained
> as a historical record of the specific changes that brought Javis from a
> single-task role router to a working multi-agent system.

This document is the concrete, code-level companion to `IMPROVEMENT_PLAN.md`.
It names each broken piece with file:line references and proposes the minimal
change. The IMPROVEMENT_PLAN covers *phases and architecture*; this covers
*specific bugs and the smallest code change that fixes them*.

## Resolution Summary

| Fix | Description | Status |
| --- | --- | --- |
| Fix 1 | Tool name mismatch (web.search, shell.runReadOnlyCommand) | Resolved |
| Fix 2 | Commander has no tools — `commander.plan` added | Resolved |
| Fix 3 | No agent has an LLM — `systemPrompt` field added (bilingual) | Resolved |
| Fix 4 | Verifier has no tools — `verifier.check` added | Resolved |
| Fix 5 | WorkbenchWorkflows are dead code — `workflow-executor.ts` created | Resolved |
| Fix 6 | Only single-route — `getTopRoutes()` and `getRecommendedWorkflowIds()` added | Resolved |
| Fix 7 | No shared context — `SharedTaskContext` with bilingual keys created | Resolved |
| Fix 8 | Single pendingPermissionHandler — replaced with Map keyed by request ID | Resolved |
| Fix 9 | Hardcoded agent snapshots — `AgentStateTracker` created | Resolved |

---

## Problem 0: The Theater vs. The Actors

The single sentence summary: **Javis has 8 agent definitions, 5 flow functions,
14 tool descriptors, and a beautiful UI — but agents never run.** The flow
functions call tools directly, bypassing the agents entirely. Agent snapshots are
hardcoded strings, not the output of any agent execution loop.

The fixes below are ordered so each one unblocks the next.

---

## Fix 1: Tool Name Mismatch — Research Agent Can't Use Its Tools

### The bug

`packages/core/src/agents.ts:30`:
```typescript
allowedToolNames: ["web.searchSources", "web.fetchSource"],
```

`packages/tools/src/descriptors.ts:20`:
```typescript
{ name: "web.search", ... }
```

The agent allows `web.searchSources`. The tool is registered as `web.search`.
Any permission check comparing agent allowed tools against tool descriptors will
fail for the research agent's primary tool.

### The fix

```diff
// packages/core/src/agents.ts — research agent
- allowedToolNames: ["web.searchSources", "web.fetchSource"],
+ allowedToolNames: ["web.search", "web.fetchSource"],
```

Also audit `packages/tools/src/descriptors.ts` — there is no `shell.runReadOnlyCommand`
descriptor, but the Code Agent and Shell Agent reference it:

```diff
// packages/tools/src/descriptors.ts — add missing descriptor
+  {
+    name: "shell.runReadOnlyCommand",
+    permissionLevel: "read",
+    summary: "Run an allowlisted read-only shell command.",
+  },
```

### Validation

```bash
# After fix: every agent.allowedToolNames entry must appear in descriptors
grep -r "allowedToolNames" packages/core/src/agents.ts
grep -r '"name"' packages/tools/src/descriptors.ts
```

---

## Fix 2: Commander Has No Tools — Give It the Model Provider

### The bug

`packages/core/src/agents.ts:5-9`:
```typescript
{
  id: "agent-commander",
  kind: "commander",
  allowedToolNames: [],  // Cannot do anything
}
```

The Commander is supposed to "plan and orchestrate" but can't call any tool
or LLM. Every flow function currently hardcodes the commander message:

```typescript
// index.ts:470 — hardcoded string, not Commander output
commanderMessage:
  "Commander identified a code review goal and will collect a diff preview...",
```

### The fix (incremental)

**Step A**: Give the Commander access to a `commander.plan` tool that wraps the
Model Provider (see Fix 3):

```typescript
// packages/core/src/agents.ts
{
  id: "agent-commander",
  kind: "commander",
  allowedToolNames: ["commander.plan"],
}
```

**Step B**: Define the tool descriptor:

```typescript
// packages/tools/src/descriptors.ts
{
  name: "commander.plan",
  permissionLevel: "read",
  summary: "Analyze user goal and produce a task plan with assigned agent steps.",
}
```

**Step C**: Add a `CommanderTool` interface:

```typescript
// packages/tools/src/types.ts
export interface CommanderTool {
  plan(request: {
    userGoal: string;
    availableAgents: Array<{ kind: AgentKind; allowedToolNames: string[] }>;
    workspaceContext?: { hasGitChanges: boolean; hasPackageJson: boolean };
  }): Promise<{
    title: string;
    steps: Array<{
      id: string;
      title: string;
      assignedAgentKind: AgentKind;
      successCriteria: string;
    }>;
    reasoning: string;
  }>;
}
```

**Step D**: In the runtime's `start()`, instead of jumping directly to a
hardcoded flow, call `commanderTool.plan()` first and use its output to
drive the plan. Fall back to keyword routing only when the Commander tool is
unavailable or the model call fails.

```typescript
// packages/core/src/index.ts — inside start()
async start(userGoal) {
  // ...
  if (commanderTool) {
    try {
      const plan = await commanderTool.plan({
        userGoal,
        availableAgents: demoAgents.map(a => ({
          kind: a.kind,
          allowedToolNames: a.allowedToolNames,
        })),
        workspaceContext: { hasGitChanges, hasPackageJson },
      });
      // Use plan.steps to dynamically route to agents
      // instead of hardcoded keyword routing
    } catch {
      // Fall back to keyword routing
    }
  }
  // ...existing keyword routing as fallback
}
```

---

## Fix 3: No Agent Has an LLM — Add Model Provider Binding

### The bug

The `Agent` interface has no model binding. Only `CodeAgent.proposeEdit` goes
through an LLM, and that's wired in `app-runtime.ts`, not in the agent system.

```typescript
// packages/core/src/index.ts:146-153
export interface Agent {
  id: ID;
  kind: AgentKind;
  displayName: string;
  description: string;
  allowedToolNames: string[];
  preferredModelTags?: string[];  // Defined but never used
}
```

### The fix

Extend the Agent interface with a system prompt and model binding:

```typescript
// packages/core/src/index.ts
export interface Agent {
  id: ID;
  kind: AgentKind;
  displayName: string;
  description: string;
  allowedToolNames: string[];
  preferredModelTags?: string[];
  // NEW — what actually makes the agent think
  systemPrompt: string;
  modelProfileId?: ID;
}
```

Add system prompts to each demo agent:

```typescript
// packages/core/src/agents.ts
export const demoAgents: Agent[] = [
  {
    id: "agent-commander",
    kind: "commander",
    displayName: "Commander",
    description: "Task planning and orchestration",
    allowedToolNames: ["commander.plan"],
    systemPrompt: `You are the Commander. Your job is to analyze the user's goal
and decompose it into concrete steps. For each step, assign the best agent kind
(file, shell, code, research, computer, scheduler, verifier). Return a plan with
step IDs, titles, assigned agent kinds, and success criteria. Do NOT execute
steps yourself — only plan them.`,
  },
  {
    id: "agent-code",
    kind: "code",
    displayName: "Code Agent",
    description: "Repository diff preview, proposed edits, and verification",
    allowedToolNames: [
      "code.inspectRepository",
      "code.proposeEdit",
      "code.applyProposedEdit",
      "shell.runReadOnlyCommand",
    ],
    systemPrompt: `You are the Code Agent. You inspect git repositories,
review diffs, and propose edits. Never apply edits without user approval.
Always run read-only verification (git diff --check) before proposing changes.`,
  },
  {
    id: "agent-verifier",
    kind: "verifier",
    displayName: "Verifier",
    description: "Evidence and completion checks",
    allowedToolNames: ["verifier.check"],
    systemPrompt: `You are the Verifier. Your job is to check that every step's
output matches its success criteria. For each piece of evidence, state whether
it PASSES, WARNS, or FAILS. Be specific about what's missing or wrong.`,
  },
  // ...same for file, shell, research, computer, scheduler
];
```

---

## Fix 4: Verifier Has No Tools — Give It a Check Tool

### The bug

`packages/core/src/agents.ts:64-69`: Verifier has `allowedToolNames: []`.
All "verification" is hardcoded field-completeness checks like:

```typescript
// index.ts:1294-1300 — this is not the Verifier agent, it's inline code
const validCount = sources.filter((source) => source.url && source.excerpt).length;
const verificationStatus =
  validCount === sources.length && reportEvidenceCount === researchReport.rows.length
    ? "completed"
    : "failed";
```

### The fix

Add a `verifier.check` tool that wraps an LLM call:

```typescript
// packages/tools/src/types.ts
export interface VerifierTool {
  check(request: {
    stepId: string;
    successCriteria: string;
    evidence: Array<{
      kind: "file" | "command" | "source" | "log" | "permission";
      label: string;
      data: unknown;
    }>;
  }): Promise<{
    status: "pass" | "warn" | "fail";
    summary: string;
    detail: string;
  }>;
}
```

```typescript
// packages/tools/src/descriptors.ts
{
  name: "verifier.check",
  permissionLevel: "read",
  summary: "Check evidence against success criteria and produce a pass/warn/fail verdict.",
}
```

Then in each flow function, replace the inline `if (validCount === ...)` checks
with a call to `verifierTool.check()`.

---

## Fix 5: WorkbenchWorkflows Are Dead Code — Add an Executor

### The bug

`packages/core/src/workflows.ts` defines 5 multi-agent workflows with detailed
step definitions, dependency graphs, and parallel execution hints. But there is
no function that executes them. They are never imported by the runtime.

### The fix

Add a workflow executor in a new file:

```typescript
// packages/core/src/workflow-executor.ts

import type { WorkbenchWorkflow, WorkbenchWorkflowStep } from "./workflows";
import type { TaskSnapshot, AgentKind, TaskStep } from "./index";
import type { FlowController } from "./file-scan-flow";

interface WorkflowExecutorOptions {
  workflow: WorkbenchWorkflow;
  controller: FlowController;
  taskId: string;
  userGoal: string;
  // Tool implementations keyed by agent kind
  executeStep: (
    step: WorkbenchWorkflowStep,
    context: SharedTaskContext,
  ) => Promise<{ output: unknown; error?: string }>;
}

export async function executeWorkflow({
  workflow,
  controller,
  taskId,
  userGoal,
  executeStep,
}: WorkflowExecutorOptions) {
  const context = createSharedTaskContext();
  const completed = new Set<string>();
  const results = new Map<string, unknown>();

  // Convert workflow steps to TaskStep plan for UI
  const plan: TaskStep[] = workflow.steps.map((s) => ({
    id: s.id,
    title: s.title,
    assignedAgentKind: s.agentKind,
    status: "pending",
    successCriteria: s.output,
  }));

  // Emit initial plan
  controller.emit(buildPlanningSnapshot(taskId, userGoal, workflow, plan));

  // Execute steps respecting dependency order and parallelism
  while (completed.size < workflow.steps.length) {
    const ready = workflow.steps.filter(
      (s) =>
        !completed.has(s.id) &&
        s.dependsOn.every((dep) => completed.has(dep)),
    );

    if (ready.length === 0) {
      // Should not happen with valid DAG, but guard against cycles
      throw new Error("Workflow deadlock: no ready steps but not all completed");
    }

    // Group by canRunInParallel
    const parallelGroup = ready.filter((s) => s.canRunInParallel);
    const serialSteps = ready.filter((s) => !s.canRunInParallel);

    // Execute parallel steps concurrently
    if (parallelGroup.length > 0) {
      const parallelResults = await Promise.allSettled(
        parallelGroup.map((step) => executeStep(step, context)),
      );
      for (const [i, result] of parallelResults.entries()) {
        const step = parallelGroup[i];
        if (result.status === "fulfilled") {
          results.set(step.id, result.value.output);
          completed.add(step.id);
        } else {
          // Mark step as failed, continue or abort based on workflow policy
          completed.add(step.id);
        }
      }
    }

    // Execute serial steps one at a time
    for (const step of serialSteps) {
      try {
        const result = await executeStep(step, context);
        results.set(step.id, result.output);
        completed.add(step.id);
      } catch (error) {
        // Emit failure and stop
        controller.emit(buildFailedSnapshot(/*...*/));
        return;
      }
    }
  }

  // Final verification
  controller.emit(buildCompletedSnapshot(/*...*/));
}
```

Then wire it into the runtime's `start()` as the primary path when a workflow
matches the user goal, falling back to the existing keyword-routed single flows
for backward compatibility.

---

## Fix 6: Keyword Routing Can't Combine Agents — Add Multi-Route Support

### The bug

`packages/core/src/routing.ts:55-60`:
```typescript
export function getTopRoute(...): RouteScore | undefined {
  const [topRoute] = scoreRoutes(userGoal, context);
  return topRoute && topRoute.score >= ROUTE_THRESHOLD ? topRoute : undefined;
}
```

Only the single highest-scoring route is returned. A goal like "review my code
changes and research the libraries I'm using" can only route to code OR
research, never both.

### The fix

```typescript
// packages/core/src/routing.ts — add alongside getTopRoute
export function getTopRoutes(
  userGoal: string,
  context?: RouteScoringContext,
  maxRoutes = 3,
): RouteScore[] {
  return scoreRoutes(userGoal, context)
    .filter((r) => r.score >= ROUTE_THRESHOLD)
    .slice(0, maxRoutes);
}
```

In the runtime's `start()`, when multiple routes score above threshold, use the
Commander (once Fix 2 is done) to decide how to combine them, or run them
sequentially with shared context. For the pre-Commander fallback, chain the
flows: run the first flow, feed its output into the second flow's input via
`SharedTaskContext` (see Fix 7).

---

## Fix 7: No Shared Context Between Agents — Add a Task Blackboard

### The bug

Each flow function is a closed scope. A file scan's output cannot be consumed
by a code review in the same task. The `AgentRun.inputSummary` and
`outputSummary` are strings that no code populates from real agent output.

### The fix

```typescript
// packages/core/src/shared-context.ts

export interface SharedTaskContext {
  set<T>(key: string, value: T): void;
  get<T>(key: string): T | undefined;
  snapshot(): Record<string, unknown>;
  clear(): void;
}

export function createSharedTaskContext(): SharedTaskContext {
  const store = new Map<string, unknown>();
  return {
    set(key, value) { store.set(key, value); },
    get(key) { return store.get(key) as unknown; },
    snapshot() { return Object.fromEntries(store); },
    clear() { store.clear(); },
  };
}
```

Inject this into every flow function. When File Agent finishes scanning, it
writes to the context:

```typescript
context.set("fileScan", { documents, count: documents.length });
```

When Code Agent starts, it reads:

```typescript
const fileScan = context.get<{ documents: MarkdownDocumentSummary[] }>("fileScan");
```

This is the minimal "blackboard" pattern. It doesn't need to be persisted
(per-task lifecycle only). It should be serialized into task audit logs so
the evidence chain is traceable.

---

## Fix 8: Single pendingPermissionHandler — Scoped to Task

### The bug

`packages/core/src/index.ts:383`:
```typescript
let pendingPermissionHandler: PendingPermissionHandler | undefined;
```

This is a single closure variable. If multiple agents needed permissions
concurrently (which they will once Fix 5 enables parallel execution), the
second agent would overwrite the first's handler.

### The fix

Use a Map keyed by permission request ID:

```typescript
// packages/core/src/index.ts
const permissionHandlers = new Map<string, PendingPermissionHandler>();

// When creating a permission request:
permissionHandlers.set(request.id, handler);

// In resolvePermission:
resolvePermission(decision: "approved" | "denied", requestId?: string) {
  if (requestId) {
    const handler = permissionHandlers.get(requestId);
    permissionHandlers.delete(requestId);
    void handler?.(decision);
    return;
  }
  // Legacy fallback: resolve the only pending handler
  const [only] = [...permissionHandlers.values()];
  if (only) {
    permissionHandlers.clear();
    void only(decision);
  }
}
```

Update `TaskRuntime.resolvePermission` to accept an optional `requestId`:

```typescript
export interface TaskRuntime {
  // ...
  resolvePermission(decision: "approved" | "denied", requestId?: string): void;
}
```

---

## Fix 9: Agent Snapshots Are Hardcoded Strings — Derive from Agent State

### The bug

Every flow function has lines like:
```typescript
agents: [
  commanderSnapshot("completed", "Plan submitted"),
  codeSnapshot("running", "Collecting repository diff preview"),
  verifierSnapshot("queued", "Waiting for diff evidence"),
],
```

These strings are manually written and have no connection to actual agent
execution state.

### The fix

Create an `AgentStateTracker` that holds the canonical agent states during a
task and produces snapshots from real state:

```typescript
// packages/core/src/agent-state-tracker.ts

interface AgentState {
  agentId: string;
  status: AgentRunStatus;
  task: string;
  currentStepId?: string;
  startedAt?: string;
}

export function createAgentStateTracker(agents: Agent[]) {
  const states = new Map<string, AgentState>(
    agents.map((a) => [a.id, {
      agentId: a.id,
      status: "queued" as const,
      task: "Waiting",
    }]),
  );

  return {
    setState(agentId: string, update: Partial<AgentState>) {
      const current = states.get(agentId);
      if (current) states.set(agentId, { ...current, ...update });
    },
    getSnapshots(): AgentSnapshot[] {
      return [...states.values()].map((s) => {
        const agent = agents.find((a) => a.id === s.agentId)!;
        return {
          id: agent.id,
          name: agent.displayName,
          role: agent.description,
          status: s.status,
          task: s.task,
        };
      });
    },
    reset() {
      for (const state of states.values()) {
        state.status = "queued";
        state.task = "Waiting";
      }
    },
  };
}
```

Then in the workflow executor, call `tracker.setState("agent-code", { status: "running", task: "Collecting diff..." })` when the code agent step actually starts executing. The UI snapshot derives from the tracker, not from hand-written strings.

---

## Dependency Order of Fixes

```
Fix 1 (tool names)    Fix 7 (shared context)
       |                      |
       v                      v
Fix 3 (model binding)  Fix 5 (workflow executor)
       |                      |
       v                      v
Fix 2 (Commander tool) Fix 6 (multi-route)  Fix 8 (permission map)
       |                      |                      |
       +----------+-----------+----------------------+
                  |
                  v
          Fix 4 (Verifier tool)
                  |
                  v
          Fix 9 (agent state tracker)
```

Fixes 1, 3, 7, 8 are independent and can be done in parallel.
Fixes 2, 4 depend on 3.
Fix 5 depends on 7.
Fix 6 depends on 2.
Fix 9 depends on 5.

---

## The Smallest "It Works" Milestone

If you can only do ONE thing to prove multi-agent collaboration works, do this:

1. **Fix 3** — Add `systemPrompt` to each agent + a `ModelProvider` interface
2. **Fix 5** — Implement `executeWorkflow()` for the simplest workflow:
   `read-current-project` (it uses only `read` permission tools)
3. **Fix 7** — Shared context so File Agent's output feeds into Code Agent

With just these three, the `read-current-project` workflow will actually:
- Run File Agent (scan workspace) → write results to shared context
- Run Shell Agent (inspect scripts) in parallel with File Agent
- Run Code Agent (analyze structure) consuming both outputs
- Run Verifier (produce summary) consuming all previous outputs

That's a working multi-agent pipeline. The other fixes are hardening and
correctness.
