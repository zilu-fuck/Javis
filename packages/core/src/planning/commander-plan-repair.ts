/**
 * Commander Plan Repair Loop
 *
 * When the first model plan fails semantic compilation, the caller can
 * invoke `attemptPlanRepair` to ask the model to repair the plan. The
 * loop is bounded by `maxAttempts` (default 2) and only runs when the
 * initial compilation reports `repairable: true`.
 *
 * Repair orchestration lives in core (not in the desktop model-output
 * layer) so it is reusable from tests and other call sites.
 */

import type {
  CommanderDagPlan,
} from "../commander-plan-schema";
import type {
  CommanderPlanRepairContext,
  CommanderPlanRequest,
  CommanderPlanResult,
  ToolDescriptor,
} from "@javis/tools";
import {
  compileCommanderPlan,
  type CompiledCommanderPlan,
  type CompileCommanderPlanInput,
  type PlanDiagnostic,
} from "./commander-plan-compiler";
import { isRepairable } from "./commander-plan-diagnostics";
import { CommanderDagPlanShape } from "./schema";
import { CommanderPlanResultShape } from "@javis/tools";
import { normalizeStepContract } from "../step-protocol";
import { inferCommanderRouteRequirements } from "./commander-route-contract";
import {
  applyDeterministicPlanRepairs,
  detectCommanderPlanIntents,
  type CommanderPlanIntents,
} from "./plan-legality";

// --- Public types ------------------------------------------------------------

export interface RepairAttemptRecord {
  attempt: number;
  status: "compiled" | "failed";
  diagnostics: PlanDiagnostic[];
  /** The repaired plan returned by the model on this attempt (if any). */
  repairedPlan?: CommanderDagPlan;
  /**
   * "deterministic" attempts ran the local rule-based fixer (Layer 2)
   * without a model call; "model" attempts asked the Commander to repair.
   * Absent on records produced before the channel split — treat as "model".
   */
  channel?: "deterministic" | "model";
  /** Notes from deterministic local repairs applied on this attempt. */
  repairNotes?: string[];
}

export interface AttemptPlanRepairInput {
  commanderPlan: (request: CommanderPlanRequest) => Promise<CommanderPlanResult>;
  originalUserGoal: string;
  /** Preserve the runtime-selected workspace across repair model calls. */
  workspacePath?: string;
  /** Transport-only image data for vision-capable repair calls. */
  modelImages?: string[];
  invalidPlan: CommanderDagPlan;
  diagnostics: PlanDiagnostic[];
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
  /** Defaults to detecting intents again from `originalUserGoal`. */
  planIntents?: CommanderPlanIntents;
  locale?: string;
  workflowId?: string;
  maxAttempts?: number;
}

export type AttemptPlanRepairResult =
  | {
      ok: true;
      plan: CompiledCommanderPlan;
      attempts: RepairAttemptRecord[];
    }
  | {
      ok: false;
      attempts: RepairAttemptRecord[];
      finalDiagnostics: PlanDiagnostic[];
      repairable: boolean;
    };

// --- Implementation ---------------------------------------------------------

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

/**
 * Normalize a raw CommanderPlanResult from a model call into a
 * CommanderDagPlan with defaulted fields. Mirrors the executor's
 * `normalizeCommanderDagPlan` so the repaired plan validates the same
 * shape the rest of the runtime expects.
 *
 * Shape checks delegate to the Zod-derived `CommanderDagPlanShape`
 * (single source of truth in `./schema.ts`). Defaults for missing
 * optional fields (`requiredCapabilities`, `dependsOn`) are still
 * applied permissively to keep the model contract forgiving.
 *
 * Throws `PlanShapeError` when the model returned a payload that does not
 * match the expected top-level shape (no `steps` array, non-string `title`,
 * etc.). Callers MUST treat that as a stable INVALID_PLAN_SHAPE diagnostic
 * instead of letting the exception escape the repair loop.
 */
