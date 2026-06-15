# Commander DAG Plan Compiler Plan

## Background

Commander currently asks the model to produce a DAG-like JSON plan, normalizes that plan, then passes it into the workflow executor. This has worked for basic cases, but recent failures show that the boundary between "model output" and "executable workflow" is too soft.

Two recent examples exposed weak boundaries in adjacent parts of the runtime:

- `computer.listDirectory` was planned without `toolInput.path`, so execution failed only after tool dispatch.
- Ask-user answers were preserved in two runtime layers, creating duplicate user response messages after clicking a clarification choice.

The first issue is a planning contract problem. The second is a runtime state boundary problem. They are not the same bug, but they point to the same engineering rule: data crossing a subsystem boundary needs a clear owner and validation point. This document focuses on the planning side: Commander DAG output should be compiled before execution, not trusted directly.

## Current Problems

The Commander DAG contract is currently represented in several places:

- `packages/core/src/commander-plan-schema.ts`
  - `CommanderDagStep`
  - `CommanderDagPlan`
  - `COMMANDER_PLAN_SCHEMA_JSON`
  - `COMMANDER_PLAN_SCHEMA_PROMPT`
- `apps/desktop/src/app-runtime.ts`
  - `normalizeCommanderPlan`
  - `commanderPromptToolDescriptors`
- `packages/core/src/workflow-executor.ts`
  - `normalizeCommanderDagPlan`
  - `executeCapabilityStep`
  - `dispatchToolByName`
  - DAG execution and failure replan handling
- `packages/tools/src/descriptors.ts`
  - tool availability, ownership, capabilities, and short planner summaries

These definitions are related, but not a single source of truth. For example, `requiredCapabilities` and `dependsOn` are present on the TypeScript DAG shape used by execution, but the prompt/schema allow them to be omitted and normalization fills defaults.

That kind of normalization is useful for compatibility, but unsafe when it hides semantic planning errors.

## Goal

Introduce a Commander plan compilation boundary:

```text
raw model output
  -> JSON extraction
  -> structural normalization
  -> DAG semantic validation
  -> tool/capability/context validation
  -> CompiledCommanderPlan
  -> executor
```

The executor should eventually accept only compiled plans, not raw or loosely normalized model output. The first implementation should keep the existing executor APIs intact and add the compiler as a gate in front of them.

## Non-Goals

- Do not replace the whole planner in one patch.
- Do not immediately introduce a new schema dependency unless the first compiler pass proves it is needed.
- Do not remove existing normalization compatibility until tests cover real historical bad plans.
- Do not make the model responsible for enforcing safety. Prompt rules help, but runtime validation is mandatory.
- Do not move the desktop model-output extraction/parsing path into core in the first patch. Core can compile the normalized plan first; raw-output tracing can come later.

## Design Principles

- Treat Commander output as source code, not executable data.
- Normalize only format-level issues.
- Reject semantic errors before showing or executing the plan.
- Keep diagnostics machine-readable so they can power repair prompts and UI/debugging.
- Preserve current DAG execution behavior for valid plans.
- Add regression fixtures for every real production planning failure.

## Proposed Types

Add a planning compiler module:

```text
packages/core/src/planning/
  commander-plan-diagnostics.ts
  commander-plan-compiler.ts
  commander-plan-validator.ts
```

Initial public API:

```ts
export interface PlanDiagnostic {
  code:
    | "DUPLICATE_STEP_ID"
    | "MISSING_DEPENDENCY"
    | "DEPENDENCY_NOT_PRIOR"
    | "CYCLIC_DEPENDENCY"
    | "UNKNOWN_AGENT"
    | "UNKNOWN_CAPABILITY"
    | "CAPABILITY_NOT_AVAILABLE"
    | "UNKNOWN_TOOL"
    | "TOOL_NOT_ALLOWED"
    | "UNSUPPORTED_APPROVAL_GATED_TOOL"
    | "MISSING_TOOL_INPUT"
    | "MISSING_CONTEXT_PRODUCER"
    | "CONTEXT_PRODUCER_NOT_DEPENDED_ON"
    | "DUPLICATE_OUTPUT_CONTEXT_KEY"
    | "INVALID_EXECUTION_MODE"
    | "INVALID_PLAN_SHAPE";
  severity: "error" | "warning";
  path?: string;
  stepId?: string;
  message: string;
  suggestedFix?: string;
}

declare const compiledCommanderPlanBrand: unique symbol;

export type CompiledCommanderPlan = CommanderDagPlan & {
  readonly [compiledCommanderPlanBrand]: true;
};

export type CompileCommanderPlanResult =
  | {
      ok: true;
      plan: CompiledCommanderPlan;
      warnings: PlanDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: PlanDiagnostic[];
      repairable: boolean;
    };
```

