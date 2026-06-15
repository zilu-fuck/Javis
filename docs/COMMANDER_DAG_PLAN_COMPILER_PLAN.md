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
    | "INVALID_EXECUTION_MODE";
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
  requiredToolInputs?: Record<string, Array<{
    name: string;
    type: "string" | "string[]";
    nonEmpty?: boolean;
  }>>;
}): CompileCommanderPlanResult;
```

The first patch can hardcode `requiredToolInputs` inside the compiler for known built-in tools. A later schema-source phase should move these requirements into tool descriptors or generated tool schemas so planner prompts, compile-time checks, and dispatch guards share the same rule.

`availableTools` must be the runtime tool descriptor set after feature flags, disabled tools, and MCP availability have been applied. It should not be the stripped `plannerAvailableTools` list used only for prompt construction. The compiler needs the same effective tool set that execution will use.

`availableAgents[].capabilities` may be supplied by the caller when already available. If omitted, the compiler can resolve default agent capabilities from `createDefaultAgentRegistry()`. This keeps Phase 1 compatible with current `getAvailableAgentsForPlanning()` call sites, which return only `kind` and `allowedToolNames`.

`existingSteps` is for recovery plans that are appended to an already-running workflow. Initial Commander plans should compile with no `existingSteps`. Recovery plans should either be compiled after merging with the active DAG, or compiled with existing step metadata so dependencies and context producers from already-completed steps are not misreported as missing.

`supportedApprovalGatedTools` is a small allowlist for confirmed-write tools that already have explicit preflight and approval handling in `runCommanderDagTask()`, such as Git stage/commit/PR operations. Other approval-gated tools should not enter the generic DAG executor through capability dispatch.

## Phase 1: Minimal Compiler Gate

Add a semantic validator after `normalizeCommanderDagPlan()` and before converting DAG steps into UI/execution steps.

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

For failure recovery plans, compile the effective appended DAG, not just the recovery JSON in isolation. A recovery step may legitimately depend on an existing completed step. The compiler should receive either the merged active DAG or `existingSteps` with enough dependency and context metadata to validate the appended steps.

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

## Phase 4: Single Schema Source

Once the semantic compiler is stable, collapse the structural contract into a single source of truth.

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
- Missing context producer is rejected.
- Context producer not in dependency ancestors is rejected.
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

## Observability

Eventually, compilation diagnostics should be visible from task logs and final snapshots. In Phase 1, store diagnostics in task logs and recovery metadata only. Adding a first-class snapshot field should be a separate UI/API change.

Future trace shape:

```ts
interface PlanGenerationTrace {
  extractedJson?: unknown;
  normalizedPlan?: unknown;
  compiledPlan?: CompiledCommanderPlan;
  diagnostics: PlanDiagnostic[];
  repairAttempts: Array<{
    diagnostics: PlanDiagnostic[];
    repairedPlan?: unknown;
    status: "compiled" | "failed";
  }>;
  schemaVersion: number;
  promptVersion: string;
}
```

Raw model output can be too large or sensitive, so it should be stored only where existing logging/privacy policy allows it. Diagnostics and normalized summaries are enough for most product debugging.

## Migration Plan

1. Add compiler and diagnostics types.
2. Wire compiler into `runCommanderDagTask()` after `normalizeCommanderDagPlan()`.
3. Pass the same runtime `availableTools` used for execution into the compiler, not the prompt-only `plannerAvailableTools`.
4. Keep current dispatch-layer tool-input guards as defense in depth, and duplicate only the minimum required checks in the compiler.
5. Add Phase 1 tests and fixtures.
6. Add context flow checks.
7. Add plan repair loop.
8. Consolidate schema source.
9. Brand `CompiledCommanderPlan` and narrow executor APIs after call sites have been migrated.

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
