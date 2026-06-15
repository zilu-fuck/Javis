/**
 * Commander Plan Validator
 *
 * Semantic validation rules applied to a normalized CommanderDagPlan.
 * Each rule produces PlanDiagnostic entries; the compiler aggregates them.
 */

import type { CommanderDagPlan, CommanderDagStep, StepExecutionMode } from "../commander-plan-schema";
import type { ToolDescriptor } from "@javis/tools";
import { isValidCapabilityTag } from "../agent-capability";
import type { PlanDiagnostic } from "./commander-plan-diagnostics";
import { buildToolInputShape, type ToolRequiredInputShapeT } from "./schema";

// --- Validation Input --------------------------------------------------------

export interface PlanValidationInput {
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

// --- Validation Rules --------------------------------------------------------

// Required-input rules are read from the ToolDescriptor itself
// (`descriptor.requiredInputs`). This is the single source of truth shared
// with the planner prompt and the runtime dispatch guard. Any new required
// field should be added to the descriptor; the validator picks it up
// automatically.


export function validateCommanderPlan(input: PlanValidationInput): PlanDiagnostic[] {
  const {
    plan,
    availableAgents,
    availableTools,
    existingSteps,
    supportedApprovalGatedTools = [],
  } = input;
  const preloadedContextKeys = input.preloadedContextKeys ?? ["userGoal", "taskId"];

  const diagnostics: PlanDiagnostic[] = [];

  const agentKinds = new Set(availableAgents.map((a) => a.kind));
  const toolByName = new Map(availableTools.map((t) => [t.name, t]));
  const agentToolMap = new Map(
    availableAgents.map((a) => [a.kind, new Set(a.allowedToolNames)]),
  );

  const allSteps = [
    ...(existingSteps ?? []),
    ...plan.steps.map((s) => ({
      id: s.id,
      dependsOn: s.dependsOn,
      outputContextKey: s.outputContextKey,
    })),
  ];
  const allStepIds = new Set(allSteps.map((s) => s.id));

  // --- Rule: Duplicate Step IDs ----------------------------------------------
  const seenIds = new Map<string, number>();
  for (const step of plan.steps) {
    const prev = seenIds.get(step.id);
    if (prev !== undefined) {
      diagnostics.push({
        code: "DUPLICATE_STEP_ID",
        severity: "error",
        stepId: step.id,
        path: `steps[${seenIds.size}].id`,
        message: `Duplicate step id "${step.id}" (first seen at index ${prev}).`,
        suggestedFix: `Rename one of the duplicate step ids to be unique.`,
      });
    }
    seenIds.set(step.id, seenIds.size);
  }

  // --- Rule: Missing Dependency ----------------------------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    for (const dep of step.dependsOn) {
      if (!allStepIds.has(dep)) {
        diagnostics.push({
          code: "MISSING_DEPENDENCY",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].dependsOn`,
          message: `Step "${step.id}" depends on "${dep}" which does not exist.`,
          suggestedFix: `Remove the dependency or add a step with id "${dep}".`,
        });
      }
    }
  }

  // --- Rule: Dependency Not Prior --------------------------------------------
  // Only applies to model-generated steps (not existingSteps).
  const planStepIndex = new Map(plan.steps.map((s, i) => [s.id, i]));
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    for (const dep of step.dependsOn) {
      const depIndex = planStepIndex.get(dep);
      if (depIndex !== undefined && depIndex > i) {
        diagnostics.push({
          code: "DEPENDENCY_NOT_PRIOR",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].dependsOn`,
          message: `Step "${step.id}" depends on "${dep}" which appears later in the plan (index ${depIndex} > ${i}).`,
          suggestedFix: `Reorder steps so dependencies appear before dependents.`,
        });
      }
    }
  }

  // --- Rule: Cyclic Dependency -----------------------------------------------
  const cycleDiags = detectCycles(plan.steps);
  diagnostics.push(...cycleDiags);

  // --- Rule: Unknown Agent ---------------------------------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!agentKinds.has(step.assignedAgentKind)) {
      diagnostics.push({
        code: "UNKNOWN_AGENT",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].assignedAgentKind`,
        message: `Unknown agent kind "${step.assignedAgentKind}".`,
        suggestedFix: `Use one of: ${[...agentKinds].join(", ")}.`,
      });
    }
  }

  // --- Rule: Unknown / Unavailable Capabilities -----------------------------
  // Unknown capability tags are demoted to warnings ONLY when the step has a
  // toolName, so the executor can dispatch via the tool path. A step that
  // declares an unknown capability AND lacks a toolName cannot be routed at
  // runtime - promote the diagnostic to error so the planner is forced to
  // pick a recognised capability or attach a toolName.
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const allCaps = [
      ...(step.capability ? [step.capability] : []),
      ...step.requiredCapabilities,
    ];
    const hasToolFallback = typeof step.toolName === "string" && step.toolName.length > 0;
    for (const cap of allCaps) {
      if (!isValidCapabilityTag(cap)) {
        diagnostics.push({
          code: "UNKNOWN_CAPABILITY",
          severity: hasToolFallback ? "warning" : "error",
          stepId: step.id,
          path: `steps[${i}].capability`,
          message: hasToolFallback
            ? `Unknown capability tag "${cap}" - step has a toolName so dispatch will fall back, but capability tag should be corrected.`
            : `Unknown capability tag "${cap}" and no toolName - step cannot be dispatched.`,
          suggestedFix: `Use one of the recognized capability tags, or attach a toolName to the step.`,
        });
      }
    }
  }

  // --- Rule: Capability Not Available for Agent -----------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const requiredCaps = [
      ...(step.capability ? [step.capability] : []),
      ...step.requiredCapabilities,
    ];
    if (requiredCaps.length === 0) continue;

    const agent = availableAgents.find((a) => a.kind === step.assignedAgentKind);
    if (!agent) continue; // already flagged as UNKNOWN_AGENT

    for (const cap of requiredCaps) {
        // Skip availability check for non-canonical capability tags - they were
      // already flagged as UNKNOWN_CAPABILITY warnings.
      if (!isValidCapabilityTag(cap)) continue;

      const agentHasCap = agent.capabilities?.includes(cap);
      const agentTools = agentToolMap.get(step.assignedAgentKind) ?? new Set<string>();
      const toolCoversCap = [...agentTools].some((toolName) => {
        const desc = toolByName.get(toolName);
        return desc?.capabilityTags.includes(cap);
      });

      if (!agentHasCap && !toolCoversCap) {
        diagnostics.push({
          code: "CAPABILITY_NOT_AVAILABLE",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].requiredCapabilities`,
          message: `Capability "${cap}" is not available for agent "${step.assignedAgentKind}".`,
          suggestedFix: `Assign the step to an agent that supports "${cap}" or add a tool with this capability.`,
        });
      }
    }
  }

  // --- Rule: Unknown Tool ----------------------------------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.toolName) continue;
    if (!toolByName.has(step.toolName)) {
      diagnostics.push({
        code: "UNKNOWN_TOOL",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].toolName`,
        message: `Unknown tool "${step.toolName}".`,
      });
    }
  }

  // --- Rule: Tool Not Allowed for Agent -------------------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.toolName) continue;

    const agent = availableAgents.find((a) => a.kind === step.assignedAgentKind);
    if (!agent) continue; // already flagged

    const tool = toolByName.get(step.toolName);
    if (!tool) continue; // already flagged

    const agentAllowed = agentToolMap.get(step.assignedAgentKind) ?? new Set<string>();
    const isOwnedByAgent = tool.ownerAgentKinds.includes(step.assignedAgentKind);
    const isExplicitlyAllowed = agentAllowed.has(step.toolName);

    if (!isOwnedByAgent && !isExplicitlyAllowed) {
      diagnostics.push({
        code: "TOOL_NOT_ALLOWED",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].toolName`,
        message: `Tool "${step.toolName}" is not allowed for agent "${step.assignedAgentKind}".`,
        suggestedFix: `Assign the step to an agent that owns this tool, or use a different tool.`,
      });
    }
  }

  // --- Rule: Unsupported Approval-Gated Tool --------------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.toolName) continue;

    const tool = toolByName.get(step.toolName);
    if (!tool) continue; // already flagged

    const needsApproval = tool.permissionLevel === "confirmed_write" || tool.permissionLevel === "dangerous";
    if (needsApproval && !supportedApprovalGatedTools.includes(step.toolName)) {
      diagnostics.push({
        code: "UNSUPPORTED_APPROVAL_GATED_TOOL",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].toolName`,
        message: `Tool "${step.toolName}" requires approval but is not in the supported approval-gated tools list.`,
        suggestedFix: `Remove this step or add "${step.toolName}" to the supported approval-gated tools.`,
      });
    }
  }

  // --- Rule: Missing Required Tool Input ------------------------------------
  // Read the requirement set from the ToolDescriptor so the rule stays in
  // sync with whatever the planner prompt and runtime dispatch guard use.
  // Type and non-emptiness checks delegate to the Zod shape built from
  // the same required-input spec (single source of truth in ./schema.ts).
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.toolName) continue;

    const tool = toolByName.get(step.toolName);
    if (!tool) continue; // already flagged as UNKNOWN_TOOL
    const requiredInputs: ToolRequiredInputShapeT[] = (tool.requiredInputs ?? []) as ToolRequiredInputShapeT[];
    if (requiredInputs.length === 0) continue;

    const toolInputShape = buildToolInputShape(requiredInputs);
    const parsed = toolInputShape.safeParse(step.toolInput ?? {});
    if (parsed.success) continue;

    for (const issue of parsed.error.issues) {
      // Translate Zod issues to MISSING_TOOL_INPUT diagnostics. The Zod
      // `path` array points at the offending input field; for our
      // single-level `toolInput` map the first segment is the field
      // name. Empty path means the whole toolInput object was wrong.
      const fieldName = typeof issue.path[0] === "string" ? issue.path[0] : reqNameForIssue(issue);
      diagnostics.push({
        code: "MISSING_TOOL_INPUT",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].toolInput${fieldName ? `.${fieldName}` : ""}`,
        message: `Tool "${step.toolName}" toolInput: ${issue.message}.`,
        suggestedFix: `Adjust "${fieldName}" on the step's toolInput to match the tool's required shape.`,
      });
    }
  }

  // --- Rule: Invalid Execution Mode -----------------------------------------
  const validModes: StepExecutionMode[] = ["direct_response", "direct_tool_call", "react"];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.executionMode && !validModes.includes(step.executionMode)) {
      diagnostics.push({
        code: "INVALID_EXECUTION_MODE",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].executionMode`,
        message: `Invalid execution mode "${step.executionMode}".`,
        suggestedFix: `Use one of: ${validModes.join(", ")}.`,
      });
    }
  }

  // --- Rule: Execution Mode Constraints -------------------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.executionMode === "direct_tool_call") {
      const hasCap = step.capability || step.requiredCapabilities.length > 0;
      if (!step.toolName && !hasCap) {
        diagnostics.push({
          code: "INVALID_EXECUTION_MODE",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].executionMode`,
          message: `Step with executionMode "direct_tool_call" must have a toolName or resolvable capability.`,
          suggestedFix: `Add a toolName or capability to this step.`,
        });
      }
    }
    if (step.executionMode === "direct_response") {
      const nonSynthesisTools = step.toolName && step.toolName !== "commander.synthesize";
      if (nonSynthesisTools) {
        diagnostics.push({
          code: "INVALID_EXECUTION_MODE",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].executionMode`,
          message: `Step with executionMode "direct_response" declares tool "${step.toolName}", but the executor skips toolName in direct_response mode. The tool would be silently ignored.`,
          suggestedFix: `Either remove toolName (and let Commander synthesize the response) or change executionMode to "direct_tool_call" / "react".`,
        });
      }
    }
  }

  // --- Rule: Duplicate Output Context Key -----------------------------------
  const outputKeyOwners = new Map<string, string[]>();
  for (const step of plan.steps) {
    if (!step.outputContextKey) continue;
    const owners = outputKeyOwners.get(step.outputContextKey) ?? [];
    owners.push(step.id);
    outputKeyOwners.set(step.outputContextKey, owners);
  }
  for (const [key, owners] of outputKeyOwners) {
    if (owners.length > 1) {
      diagnostics.push({
        code: "DUPLICATE_OUTPUT_CONTEXT_KEY",
        severity: "error",
        stepId: owners[0],
        message: `Multiple steps write to outputContextKey "${key}": ${owners.join(", ")}.`,
        suggestedFix: `Use unique outputContextKey values or merge outputs explicitly.`,
      });
    }
  }

  // --- Rule: Missing Context Producer (Phase 2) -----------------------------
  // Promoted to error now that the preloaded key allowlist is explicit
  // (see DEFAULT_PRELOADED_CONTEXT_KEYS in shared-context.ts).
  const producedKeys = new Set<string>();
  const preloadedSet = new Set(preloadedContextKeys);
  for (const step of plan.steps) {
    // step:<id> keys are implicitly produced by the executor
    producedKeys.add(`step:${step.id}`);
    if (step.outputContextKey) {
      producedKeys.add(step.outputContextKey);
    }
  }
  // Existing steps also produce context
  for (const step of existingSteps ?? []) {
    producedKeys.add(`step:${step.id}`);
    if (step.outputContextKey) {
      producedKeys.add(step.outputContextKey);
    }
  }

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.inputContextKeys) continue;
    for (const key of step.inputContextKeys) {
      if (preloadedSet.has(key)) continue;
      if (!producedKeys.has(key)) {
        diagnostics.push({
          code: "MISSING_CONTEXT_PRODUCER",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].inputContextKeys`,
          message: `Context key "${key}" is read by step "${step.id}" but no producer step was found.`,
          suggestedFix: `Add a step that produces "${key}" (declare it in outputContextKey or in step:<id>), or add it to preloadedContextKeys.`,
        });
      }
    }
  }

  // --- Rule: Context Producer Not Depended On -------------------------------
  // Existing steps (from a recovery plan) and new plan steps are both
  // legitimate producers. Recovery steps must explicitly depend on the
  // existing step whose context they consume (transitively), the same
  // rule that already applies between new plan steps.
  const existingStepById = new Map<string, { id: string; outputContextKey?: string; dependsOn: string[] }>(
    (existingSteps ?? []).map((s) => [s.id, s]),
  );

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.inputContextKeys) continue;

    // Build the set of ancestors (steps this step depends on, transitively).
    // Walks BOTH new plan steps and existing steps so a recovery step
    // can read context from any ancestor in the combined DAG.
    const ancestors = new Set<string>();
    const queue: string[] = [...step.dependsOn];
    while (queue.length > 0) {
      const depId = queue.pop()!;
      if (ancestors.has(depId)) continue;
      ancestors.add(depId);
      const planDep = plan.steps.find((s) => s.id === depId);
      if (planDep) {
        queue.push(...planDep.dependsOn);
        continue;
      }
      const existingDep = existingStepById.get(depId);
      if (existingDep) {
        queue.push(...existingDep.dependsOn);
      }
    }

    for (const key of step.inputContextKeys) {
      if (preloadedSet.has(key)) continue;
      // Find which step produces this key - search both new and existing.
      const producerFromPlan = plan.steps.find(
        (s) => s.outputContextKey === key || `step:${s.id}` === key,
      );
      const producerFromExisting = (existingSteps ?? []).find(
        (s) => s.outputContextKey === key || `step:${s.id}` === key,
      );
      const producerId = producerFromPlan?.id ?? producerFromExisting?.id;
      if (!producerId) continue; // already flagged as MISSING_CONTEXT_PRODUCER
      if (producerId === step.id) continue; // reading own output is fine
      if (!ancestors.has(producerId)) {
        const isExisting = producerFromExisting !== undefined;
        const suggestedFix = isExisting
          ? `Add "${producerId}" (an existing step) to dependsOn of step "${step.id}", or add a new step that produces "${key}".`
          : `Add "${producerId}" to dependsOn of step "${step.id}".`;
        diagnostics.push({
          code: "CONTEXT_PRODUCER_NOT_DEPENDED_ON",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].inputContextKeys`,
          message: `Step "${step.id}" reads context key "${key}" produced by "${producerId}" but does not depend on it.`,
          suggestedFix,
        });
      }
    }
  }

  return diagnostics;
}

// --- Cycle Detection ---------------------------------------------------------

function detectCycles(steps: CommanderDagStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const adjacency = new Map<string, string[]>();
  for (const step of steps) {
    adjacency.set(step.id, step.dependsOn);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const step of steps) {
    color.set(step.id, WHITE);
  }

  function dfs(node: string, path: string[]): boolean {
    color.set(node, GRAY);
    path.push(node);
    for (const dep of adjacency.get(node) ?? []) {
      if (color.get(dep) === GRAY) {
        // Found cycle
        const cycleStart = path.indexOf(dep);
        const cyclePath = path.slice(cycleStart).concat(dep);
        diagnostics.push({
          code: "CYCLIC_DEPENDENCY",
          severity: "error",
          stepId: node,
          message: `Cyclic dependency detected: ${cyclePath.join(" -> ")}.`,
          suggestedFix: `Remove one of the dependencies in the cycle.`,
        });
        return true;
      }
      if (color.get(dep) === WHITE) {
        if (dfs(dep, path)) return true;
      }
    }
    path.pop();
    color.set(node, BLACK);
    return false;
  }

  for (const step of steps) {
    if (color.get(step.id) === WHITE) {
      dfs(step.id, []);
    }
  }

  return diagnostics;
}

/**
 * Resolve the required-input field name from a Zod issue. The Zod
 * issue's `path` for our `toolInput` map looks like `["path"]` or
 * `["paths", 0]`; we surface the leaf field name.
 */
function reqNameForIssue(issue: { path: ReadonlyArray<PropertyKey> }): string {
  for (let i = issue.path.length - 1; i >= 0; i--) {
    const segment = issue.path[i];
    if (typeof segment === "string") return segment;
  }
  return "";
}
