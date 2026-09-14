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

import type { CommanderDagPlan, CommanderDagStep } from "../commander-plan-schema";
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
import { isSelfCapabilityQuestion, requiresExplicitTargetClarification } from "../agent-intent";
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
  // A question about the assistant itself ("你会做些什么", "what can you do") needs
  // no target, no workspace and no artifact: every fact its answer needs is in the
  // runtime. The planner prompt still tells the model to ask before guessing, so a
  // capability question can come back as a plan whose only step is that question —
  // observed as `clarify-capability-scope` asking "你希望我协助哪类任务？". Asking it
  // returns no information, so answer instead: replace a clarification-only plan
  // for a self-capability question with one Commander answer step. The substitution
  // is deterministic, so it costs no repair round, and it only fires when the model
  // planned nothing else — no work can be dropped.
  const answersSelfCapabilityQuestion = Boolean(
    input.userGoal &&
    !requiresClarification &&
    isSelfCapabilityQuestion(input.userGoal) &&
    normalizedPlan.steps.length > 0 &&
    normalizedPlan.steps.every(isClarificationOnlyStep),
  );
  const plan: CommanderDagPlan = answersSelfCapabilityQuestion
    ? { ...normalizedPlan, steps: [buildSelfCapabilityAnswerStep(input.userGoal as string)] }
    : normalizedPlan;

  const routeRequirements = input.userGoal
    ? inferCommanderRouteRequirements(input.userGoal).filter(
        (requirement) => !isEquivalentSpecialistRoute(requirement.reason, plan),
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
    plan,
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
  // Keep the substitution on the record: the plan that runs is not the plan the
  // model produced, and that difference must be visible in the plan trace.
  const warnings = [
    ...diagnostics.filter((d) => d.severity === "warning"),
    ...(answersSelfCapabilityQuestion ? [selfCapabilityAnswerDiagnostic(input.userGoal as string)] : []),
  ];

  if (errors.length > 0) {
    return {
      ok: false,
      diagnostics,
      repairable: isRepairable(diagnostics),
    };
  }

  return {
    ok: true,
    plan: plan as CompiledCommanderPlan,
    warnings,
  };
}

function isClarificationOnlyStep(step: CommanderDagStep): boolean {
  return step.assignedAgentKind === "commander" &&
    (step.toolName === "commander.askUser" ||
      step.capability === "clarification" ||
      step.primaryCapability === "clarification");
}

/**
 * The step that replaces a clarification-only plan for a self-capability
 * question. Mirrors the shape the model produces on its own once it decides to
 * answer ("answer-capabilities", Commander synthesis, direct response), so the
 * executor's synthesis path and its verifier step behave identically.
 */
function buildSelfCapabilityAnswerStep(userGoal: string): CommanderDagStep {
  const isChineseGoal = /[\u3400-\u9fff]/u.test(userGoal);
  return {
    id: "answer-capabilities",
    title: isChineseGoal
      ? "回答用户关于自身能力的问题"
      : "Answer the user's question about own capabilities",
    assignedAgentKind: "commander",
    executionMode: "direct_response",
    capability: "synthesis",
    primaryCapability: "synthesis",
    requiredCapabilities: [],
    dependsOn: [],
    successCriteria: isChineseGoal
      ? "用户得到一份清晰、真实、不含未执行操作声明的能力说明，且没有任何工具调用或文件写入。"
      : "The user receives an accurate capability description with no tool call or file write.",
  };
}

function selfCapabilityAnswerDiagnostic(userGoal: string): PlanDiagnostic {
  const isChineseGoal = /[\u3400-\u9fff]/u.test(userGoal);
  return {
    code: "SELF_CAPABILITY_ANSWER_SUBSTITUTED",
    severity: "warning",
    path: "steps",
    message: isChineseGoal
      ? "目标是在问助手自身能做什么：只澄清、不回答的计划已替换为一步指挥官直接回答。"
      : "The goal asks about the assistant's own capabilities: a clarification-only plan was replaced with one Commander answer step.",
    suggestedFix: isChineseGoal
      ? "无需修复：直接回答能力问题，不要再问用户想要哪类任务。"
      : "No fix needed: answer the capability question instead of asking which kind of task the user wants.",
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
