/**
 * Commander Plan Compiler
 *
 * Entry point for compiling a normalized CommanderDagPlan into a
 * validated CompiledCommanderPlan. The compiler runs semantic validation
 * after structural normalization and before execution.
 *
 * Pipeline:
 *   raw model output -> JSON extraction -> structural normalization
 *   -> DAG semantic validation (this module) -> executor
 */

import type { CommanderDagPlan } from "../commander-plan-schema";
import type { ToolDescriptor } from "@javis/tools";
import type {
  CompileCommanderPlanResult,
  CompiledCommanderPlan,
  PlanDiagnostic,
} from "./commander-plan-diagnostics";
import { isRepairable } from "./commander-plan-diagnostics";
import { validateCommanderPlan, type PlanValidationInput } from "./commander-plan-validator";
import { normalizeStepContract } from "../step-protocol";
import { normalizeAgentKind } from "../agents";

// --- Public API --------------------------------------------------------------

export interface CompileCommanderPlanInput {
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
}

/**
 * Compile a normalized CommanderDagPlan into a validated plan.
 *
 * Returns either a branded CompiledCommanderPlan (ok: true) or
 * a diagnostic report (ok: false). The executor should only proceed
 * with compiled plans.
 */
export function compileCommanderPlan(
  input: CompileCommanderPlanInput,
): CompileCommanderPlanResult {
  const normalizedPlan: CommanderDagPlan = {
    ...input.plan,
    steps: input.plan.steps.map((step) => {
      const toolCapabilities = step.toolName
        ? input.availableTools.find((tool) => tool.name === step.toolName)?.capabilityTags ?? []
        : [];
      const inferredPrimaryCapability = step.primaryCapability ??
        (step.capability || (step.requiredCapabilities?.length === 1
          ? step.requiredCapabilities[0]
          : undefined)) ??
        (toolCapabilities.length === 1 ? toolCapabilities[0] : undefined);
      return {
        ...step,
        assignedAgentKind: normalizeAgentKind(step.assignedAgentKind),
        ...(inferredPrimaryCapability ? { primaryCapability: inferredPrimaryCapability } : {}),
        ...normalizeStepContract({
          ...step,
          ...(inferredPrimaryCapability ? { primaryCapability: inferredPrimaryCapability } : {}),
        }),
      };
    }),
  };
  const validationInput: PlanValidationInput = {
    plan: normalizedPlan,
    availableAgents: input.availableAgents,
    availableTools: input.availableTools,
    existingSteps: input.existingSteps,
    supportedApprovalGatedTools: input.supportedApprovalGatedTools,
    preloadedContextKeys: input.preloadedContextKeys,
  };

  const diagnostics = validateCommanderPlan(validationInput);

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  if (errors.length > 0) {
    return {
      ok: false,
      diagnostics,
      repairable: isRepairable(diagnostics),
    };
  }

  return {
    ok: true,
    plan: normalizedPlan as CompiledCommanderPlan,
    warnings,
  };
}

export { formatDiagnosticSummary } from "./commander-plan-diagnostics";
export type { CompileCommanderPlanResult, CompiledCommanderPlan, PlanDiagnostic };