Compiler entrypoint:

```ts
export function compileCommanderPlan(input: {
  plan: CommanderDagPlan;
  availableAgents: Array<{
    kind: string;
    allowedToolNames: string[];
    capabilities?: readonly string[];
  }>;
  availableTools: ToolDescriptor[];
  existingSteps?: Array<{
    id: string;
    dependsOn: string[];
    outputContextKey?: string;
  }>;
  supportedApprovalGatedTools?: string[];
  preloadedContextKeys?: string[];
}): CompileCommanderPlanResult;
```

The current implementation reads required tool inputs from `ToolDescriptor.requiredInputs`. The planner prompt includes them via the compiled prompt, the compiler validates them against the descriptor, and the dispatch guards in the executor provide defense in depth. A later schema-source phase should consolidate the structural schema so PlannerPrompt, compile-time checks, and dispatch guards share the same rule definition from a single Zod source. The compiler API should stay small until that source of truth exists; callers should not pass ad hoc input schemas.

`availableTools` must be the runtime tool descriptor set after feature flags, disabled tools, and MCP availability have been applied. It should not be the stripped `plannerAvailableTools` list used only for prompt construction. The compiler needs the same effective tool set that execution will use.

`availableAgents[].capabilities` may be supplied by the caller when already available. If omitted, the compiler can resolve default agent capabilities from `createDefaultAgentRegistry()`. This keeps Phase 1 compatible with current `getAvailableAgentsForPlanning()` call sites, which return only `kind` and `allowedToolNames`.

`existingSteps` is for recovery plans that are appended to an already-running workflow. Initial Commander plans should compile with no `existingSteps`. Recovery plans should either be compiled after merging with the active DAG, or compiled with existing step metadata so dependencies and context producers from already-completed steps are not misreported as missing.

`supportedApprovalGatedTools` is a small allowlist for confirmed-write tools that already have explicit preflight and approval handling in `runCommanderDagTask()`, such as Git stage/commit/PR operations. Other approval-gated tools should not enter the generic DAG executor through capability dispatch.

## Phase 1: Minimal Compiler Gate

Add a semantic validator after `normalizeCommanderDagPlan()` and before converting DAG steps into UI/execution steps.

Status: implemented for initial Commander plans and runtime failure recovery plans.

Initial validation rules:

- Step ids are unique.
- Every `dependsOn` reference exists.
- Every `dependsOn` reference should point to an earlier step in `plan.steps`. This should start as an error for model-generated Commander DAG plans because the prompt already requires prior-step references and UI order depends on it.
- The DAG has no cycles.
- `assignedAgentKind` is available.
- Every `capability` and `requiredCapabilities[]` item is a known `AgentCapabilityTag`.
- Every required capability is either fulfilled by the assigned agent's known capabilities or backed by at least one available tool descriptor owned by that agent.
- `toolName`, when present, exists in the available tool registry.
- `toolName`, when present, is owned by or allowed for the assigned agent.
- Approval-gated tools are rejected unless they are in `supportedApprovalGatedTools` and have explicit execution handling outside generic capability dispatch.
- If `executionMode` is explicitly `direct_tool_call`, the step must have a `toolName` or a resolvable capability. Existing inferred execution-mode behavior should continue for steps that omit `executionMode`.
- If `executionMode` is explicitly `direct_response`, the step should not declare a non-synthesis `toolName`.
- Known path tools require non-empty `toolInput.path`:
  - `computer.listDirectory`
  - `computer.openPath`