function normalizeResultToDagPlan(
  result: CommanderPlanResult,
  options: { workspacePath?: string } = {},
): CommanderDagPlan {
  // Stage 1: structural validation against the LLM-raw Zod shape.
  // `CommanderPlanResultShape` is the single source for the LLM
  // contract (see `@javis/tools/src/plan-schema.ts`); replacing
  // hand-written per-field checks with safeParse means a field
  // added to the schema is automatically caught here.
  const llmParse = CommanderPlanResultShape.safeParse(result);
  if (!llmParse.success) {
    const issue = llmParse.error.issues[0];
    throw new PlanShapeError(
      `model returned a plan without a valid LLM-raw shape: ${issue?.path?.join(".") ?? "<root>"}: ${issue?.message ?? "unknown"}`,
    );
  }
  // Stage 2: deterministic local repair (Layer 2). Mechanical defects
  // (non-kebab ids, executionMode synonyms, absolute in-workspace write
  // targets) are fixed before strict validation so they never consume a
  // model repair round.
  const repaired = applyDeterministicPlanRepairs(llmParse.data, {
    workspacePath: options.workspacePath,
  });
  // Stage 3: coerce to the strict normalized plan. The LLM is
  // allowed to omit optional fields, so we still supply defaults
  // here (dependsOn: [], requiredCapabilities: [], toolInput
  // filtered to plain objects). This stays as a hand-rolled map
  // because the defaulting rules are normalization, not
  // structural validation.
  const parsed = repaired.plan;
  const normalizedSteps = parsed.steps.map((step) => {
    const isPlainObject =
      typeof step.toolInput === "object" &&
      step.toolInput !== null &&
      !Array.isArray(step.toolInput);
    return {
      ...step,
      ...normalizeStepContract(step),
      capability: step.capability,
      requiredCapabilities: step.requiredCapabilities ?? [],
      dependsOn: step.dependsOn ?? [],
      toolInput: isPlainObject ? step.toolInput : undefined,
    };
  });
  // The candidate is structurally a valid CommanderDagPlan (alias
  // for the Zod-derived `CommanderDagPlanT`). The next line's
  // `CommanderDagPlanShape.safeParse` is the actual gate; the TS
  // assignment is now direct because `CommanderDagPlan` is an alias
  // for the Zod shape (no longer a narrower hand-written interface).
  const candidate: CommanderDagPlan = {
    title: parsed.title,
    reasoning: parsed.reasoning,
    executionPolicy: parsed.executionPolicy,
    steps: normalizedSteps,
  };
  // Stage 4: final structural sanity check. The validator runs a
  // deeper semantic pass; this just makes sure we didn't construct
  // a plan that violates the Zod-derived shape (e.g. a step count
  // over the 12-step prompt limit). If it fails, treat as a shape
  // error so the repair loop can surface it as INVALID_PLAN_SHAPE.
  const strictParse = CommanderDagPlanShape.safeParse(candidate);
  if (!strictParse.success) {
    const issue = strictParse.error.issues[0];
    throw new PlanShapeError(
      `normalized plan failed Zod shape check: ${issue?.path?.join(".") ?? "<root>"}: ${issue?.message ?? "unknown"}`,
    );
  }
  return candidate;
}

