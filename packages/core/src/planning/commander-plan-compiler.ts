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
import { getRoleCapabilityTagsForAgentKind } from "../agent-capability";
import type { CommanderPlanIntents } from "./plan-legality";
import { requiresExplicitTargetClarification } from "../agent-intent";
import {
  inferCommanderRouteRequirements,
  resolveCommanderRouteAvailability,
} from "./commander-route-contract";

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
  /** User intents from the Layer-5 pre-filter (see plan-legality.ts). */
  planIntents: CommanderPlanIntents;
  /** Raw user goal used only for deterministic routing and clarification constraints. */
  userGoal?: string;
  /** Set only when a trusted UI/runtime input has resolved an otherwise deictic target. */
  hasResolvedTarget?: boolean;
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
  const requiresClarification = input.userGoal
    ? requiresExplicitTargetClarification(input.userGoal, {
        hasResolvedTarget: input.hasResolvedTarget,
      })
    : false;
  const normalizedPlan: CommanderDagPlan = {
    ...input.plan,
    steps: input.plan.steps.map((step) => {
      const assignedAgentKind = normalizeAgentKind(step.assignedAgentKind);
      const toolCapabilities = step.toolName
        ? input.availableTools.find((tool) => tool.name === step.toolName)?.capabilityTags ?? []
        : [];
      const registeredAgentCapabilities = input.availableAgents.find(
        (agent) => normalizeAgentKind(agent.kind) === assignedAgentKind,
      )?.capabilities ?? [];
      const roleCapabilities = getRoleCapabilityTagsForAgentKind(assignedAgentKind)
        .filter((capability) => registeredAgentCapabilities.includes(capability));
      const inferredPrimaryCapability = step.primaryCapability ??
        (step.capability || (step.requiredCapabilities?.length === 1
          ? step.requiredCapabilities[0]
          : undefined)) ??
        (toolCapabilities.length === 1 ? toolCapabilities[0] : undefined) ??
        (step.executionMode === "react" && roleCapabilities.length === 1
          ? roleCapabilities[0]
          : undefined);
      return {
        ...step,
        assignedAgentKind,
        ...(inferredPrimaryCapability ? { primaryCapability: inferredPrimaryCapability } : {}),
        ...normalizeStepContract({
          ...step,
          ...(inferredPrimaryCapability ? { primaryCapability: inferredPrimaryCapability } : {}),
        }),
      };
    }),
  };
  const routeRequirements = input.userGoal
    ? inferCommanderRouteRequirements(input.userGoal).filter(
        (requirement) => !isEquivalentSpecialistRoute(requirement.reason, normalizedPlan),
      )
    : [];
  const routeAvailability = input.userGoal && !requiresClarification
    ? resolveCommanderRouteAvailability(
        routeRequirements,
        input.availableAgents,
        input.availableTools,
      )
    : [];
  const validationInput: PlanValidationInput = {
    plan: normalizedPlan,
    availableAgents: input.availableAgents,
    availableTools: input.availableTools,
    existingSteps: input.existingSteps,
    supportedApprovalGatedTools: input.supportedApprovalGatedTools,
    preloadedContextKeys: input.preloadedContextKeys,
    planIntents: input.planIntents,
    requiresClarification,
    requiredAgentRoutes: routeAvailability
      .filter((route) => route.available)
      .map((route) => route.requirement),
    unavailableAgentRoutes: routeAvailability.filter((route) => !route.available),
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

function isEquivalentSpecialistRoute(
  routeReason: string,
  plan: CommanderDagPlan,
): boolean {
  if (routeReason === "file_persistence_intent") {
    return plan.steps.some((step) =>
      step.assignedAgentKind === "doc-updater" &&
      step.toolName === "file.writeText"
    );
  }
  if (routeReason !== "public_research_intent") return false;
  return plan.steps.some((step) =>
    step.assignedAgentKind === "page-agent" &&
    step.executionMode === "react" &&
    [step.primaryCapability, step.capability, ...(step.requiredCapabilities ?? [])]
      .includes("browser_navigate")
  );
}

export { formatDiagnosticSummary } from "./commander-plan-diagnostics";
export type { CompileCommanderPlanResult, CompiledCommanderPlan, PlanDiagnostic };
