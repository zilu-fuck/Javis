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

// --- Public types ------------------------------------------------------------

export interface RepairAttemptRecord {
  attempt: number;
  status: "compiled" | "failed";
  diagnostics: PlanDiagnostic[];
  /** The repaired plan returned by the model on this attempt (if any). */
  repairedPlan?: CommanderDagPlan;
}

export interface AttemptPlanRepairInput {
  commanderPlan: (request: CommanderPlanRequest) => Promise<CommanderPlanResult>;
  originalUserGoal: string;
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
function normalizeResultToDagPlan(result: CommanderPlanResult): CommanderDagPlan {
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
  // Stage 2: coerce to the strict normalized plan. The LLM is
  // allowed to omit optional fields, so we still supply defaults
  // here (dependsOn: [], requiredCapabilities: [], toolInput
  // filtered to plain objects). This stays as a hand-rolled map
  // because the defaulting rules are normalization, not
  // structural validation.
  const parsed = llmParse.data;
  const normalizedSteps = parsed.steps.map((step) => {
    const isPlainObject =
      typeof step.toolInput === "object" &&
      step.toolInput !== null &&
      !Array.isArray(step.toolInput);
    return {
      ...step,
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
    steps: normalizedSteps,
  };
  // Stage 3: final structural sanity check. The validator runs a
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
  };

  let lastInvalidPlan: CommanderDagPlan = input.invalidPlan;
  let lastDiagnostics: PlanDiagnostic[] = input.diagnostics;

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
      repairedPlan = normalizeResultToDagPlan(repairedResult);
    } catch (shapeError) {
      // Malformed model output must NOT escape the repair loop as an
      // uncaught throw - that would skip attempt recording and leave the
      // caller with no stable diagnostics. Convert to INVALID_PLAN_SHAPE
      // and bail out as non-repairable.
      const shapeDiag = planShapeErrorToDiagnostic(attemptNumber, shapeError);
      attempts.push({
        attempt: attemptNumber,
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