function preserveUnaffectedRoutingContract(
  repairedPlan: CommanderDagPlan,
  previousPlan: CommanderDagPlan,
  diagnostics: readonly PlanDiagnostic[],
  requiredRoutingAgentKinds: ReadonlySet<string>,
): CommanderDagPlan {
  const previousSteps = new Map(previousPlan.steps.map((step) => [step.id, step]));
  const hasPlanLevelRouteDiagnostic = diagnostics.some((diagnostic) =>
    !diagnostic.stepId &&
    (diagnostic.code === "MISSING_REQUIRED_AGENT_ROUTE" ||
      diagnostic.code === "MISSING_REQUIRED_ROUTE_TOOL")
  );

  return {
    ...repairedPlan,
    steps: repairedPlan.steps.map((step) => {
      const previous = previousSteps.get(step.id);
      if (!previous) return step;
      const stepDiagnostics = diagnostics.filter((diagnostic) => diagnostic.stepId === step.id);
      const targets = (field: string, codes: readonly PlanDiagnostic["code"][] = []) =>
        stepDiagnostics.some((diagnostic) =>
          diagnostic.path?.endsWith(`.${field}`) || codes.includes(diagnostic.code)
        );
      const repairsRequiredRoute = hasPlanLevelRouteDiagnostic &&
        step.assignedAgentKind !== previous.assignedAgentKind &&
        requiredRoutingAgentKinds.has(step.assignedAgentKind);

      return {
        ...step,
        ...(!repairsRequiredRoute && !targets("assignedAgentKind", [
          "UNKNOWN_AGENT",
          "CAPABILITY_NOT_AVAILABLE",
          "TOOL_NOT_ALLOWED",
          "MISROUTED_PROJECT_INSPECTION",
        ])
          ? { assignedAgentKind: previous.assignedAgentKind }
          : {}),
        ...(previous.primaryCapability && !repairsRequiredRoute &&
        !targets("primaryCapability", [
          "MISSING_PRIMARY_CAPABILITY",
          "UNKNOWN_CAPABILITY",
          "CAPABILITY_NOT_AVAILABLE",
          "MISROUTED_PROJECT_INSPECTION",
        ])
          ? { primaryCapability: previous.primaryCapability }
          : {}),
        ...(previous.capability && !repairsRequiredRoute &&
        !targets("capability", [
          "UNKNOWN_CAPABILITY",
          "CAPABILITY_NOT_AVAILABLE",
          "MISROUTED_PROJECT_INSPECTION",
        ])
          ? { capability: previous.capability }
          : {}),
        ...(!repairsRequiredRoute && !targets("requiredCapabilities", [
          "UNKNOWN_CAPABILITY",
          "CAPABILITY_NOT_AVAILABLE",
          "MISROUTED_PROJECT_INSPECTION",
        ])
          ? { requiredCapabilities: previous.requiredCapabilities }
          : {}),
        ...(previous.toolName && !repairsRequiredRoute &&
        !targets("toolName", [
          "UNKNOWN_TOOL",
          "TOOL_NOT_ALLOWED",
          "UNSUPPORTED_APPROVAL_GATED_TOOL",
          "MISSING_APPROVAL_TOOL_SELECTION",
          "INVALID_EXECUTION_MODE",
          "MISROUTED_PROJECT_INSPECTION",
        ])
          ? { toolName: previous.toolName }
          : {}),
        ...(previous.executionMode && !repairsRequiredRoute && !targets("executionMode", [
          "INVALID_EXECUTION_MODE",
          "MISROUTED_PROJECT_INSPECTION",
        ])
          ? { executionMode: previous.executionMode }
          : {}),
      };
    }),
  };
}

class PlanShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanShapeError";
  }
}

/**
 * Translate a PlanShapeError into a stable INVALID_PLAN_SHAPE diagnostic so
 * the repair loop can surface it without throwing past the loop boundary.
 */
function planShapeErrorToDiagnostic(attempt: number, cause: unknown): PlanDiagnostic {
  const message =
    cause instanceof Error ? cause.message : `unknown shape error: ${String(cause)}`;
  return {
    code: "INVALID_PLAN_SHAPE",
    severity: "error",
    message: `Repair attempt ${attempt} returned a plan with an invalid top-level shape: ${message}.`,
    suggestedFix:
      "The model's repaired payload is missing required fields (title / reasoning / steps[] / per-step id/title/agent/successCriteria). Inspect the raw model output and the schema, then retry with a stricter prompt.",
  };
}

/**
 * Run the plan repair loop.
 *
 * The loop:
 * - Bails out immediately if the input diagnostics include non-repairable
 *   codes (e.g. UNKNOWN_AGENT, UNKNOWN_TOOL) - no point asking the model.
 * - Calls the supplied `commanderPlan` function with a repair-specific
 *   request for up to `maxAttempts` times.
 * - Re-compiles each repaired plan. If a repaired plan compiles, the
 *   loop returns success. If it fails with non-repairable diagnostics,
 *   the loop short-circuits and reports failure.
 * - Returns the full attempt log so the executor can persist it to
 *   `PlanGenerationTrace` / task logs.
 */