- Known Git write tools keep their existing explicit `toolInput` requirements:
  - `git.stageFiles`
  - `git.createCommit`
  - `git.createPullRequest`
  - `git.commentPullRequest`

Integration point:

```text
runCommanderDagTask()
  -> planCommanderDagWithContextRecovery()
  -> normalizeCommanderDagPlan()
  -> compileCommanderPlan({ availableTools: runtimeAvailableTools, ... })
  -> render/execute only if ok
```

For failure recovery plans, compile the recovery plan before appending it to the running DAG. The current implementation normalizes the recovery plan, passes the active `dagPlan.steps` as `existingSteps`, and rejects the recovery if compilation fails. A recovery step may legitimately depend on an existing completed step, so `existingSteps` includes id, dependencies, and output context metadata for the active DAG.

Recovery compile failure behavior:

- Do not append recovery steps.
- Record a failed `RecoveryAttemptRecord`.
- Include `formatDiagnosticSummary()` output in the recovery detail.
- Emit `task.replan_failed`.
- Return `undefined` from the replan handler so the executor does not retry the replan loop.

Normalization remains allowed to fill structural defaults such as `dependsOn: []` and `requiredCapabilities: []`. The compiler should validate the normalized plan, not treat those defaulted arrays as errors. Semantic errors are about invalid references, unavailable capabilities/tools, unsafe execution modes, missing required tool inputs, or impossible context flow.

Failure behavior:

- Do not start the DAG executor.
- Emit a failed planning snapshot with a concise diagnostic summary.
- Record full diagnostics in logs or recovery metadata. Avoid adding new `TaskSnapshot` fields in the first patch unless the UI needs them.
- Later phases may attempt plan repair before failing.

Acceptance:

- A plan with duplicate step ids fails before UI execution.
- A plan with missing dependencies fails before UI execution.
- A plan whose dependency points to a later step fails before UI execution.
- A plan with an unknown capability fails before UI execution.
- A plan with `computer.listDirectory` and no `toolInput.path` fails at compile time, not tool dispatch time.
- A plan that tries to run an unsupported approval-gated tool through generic dispatch fails at compile time.
- Existing valid Commander DAG tests still pass.

## Phase 2: Context Flow Validation

Add static handoff checks before execution.

Status: implemented for initial plans and recovery plans, including producer lookup and dependency-ancestor walks across `existingSteps`.

Rules:

- Every `inputContextKeys` entry should have a producer, unless it is a known preloaded context key such as `userGoal` or `taskId`.
- `step:<id>` keys should be treated as produced by that step, matching the existing executor behavior that stores every step output under `step:${step.id}`.
- If a producer exists, the consumer must depend on that producer directly or through its dependency ancestors.
- Two steps should not write the same `outputContextKey` unless an explicit merge/reducer policy exists.
- A consumer cannot read an output produced only by a parallel sibling with no dependency path.
- Unknown context keys should start as warnings if the current runtime already preloads them outside the DAG. Promote them to errors only after the allowlist is explicit.

Acceptance:

- A consumer step reading `uiEvidence` without a producer fails at compile time.
- A consumer step reading `uiEvidence` from a producer it does not depend on fails at compile time.
- Parallel writers to the same context key fail unless explicitly allowlisted.
- `userGoal`, `taskId`, and other documented preloaded keys do not require producer steps.

## Phase 3: Plan Repair Loop

Plan repair should be separate from runtime failure recovery.

Status: implemented for initial plan compilation failures. Runtime failure recovery does not run the repair loop; it only compiles the returned recovery plan and abandons recovery on compile failure.

Runtime failure recovery handles actual execution failures:

- tool timeout
- permission denial
- provider failure
- test failure

Plan repair handles invalid AST/planning output:

- duplicate ids
- missing dependencies
- missing required tool input
- invalid tool/agent binding
- missing context producer
- invalid repaired plan shape

Repair flow:

```text
first model plan
  -> compile fails
  -> send diagnostics and invalid plan to repair prompt
  -> model repairs only listed errors
  -> compile again
  -> max 2 repair attempts
```

Repair prompt constraints:

