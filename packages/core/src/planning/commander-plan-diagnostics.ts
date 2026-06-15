/**
 * Commander Plan Compiler - Diagnostic Types
 *
 * Machine-readable diagnostics for plan compilation failures.
 * These power repair prompts, UI display, and task log entries.
 */

import type { CommanderDagPlan } from "../commander-plan-schema";

// --- Diagnostic Codes --------------------------------------------------------

export type PlanDiagnosticCode =
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

// --- Diagnostic --------------------------------------------------------------

export interface PlanDiagnostic {
  code: PlanDiagnosticCode;
  severity: "error" | "warning";
  /** JSON-pointer-style path, e.g. "steps[2].toolInput" */
  path?: string;
  stepId?: string;
  message: string;
  suggestedFix?: string;
}

// --- Compiled Plan Brand -----------------------------------------------------

// A unique-symbol key on the value type forces TS to require the
// brand for type-level assignment. Using a symbol-valued property
// (rather than `readonly [s]: true` index signature) is what makes
// the brand actually reject plain values: TS treats the symbol as
// non-narrowable from any concrete value, so an unbranded
// CommanderDagPlan cannot flow into a CompiledCommanderPlan slot
// without going through compileCommanderPlan or trustAsCompiled.
declare const compiledCommanderPlanBrand: unique symbol;

export type CompiledCommanderPlan = CommanderDagPlan & {
  readonly [compiledCommanderPlanBrand]: true;
};

// --- Compile Result ----------------------------------------------------------

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

// --- Helpers -----------------------------------------------------------------

export function isCompiledPlan(
  result: CompileCommanderPlanResult,
): result is Extract<CompileCommanderPlanResult, { ok: true }> {
  return result.ok;
}

/**
 * Brand a `CommanderDagPlan` as a `CompiledCommanderPlan` without
 * re-running semantic validation. Reserved for two narrow call sites:
 *
 *   1. The computer-use fallback plan produced inside the executor
 *      (`createFallbackComputerUseDagPlan`). It is hand-validated and
 *      cannot be reasonably fed back through `compileCommanderPlan`
 *      because the plan is constructed for a degraded path that the
 *      availableAgents / availableTools checks are designed to reject.
 *   2. The post-recovery merge where recovery steps are pushed into
 *      the original compiled plan. The recovery plan itself went
 *      through the compile gate; the merged result is structurally
 *      the original compiled plan + a known-good step slice, so
 *      re-running compile on the merge is redundant and risks false
 *      positives on DUPLICATE_OUTPUT_CONTEXT_KEY (the recovery steps
 *      intentionally overwrite failed-step references).
 *
 * Every escape-hatch caller MUST be paired with a code comment that
 * names which case above applies, so future readers can audit.
 */
export function trustAsCompiled(plan: CommanderDagPlan): CompiledCommanderPlan {
  return plan as CompiledCommanderPlan;
}

/**
 * Build a new `CompiledCommanderPlan` by appending extra steps to an
 * already-compiled plan. The new plan is the structural union of the
 * original (preserved) and the appended slice. The original plan is
 * expected to have cleared the compile gate; the appended slice is
 * the responsibility of the caller (see `trustAsCompiled` for the two
 * recognized cases). This is used by the recovery step push so the
 * brand survives the merge.
 */
export function appendStepsToCompiledPlan(
  base: CompiledCommanderPlan,
  additional: ReadonlyArray<CompiledCommanderPlan["steps"][number]>,
): CompiledCommanderPlan {
  return {
    ...base,
    steps: [...base.steps, ...additional],
  };
}

export function formatDiagnosticSummary(diagnostics: PlanDiagnostic[]): string {
  return diagnostics
    .map((d) => {
      const prefix = d.severity === "error" ? "ERROR" : "WARN";
      const loc = d.stepId ? ` [step=${d.stepId}]` : "";
      const path = d.path ? ` at ${d.path}` : "";
      return `${prefix} ${d.code}${loc}${path}: ${d.message}`;
    })
    .join("\n");
}

/**
 * Determine whether a set of diagnostics is repairable.
 * A plan is repairable if all errors are in categories the model can fix
 * (structural issues) rather than fundamental capability mismatches.
 */
export function isRepairable(diagnostics: PlanDiagnostic[]): boolean {
  const nonRepairableCodes: Set<PlanDiagnosticCode> = new Set([
    "UNKNOWN_AGENT",
    "UNKNOWN_TOOL",
    "UNSUPPORTED_APPROVAL_GATED_TOOL",
    "INVALID_PLAN_SHAPE",
  ]);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return false;
  return errors.every((d) => !nonRepairableCodes.has(d.code));
}