export async function attemptPlanRepair(
  input: AttemptPlanRepairInput,
): Promise<AttemptPlanRepairResult> {
  const maxAttempts = clampMaxAttempts(input.maxAttempts);
  const attempts: RepairAttemptRecord[] = [];

  if (!isRepairable(input.diagnostics)) {
    return {
      ok: false,
      attempts,
      finalDiagnostics: input.diagnostics,
      repairable: false,
    };
  }

  const compileInputBase: Omit<CompileCommanderPlanInput, "plan"> = {
    availableAgents: input.availableAgents,
    availableTools: input.availableTools,
    existingSteps: input.existingSteps,
    supportedApprovalGatedTools: input.supportedApprovalGatedTools,
    preloadedContextKeys: input.preloadedContextKeys,
    planIntents: input.planIntents ?? detectCommanderPlanIntents(input.originalUserGoal),
    userGoal: input.originalUserGoal,
  };

  let lastInvalidPlan: CommanderDagPlan = input.invalidPlan;
  let lastDiagnostics: PlanDiagnostic[] = input.diagnostics;

  // --- Stage A: deterministic local repair (Layer 2) -----------------------
  // Before spending a model call, run the rule-based fixer over the invalid
  // plan. If the deterministically-repaired plan compiles, the loop exits
  // immediately; if it strictly reduces the error count, the improved plan
  // becomes the baseline the model is asked to finish repairing.
  const deterministic = applyDeterministicPlanRepairs(input.invalidPlan, {
    workspacePath: input.workspacePath,
  });
  if (deterministic.repairs.length > 0) {
    let deterministicCompile: ReturnType<typeof compileCommanderPlan>;
    try {
      deterministicCompile = compileCommanderPlan({
        ...compileInputBase,
        plan: deterministic.plan,
      });
    } catch (compileError) {
      deterministicCompile = {
        ok: false,
        diagnostics: [planShapeErrorToDiagnostic(0, compileError)],
        repairable: false,
      };
    }
    attempts.push({
      attempt: 0,
      channel: "deterministic",
      status: deterministicCompile.ok ? "compiled" : "failed",
      diagnostics: deterministicCompile.ok
        ? deterministicCompile.warnings
        : deterministicCompile.diagnostics,
      repairedPlan: deterministic.plan,
      repairNotes: deterministic.repairs,
    });
    if (deterministicCompile.ok) {
      return { ok: true, plan: deterministicCompile.plan, attempts };
    }
    const priorErrorCount = countErrorDiagnostics(input.diagnostics);
    const remainingErrorCount = countErrorDiagnostics(deterministicCompile.diagnostics);
    if (remainingErrorCount < priorErrorCount) {
      if (!deterministicCompile.repairable) {
        return {
          ok: false,
          attempts,
          finalDiagnostics: deterministicCompile.diagnostics,
          repairable: false,
        };
      }
      lastInvalidPlan = deterministic.plan;
      lastDiagnostics = deterministicCompile.diagnostics;
    }
  }

  // --- Stage B: bounded model repair with precise diagnostics ---------------
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    const repairContext: CommanderPlanRepairContext = {
      originalUserGoal: input.originalUserGoal,
      invalidPlan: lastInvalidPlan,
      diagnostics: lastDiagnostics,
      attempt: attemptNumber,
      maxAttempts,
    };

    const request: CommanderPlanRequest = {
      userGoal: input.originalUserGoal,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.modelImages?.length ? { images: input.modelImages } : {}),
      availableAgents: input.availableAgents.map((a) => ({
        kind: a.kind,
        allowedToolNames: [...a.allowedToolNames],
      })),
      availableTools: input.availableTools,
      workflowId: input.workflowId,
      repairContext,
    };

    let repairedResult: CommanderPlanResult;
    try {
      repairedResult = await input.commanderPlan(request);
    } catch (error) {
      const parseFailureDiag: PlanDiagnostic = {
        code: "INVALID_EXECUTION_MODE",
        severity: "error",
        message: `Repair attempt ${attemptNumber} model call failed: ${error instanceof Error ? error.message : String(error)}`,
        suggestedFix:
          "Check the model call wiring; the repair call must not throw.",
      };
      const record: RepairAttemptRecord = {
        attempt: attemptNumber,
        channel: "model",
        status: "failed",
        diagnostics: [parseFailureDiag],
      };
      attempts.push(record);
      return {
        ok: false,
        attempts,
        finalDiagnostics: [parseFailureDiag],
        repairable: false,
      };
    }

    let repairedPlan: CommanderDagPlan;
    try {
      repairedPlan = normalizeResultToDagPlan(repairedResult, {
        workspacePath: input.workspacePath,
      });
      repairedPlan = preserveUnaffectedRoutingContract(
        repairedPlan,
        lastInvalidPlan,
        lastDiagnostics,
        new Set(inferCommanderRouteRequirements(input.originalUserGoal).map((route) => route.agentKind)),
      );
    } catch (shapeError) {
      // Malformed model output must NOT escape the repair loop as an
      // uncaught throw - that would skip attempt recording and leave the
      // caller with no stable diagnostics. Convert to INVALID_PLAN_SHAPE
      // and bail out as non-repairable.
      const shapeDiag = planShapeErrorToDiagnostic(attemptNumber, shapeError);
      attempts.push({
        attempt: attemptNumber,
        channel: "model",
        status: "failed",
        diagnostics: [shapeDiag],
      });
      return {
        ok: false,
        attempts,
        finalDiagnostics: [shapeDiag],
        repairable: false,
      };
    }

    let recompile: ReturnType<typeof compileCommanderPlan>;
    try {
      recompile = compileCommanderPlan({
        ...compileInputBase,
        plan: repairedPlan,
      });
    } catch (compileError) {
      // The validator/compiler should never throw, but if a future
      // contributor adds an invariant that does, the repair loop must
      // still produce a stable diagnostic instead of crashing the
      // surrounding executor.
      const shapeDiag = planShapeErrorToDiagnostic(attemptNumber, compileError);
      attempts.push({
        attempt: attemptNumber,
        channel: "model",
        status: "failed",
        diagnostics: [shapeDiag],
      });
      return {
        ok: false,
        attempts,
        finalDiagnostics: [shapeDiag],
        repairable: false,
      };
    }

    if (recompile.ok) {
      attempts.push({
        attempt: attemptNumber,
        channel: "model",
        status: "compiled",
        diagnostics: recompile.warnings,
        repairedPlan,
      });
      return {
        ok: true,
        plan: recompile.plan,
        attempts,
      };
    }

    attempts.push({
      attempt: attemptNumber,
      channel: "model",
      status: "failed",
      diagnostics: recompile.diagnostics,
      repairedPlan,
    });

    if (!recompile.repairable) {
      return {
        ok: false,
        attempts,
        finalDiagnostics: recompile.diagnostics,
        repairable: false,
      };
    }

    lastInvalidPlan = repairedPlan;
    lastDiagnostics = recompile.diagnostics;
  }

  // Loop exhausted. The diagnostics themselves may still be repairable in
  // principle, but the bounded attempt budget is gone - no caller should
  // re-enter the repair loop. Surface a `repairable: false` so consumers
  // (e.g. the executor) do not get a misleading "you can try again" signal.
  return {
    ok: false,
    attempts,
    finalDiagnostics: lastDiagnostics,
    repairable: false,
  };
}

function clampMaxAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_REPAIR_ATTEMPTS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_REPAIR_ATTEMPTS;
  return Math.floor(value);
}

function countErrorDiagnostics(diagnostics: readonly PlanDiagnostic[]): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
}