- Return JSON only.
- Do not change the user goal.
- Do not add unrelated steps.
- Only fix listed diagnostics.
- Keep existing valid step ids stable unless the diagnostic is about duplicate or invalid ids.

Acceptance:

- A repairable missing `dependsOn` or duplicate id gets one repair attempt.
- An unsafe or repeatedly invalid plan fails with diagnostics.
- Runtime replan is not invoked for compile failures.
- Malformed repaired model output is captured as `INVALID_PLAN_SHAPE` instead of throwing out of the repair loop.

## Phase 4: Single Schema Source

Once the semantic compiler is stable, collapse the structural contract into a single source of truth.

Status: partially implemented. The canonical `CommanderDagPlanShape` Zod schema in `packages/core/src/planning/schema.ts` derives TS types, JSON Schema (`zodToPlanJsonSchema`), prompt text (`planShapeToPromptText`), and runtime validation (`buildToolInputShape`). However, `packages/tools/src/plan-schema.ts` mirrors the same types independently (see `CommanderPlanResultShape`), creating a dual-schema problem. A mirror test (`llm-raw-shape.test.ts`) catches field-level drift between the two, but it does not prevent structural divergence.

Options:

- TypeBox + Ajv
- Zod + JSON Schema conversion
- A local hand-rolled schema generator, if avoiding dependencies remains important

The target is:

- TypeScript type derives from schema.
- Runtime structural validation uses the same schema.
- Prompt JSON schema derives from the same schema.
- Examples in tests validate against the same compiler.

This should happen after the Phase 1 and Phase 2 validators are in place, because semantic validation is the more urgent safety boundary.

## Test Strategy

Add focused compiler tests:

- Valid minimal DAG compiles.
- Duplicate step id is rejected.
- Missing dependency is rejected.
- Cyclic dependency is rejected.
- Unknown agent is rejected.
- Unknown tool is rejected.
- Unknown capability is rejected.
- Required capability unavailable for the assigned agent is rejected.
- Tool not allowed for agent is rejected.
- Unsupported approval-gated tool is rejected.
- Missing path for `computer.listDirectory` and `computer.openPath` is rejected.
- Wrong input types for required tool inputs are rejected.
- `direct_response` with a non-synthesis `toolName` is rejected.
- Missing context producer is rejected.
- Context producer not in dependency ancestors is rejected.
- Recovery plans can read existing step outputs only when they depend on the producer.
- Duplicate `outputContextKey` is rejected.

Add regression fixtures:

```text
packages/core/src/planning/__fixtures__/
  missing-computer-path.json
  duplicate-step-id.json
  missing-dependency.json
  cyclic-dependency.json
  missing-context-producer.json
```

Add contract tests:

- Prompt examples compile.
- Normalized model fixtures compile or fail with expected diagnostics.
- Existing Commander DAG runtime tests still pass for valid plans.
- Invalid plans fail before `executeWorkflow()` or tool dispatch is called.
- Failure recovery plans fail before appended recovery execution if they do not compile.

## Observability

Eventually, compilation diagnostics should be visible from task logs and final snapshots. In Phase 1, store diagnostics in task logs and recovery metadata only. Adding a first-class snapshot field should be a separate UI/API change.

Status: implemented. Diagnostics are surfaced through task logs, repair attempt logs, and recovery reports. A first-class `PlanGenerationTrace` struct with schema versioning (`PLAN_GENERATION_TRACE_SCHEMA_VERSION`) is available on `TaskSnapshot.planGenerationTrace` (Zod shape in `schema.ts`). Future work includes UI surfacing of the trace and optional persistence of raw model output for post-mortem analytics.

Current trace shape (canonical source in `plan-generation-trace.ts`):

```ts
interface PlanGenerationTrace {
  schemaVersion: string;         // PLAN_GENERATION_TRACE_SCHEMA_VERSION
  planSchemaVersion: string;     // COMMANDER_PLAN_SCHEMA_VERSION
  generatedAt: string;
  userGoal: string;
  initialCompiled: boolean;
  repairAttemptCount: number;
  stages: PlanGenerationStageRecord[];  // "initial" | "repair"
  recoveryCompiles: PlanRecoveryCompileRecord[];  // stage="recovery"
  extractedJson?: string;        // raw model output
  normalizedPlan?: CommanderDagPlan;
  promptVersion?: string;        // COMMANDER_PLAN_PROMPT_VERSION from schema.ts
}
```

Raw model output can be too large or sensitive, so it should be stored only where existing logging/privacy policy allows it. Diagnostics and normalized summaries are enough for most product debugging.

## Migration Plan

1. Done: Add compiler and diagnostics types.
2. Done: Wire compiler into `runCommanderDagTask()` after `normalizeCommanderDagPlan()`.
3. Done: Pass the same runtime `availableTools` used for execution into the compiler, not the prompt-only `plannerAvailableTools`.
4. Done: Keep current dispatch-layer tool-input guards as defense in depth, and duplicate only the minimum required checks in the compiler.
5. Done: Add Phase 1 tests and fixtures.
6. Done: Add context flow checks, including recovery-plan `existingSteps`.
7. Done: Add plan repair loop for initial compile failures.
8. Done: Compile runtime failure recovery plans and abandon invalid recovery without repair recursion.
9. Partially done: Core schema unified under Zod in `packages/core/src/planning/schema.ts` (TS types, JSON Schema, prompt text, `buildToolInputShape` all derived). The `@javis/tools/src/plan-schema.ts` mirror remains, with a contract test (`llm-raw-shape.test.ts`) catching field-level drift but not structural divergence. Next step: eliminate the mirror by re-exporting from core.
10. Remaining: Brand `CompiledCommanderPlan` and narrow executor APIs after call sites have been migrated. The executor currently assigns `dagPlan` as `CompiledCommanderPlan` locally, but many internal helpers still accept raw `CommanderDagPlan`.
11. Done: `PlanGenerationTrace` struct with schema versioning (`PLAN_GENERATION_TRACE_SCHEMA_VERSION`) is available on `TaskSnapshot.planGenerationTrace`. UI surfacing and raw-model-output persistence remain as optional follow-ups.

## Risks

- Overly strict validation may reject plans that previously worked through permissive normalization.
- Context flow validation can be noisy if some context keys are intentionally preloaded or produced outside the DAG.
- Plan repair can introduce instability if it rewrites too much.
- Adding a schema library may increase dependency and build complexity.

Mitigations:

- Start with warnings for ambiguous context cases, then promote to errors.
- Maintain a small allowlist of preloaded context keys.
- Limit repair attempts and require exact diagnostic-driven repair.
- Keep dispatch-layer guards even after compile-time validation.

## Recommended First Patch

The first implementation patch should be intentionally small:

- Add `commander-plan-diagnostics.ts`.
- Add `commander-plan-validator.ts`.
- Add `compileCommanderPlan()`.
- Include `preloadedContextKeys: ["userGoal", "taskId"]`.
- Include `supportedApprovalGatedTools` for the Git tools that already have explicit approval paths.
- Validate:
  - duplicate ids
  - missing dependencies
  - dependency references to later steps
  - cycles
  - unknown or unavailable capabilities
  - unknown agent/tool
  - tool ownership
  - unsupported approval-gated tools
  - missing required path for `computer.listDirectory` / `computer.openPath`
- Wire it into `runCommanderDagTask()`.
- Add regression tests for the Wallpaper Engine missing-path failure.

This closes the immediate reliability gap without forcing a full schema-library migration in the same change.

Current implementation status: this first patch has been completed, then extended with initial plan repair, recovery plan compile gating, stricter required tool input type checks, and recovery context-flow validation across `existingSteps`. Required tool inputs have been moved into `ToolDescriptor.requiredInputs` and are read by the compiler, planner prompt, and `buildToolInputShape`. `PlanGenerationTrace` is available on `TaskSnapshot.planGenerationTrace` with Zod schema versioning.

Remaining follow-up patches should focus on:

- Consolidating the structural schema source (the `tools/plan-schema.ts` mirror vs core single source still needs elimination).
- Narrowing executor APIs to accept only compiled plans where practical.
- UI surfacing of `PlanGenerationTrace` and optional raw-model-output persistence.
