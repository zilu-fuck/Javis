/**
 * Commander Plan Validator
 *
 * Semantic validation rules applied to a normalized CommanderDagPlan.
 * Each rule produces PlanDiagnostic entries; the compiler aggregates them.
 */

import type { CommanderDagPlan, CommanderDagStep, StepExecutionMode } from "../commander-plan-schema";
import { validateToolSchema, type ToolDescriptor } from "@javis/tools";
import { isRoleCapabilityForAgentKind, isValidCapabilityTag } from "../agent-capability";
import type { PlanDiagnostic } from "./commander-plan-diagnostics";
import { buildToolInputShape, type ToolRequiredInputShapeT } from "./schema";
import {
  findSensitiveToolInputKeys,
  hasPathTraversalSegment,
  isAbsolutePathLike,
  PLAN_CONTEXT_KEY_PATTERN,
  type CommanderPlanIntents,
} from "./plan-legality";
import type {
  CommanderRouteAvailability,
  CommanderRouteRequirement,
} from "./commander-route-contract";

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
  /** User intents recognized from the goal by the Layer 5 pre-filter. */
  planIntents: CommanderPlanIntents;
  requiredAgentRoutes?: CommanderRouteRequirement[];
  unavailableAgentRoutes?: CommanderRouteAvailability[];
  requiresClarification?: boolean;
}

// --- Validation Rules --------------------------------------------------------

// Required-input rules are read from the ToolDescriptor itself
// (`descriptor.requiredInputs`). This is the single source of truth shared
// with the planner prompt and the runtime dispatch guard. Any new required
// field should be added to the descriptor; the validator picks it up
// automatically.

const COMPUTER_USE_APPROVAL_CAPABILITIES = new Set([
  "desktop_focus",
  "desktop_ui_input",
  "desktop_input",
]);

function isDeterministicProjectEvidenceStep(step: CommanderDagStep): boolean {
  return step.assignedAgentKind === "code" &&
    step.toolName === "code.inspectWorkspace" &&
    step.executionMode === "direct_tool_call";
}

function isUnderspecifiedProjectExplorationStep(step: CommanderDagStep): boolean {
  return step.assignedAgentKind === "explorer" ||
    stepCapabilities(step).includes("code_explore");
}

function isApprovalGatedTool(tool: ToolDescriptor): boolean {
  return tool.permissionLevel === "confirmed_write" || tool.permissionLevel === "dangerous";
}

function stepCapabilities(step: CommanderDagStep): string[] {
  return [...new Set([
    ...(step.primaryCapability ? [step.primaryCapability] : []),
    ...(step.capability ? [step.capability] : []),
    ...step.requiredCapabilities,
  ])];
}

function isComputerUseApprovalLoopStep(step: CommanderDagStep, capabilities: readonly string[]): boolean {
  return step.assignedAgentKind === "computer" &&
    capabilities.some((capability) => COMPUTER_USE_APPROVAL_CAPABILITIES.has(capability));
}

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

  // An empty plan has no work to do: executing it would report success without
  // doing anything. Clarification plans still carry an explicit commander.askUser
  // step (`requiresClarification` below requires one), so this never rejects a
  // legitimate shape.
  if (plan.steps.length === 0) {
    diagnostics.push({
      code: "INVALID_PLAN_SHAPE",
      severity: "error",
      path: "steps",
      message: "Commander plan must contain at least one step.",
      suggestedFix:
        "Emit at least one step, or ask the user a clarifying question through commander.askUser.",
    });
  }

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

  if (input.requiresClarification === true) {
    const hasReadyClarificationStep = plan.steps.some((step) =>
      step.assignedAgentKind === "commander" &&
      (step.toolName === "commander.askUser" || step.capability === "clarification") &&
      step.dependsOn.length === 0,
    );
    if (!hasReadyClarificationStep) {
      diagnostics.push({
        code: "MISSING_REQUIRED_CLARIFICATION",
        severity: "error",
        path: "steps",
        message: "The goal uses an unresolved code/file reference, but the plan starts work without asking what target the user means.",
        suggestedFix: "Replace exploratory work with a dependency-free Commander commander.askUser step that asks for the file path, symbol, selection, or pasted code.",
      });
    }
  }

  for (const route of input.requiredAgentRoutes ?? []) {
    if (!plan.steps.some((step) => step.assignedAgentKind === route.agentKind)) {
      diagnostics.push({
        code: "MISSING_REQUIRED_AGENT_ROUTE",
        severity: "error",
        path: "steps",
        message: `The user goal requires ${route.agentKind} (${route.reason}), but the plan does not assign that route.`,
        suggestedFix: `Assign the ${route.reason} work to ${route.agentKind}; use other agents only for distinct evidence or verification.`,
      });
    }
    for (const toolName of route.requiredToolNames) {
      if (plan.steps.some((step) =>
        step.assignedAgentKind === route.agentKind && step.toolName === toolName
      )) {
        continue;
      }
      diagnostics.push({
        code: "MISSING_REQUIRED_ROUTE_TOOL",
        severity: "error",
        path: "steps",
        message: `${route.agentKind} must use ${toolName} for ${route.reason}.`,
        suggestedFix: `Add a ${route.agentKind} direct_tool_call step using ${toolName} with the descriptor-required inputs.`,
      });
    }
    const requiredAnyToolNames = route.requiredAnyToolNames ?? [];
    if (
      requiredAnyToolNames.length > 0 &&
      !plan.steps.some((step) =>
        step.assignedAgentKind === route.agentKind &&
        Boolean(step.toolName) &&
        requiredAnyToolNames.includes(step.toolName!)
      )
    ) {
      diagnostics.push({
        code: "MISSING_REQUIRED_ROUTE_TOOL",
        severity: "error",
        path: "steps",
        message: `${route.agentKind} must use one of ${requiredAnyToolNames.join(", ")} for ${route.reason}.`,
        suggestedFix: `Add a ${route.agentKind} direct_tool_call step using one available tool from that set with descriptor-required inputs.`,
      });
    }
  }

  for (const route of input.unavailableAgentRoutes ?? []) {
    const missing = [
      ...(route.missingAgent ? [`agent ${route.requirement.agentKind}`] : []),
      ...route.missingToolNames.map((toolName) => `tool ${toolName}`),
      ...(route.missingRequiredAnyToolNames.length > 0
        ? [`one of ${route.missingRequiredAnyToolNames.join(", ")}`]
        : []),
      ...(route.missingAvailabilityToolNames.length > 0
        ? [`one of ${route.missingAvailabilityToolNames.join(", ")}`]
        : []),
    ];
    diagnostics.push({
      code: "REQUIRED_ROUTE_UNAVAILABLE",
      severity: "warning",
      path: "steps",
      message: `The ${route.requirement.reason} route is unavailable because ${missing.join("; ")} is not enabled.`,
      suggestedFix: "Do not substitute an unrelated agent or claim the operation completed; report the unavailable capability or ask the user to enable it.",
    });
  }

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
    const requiredCaps = stepCapabilities(step);
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

    if (!isOwnedByAgent || !isExplicitlyAllowed) {
      diagnostics.push({
        code: "TOOL_NOT_ALLOWED",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].toolName`,
        message: `Tool "${step.toolName}" is not both owned and explicitly allowed for agent "${step.assignedAgentKind}".`,
        suggestedFix: `Assign the step to an owning agent whose effective allowlist includes this tool, or use a different tool.`,
      });
    }
  }

  // --- Rule: Unsupported Approval-Gated Tool --------------------------------
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step.toolName) continue;

    const tool = toolByName.get(step.toolName);
    if (!tool) continue; // already flagged

    const needsApproval = isApprovalGatedTool(tool);
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

  // --- Rule: Approval-Gated Capability Needs Explicit Tool ------------------
  // Capability-only steps cannot validate required toolInput or pick a safe
  // approval runner when multiple tools share a capability tag. Keep Computer
  // Use loops as the intentional exception: they approve concrete actions
  // inside the loop rather than at DAG compile time.
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.toolName) continue;

    const capabilities = stepCapabilities(step).filter(isValidCapabilityTag);
    if (capabilities.length === 0 || isComputerUseApprovalLoopStep(step, capabilities)) continue;

    const approvalTools = availableTools.filter((tool) =>
      tool.ownerAgentKinds.includes(step.assignedAgentKind) &&
      isApprovalGatedTool(tool) &&
      capabilities.some((capability) => tool.capabilityTags.includes(capability))
    );
    if (approvalTools.length === 0) continue;

    diagnostics.push({
      code: "MISSING_APPROVAL_TOOL_SELECTION",
      severity: "error",
      stepId: step.id,
      path: `steps[${i}].toolName`,
      message: `Step capability "${capabilities.join(", ")}" resolves to approval-gated tool(s) ${approvalTools.map((tool) => `"${tool.name}"`).join(", ")} but no explicit toolName was provided.`,
      suggestedFix: `Set toolName to the exact supported approval-gated tool and include its required toolInput so the dedicated approval runner can validate and execute it.`,
    });
  }

  // --- Rule: Capability-only steps with required inputs --------------------
  // A capability tag may map to more than one concrete tool. If any
  // allowlisted candidate needs fields, implicit selection would make the
  // input contract ambiguous and could defer a missing field until dispatch.
  // Require the planner to name the concrete tool and provide its input.
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.toolName) continue;
    const capabilities = stepCapabilities(step).filter(isValidCapabilityTag);
    if (capabilities.length === 0 || isComputerUseApprovalLoopStep(step, capabilities)) continue;
    if (step.executionMode === "react") continue;
    const agentAllowed = agentToolMap.get(step.assignedAgentKind) ?? new Set<string>();
    const candidate = availableTools.find((tool) =>
      agentAllowed.has(tool.name) &&
      tool.ownerAgentKinds.includes(step.assignedAgentKind) &&
      capabilities.some((capability) => tool.capabilityTags.includes(capability)) &&
      (tool.requiredInputs?.length ?? 0) > 0,
    );
    if (!candidate) continue;
    diagnostics.push({
      code: "MISSING_TOOL_INPUT",
      severity: "error",
      stepId: step.id,
      path: `steps[${i}].toolName`,
      message: `Capability-only step resolves to tool "${candidate.name}" which requires explicit toolName and toolInput fields.`,
      suggestedFix: `Set toolName to "${candidate.name}" and provide every required toolInput field declared by its descriptor.`,
    });
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
    if (tool.inputSchema) {
      const schemaError = validateToolSchema(
        tool.inputSchema,
        step.toolInput ?? {},
        `Tool ${tool.name} input`,
      );
      if (schemaError) {
        diagnostics.push({
          code: "MISSING_TOOL_INPUT",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].toolInput`,
          message: schemaError,
          suggestedFix: `Adjust the toolInput for "${tool.name}" to match its declared input schema.`,
        });
        continue;
      }
    }
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
      // Runtime dispatch merges declared SharedContext inputs into toolInput.
      // A same-named context key can therefore satisfy this field; context
      // existence and producer ordering are validated by the handoff rules.
      if (fieldName && step.inputContextKeys?.includes(fieldName)) {
        continue;
      }
      // file.writeText derives content from a declared upstream artifact;
      // keep targetPath static while letting the runtime validate evidence.
      if (
        fieldName === "content" &&
        step.toolName === "file.writeText" &&
        consumesProducerArtifact(
          step,
          plan.steps,
          existingSteps ?? [],
          new Set(preloadedContextKeys),
        )
      ) {
        continue;
      }
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
  const validModes: StepExecutionMode[] = [
    "direct_response",
    "direct_tool_call",
    "react",
    "desktop_input",
  ];
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
    if (step.executionMode === "react" && !step.primaryCapability) {
      diagnostics.push({
        code: "MISSING_PRIMARY_CAPABILITY",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].primaryCapability`,
        message: `React step "${step.id}" must declare exactly one primaryCapability for backend routing.`,
        suggestedFix: "Set primaryCapability to the single capability that owns this Agent loop.",
      });
    }
    if (step.executionMode === "desktop_input" && step.assignedAgentKind !== "computer") {
      diagnostics.push({
        code: "INVALID_EXECUTION_MODE",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].executionMode`,
        message: `executionMode "desktop_input" is reserved for the computer Agent.`,
        suggestedFix: `Assign the step to agent kind "computer" or choose another execution mode.`,
      });
    }
    const selectsCommanderSynthesis = step.toolName === "commander.synthesize" ||
      (step.assignedAgentKind === "commander" && !step.toolName && (
        step.capability === "synthesis" ||
        step.requiredCapabilities.includes("synthesis")
      ));
    if (
      selectsCommanderSynthesis &&
      step.executionMode !== undefined &&
      step.executionMode !== "direct_response"
    ) {
      diagnostics.push({
        code: "INVALID_EXECUTION_MODE",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].executionMode`,
        message: `Commander synthesis must use executionMode "direct_response" so its conclusion passes the evidence guard.`,
        suggestedFix: `Set executionMode to "direct_response" for commander.synthesize/synthesis steps.`,
      });
    }
    const roleCapabilities = stepCapabilities(step).filter((capability) =>
      isRoleCapabilityForAgentKind(step.assignedAgentKind, capability)
    );
    if (
      !step.toolName &&
      roleCapabilities.length > 0 &&
      step.executionMode !== undefined &&
      step.executionMode !== "react"
    ) {
      diagnostics.push({
        code: "INVALID_EXECUTION_MODE",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].executionMode`,
        message: `Agent role capability "${roleCapabilities[0]}" must use executionMode "react" so the agent can select from its safe toolset.`,
        suggestedFix: `Set executionMode to "react" or omit it to use the role-capability default.`,
      });
    }
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

  // --- Rule: file.writeText conditional constraints --------------------------
  // Compile-enforced counterparts of the prompt's conditional rules:
  //  - file.writeText must run as direct_tool_call (the dedicated approval
  //    runner cannot drive it from a react/direct_response step);
  //  - toolInput.targetPath must be a workspace-relative path. This is a
  //    lexical pre-check; real path safety is enforced by path resolution,
  //    workspace containment, and symlink checks at the write boundary.
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.toolName !== "file.writeText") continue;
    if (step.executionMode !== undefined && step.executionMode !== "direct_tool_call") {
      diagnostics.push({
        code: "INVALID_EXECUTION_MODE",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].executionMode`,
        message: `file.writeText step "${step.id}" must use executionMode "direct_tool_call", not "${step.executionMode}".`,
        suggestedFix: `Set executionMode to "direct_tool_call" for the file.writeText step.`,
      });
    }
    const targetPath = step.toolInput?.targetPath;
    if (typeof targetPath === "string" && targetPath.trim()) {
      if (isAbsolutePathLike(targetPath)) {
        diagnostics.push({
          code: "UNSAFE_WRITE_PATH",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].toolInput.targetPath`,
          message: `file.writeText targetPath "${targetPath}" is an absolute path; write targets must be workspace-relative.`,
          suggestedFix: `Replace targetPath with a workspace-relative path such as "reports/result.md".`,
        });
      } else if (hasPathTraversalSegment(targetPath)) {
        diagnostics.push({
          code: "UNSAFE_WRITE_PATH",
          severity: "error",
          stepId: step.id,
          path: `steps[${i}].toolInput.targetPath`,
          message: `file.writeText targetPath "${targetPath}" contains a ".." traversal segment.`,
          suggestedFix: `Remove ".." segments so the target stays inside the selected workspace.`,
        });
      }
    }
  }

  // --- Rule: no write steps without a user persistence intent -----------------
  // Layer 5 deterministic filter: when the user never asked to persist,
  // export, or produce a document artifact, the planner must not add
  // document-write tools on its own — the answer belongs in the final
  // response instead.
  if (input.planIntents?.write !== true) {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const descriptor = step.toolName ? toolByName.get(step.toolName) : undefined;
      if (descriptor?.requiredPlanIntent !== "write") continue;
      diagnostics.push({
        code: "WRITE_WITHOUT_USER_INTENT",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].toolName`,
        message: `Step "${step.id}" uses ${descriptor.name}, but the user goal has no persistence/export intent.`,
        suggestedFix: `Remove the ${descriptor.name} step and deliver the result in the final response, or keep it only if the user explicitly asked to save/export a file.`,
      });
    }
  }

  // --- Rule: project understanding uses repository-aware agents -------------
  // Computer owns generic local-browsing tools, but a directory listing alone
  // cannot establish module boundaries, entrypoints, or code risks. Unless the
  // user explicitly requests GUI/File Explorer interaction, keep Computer out
  // of this evidence chain and require repository-aware evidence.
  if (input.planIntents?.projectUnderstanding === true && input.planIntents.desktopInteraction !== true) {
    const projectEvidenceSteps = plan.steps.filter(isDeterministicProjectEvidenceStep);
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const isComputerBrowsing = step.assignedAgentKind === "computer";
      const isUnsupportedInitialExploration =
        projectEvidenceSteps.length === 0 && isUnderspecifiedProjectExplorationStep(step);
      if (!isComputerBrowsing && !isUnsupportedInitialExploration) continue;
      diagnostics.push({
        code: "MISROUTED_PROJECT_INSPECTION",
        severity: "error",
        stepId: step.id,
        path: `steps[${i}].assignedAgentKind`,
        message: isComputerBrowsing
          ? `Project-understanding step "${step.id}" is assigned to Computer Agent even though the user did not request desktop interaction.`
          : `Project-understanding step "${step.id}" uses Explorer/code_explore before a deterministic repository evidence artifact exists.`,
        suggestedFix: `Replace the initial evidence step with Code Agent + code.inspectWorkspace + direct_tool_call; preserve its outputContextKey for verifier/Commander handoff. code.searchRepository and Explorer may only add supplemental tracing after that artifact exists.`,
      });
    }

    if (projectEvidenceSteps.length === 0) {
      diagnostics.push({
        code: "MISSING_PROJECT_EVIDENCE_STEP",
        severity: "error",
        path: "steps",
        message: "Project-understanding plan has no deterministic Code Agent workspace inventory step, so directory, module, and risk conclusions would be unsupported.",
        suggestedFix: `Add Code Agent + code.inspectWorkspace + direct_tool_call, write its outputContextKey, then have verifier and final Commander consume that artifact.`,
      });
    } else {
      const projectEvidenceKeys = new Set(projectEvidenceSteps.flatMap((step) => [
        `step:${step.id}`,
        ...(step.outputContextKey ? [step.outputContextKey] : []),
      ]));
      const projectVerifierSteps = plan.steps.filter((step) =>
        isVerifierStep(step) &&
        (step.inputContextKeys ?? []).some((key) => projectEvidenceKeys.has(key))
      );

      if (projectVerifierSteps.length === 0) {
        diagnostics.push({
          code: "MISSING_VERIFIER",
          severity: "error",
          path: "steps",
          message: "Project-understanding evidence is not consumed by an independent verifier step.",
          suggestedFix: "Add verifier.check/evidence_check after the repository evidence step and consume its outputContextKey or step:<id> artifact.",
        });
      }

      const verifierEvidenceKeys = new Set(projectVerifierSteps.flatMap((step) => [
        `step:${step.id}`,
        ...(step.outputContextKey ? [step.outputContextKey] : []),
      ]));
      const hasProjectSynthesisStep = plan.steps.some((step) =>
        step.assignedAgentKind === "commander" &&
        isUserVisibleSynthesisStep(step) &&
        (step.inputContextKeys ?? []).some((key) => projectEvidenceKeys.has(key)) &&
        (step.inputContextKeys ?? []).some((key) => verifierEvidenceKeys.has(key))
      );
      if (!hasProjectSynthesisStep) {
        diagnostics.push({
          code: "MISSING_PROJECT_SYNTHESIS_STEP",
          severity: "error",
          path: "steps",
          message: "Project-understanding plan has no final Commander step that consumes both repository evidence and its verifier result.",
          suggestedFix: "Add a Commander direct_response/commander.synthesize step after the verifier and list both the repository evidence key and verifier output key in inputContextKeys.",
        });
      }
    }
  }

  // --- Rule: context key format ------------------------------------------------
  // Lexical format check for handoff keys (camelCase identifiers or the
  // implicit step:<id> form). Warning only — unknown formats still flow
  // through SharedContext, but they almost always indicate a typo.
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const keys = [
      ...(step.inputContextKeys ?? []),
      ...(step.outputContextKey ? [step.outputContextKey] : []),
    ];
    for (const key of keys) {
      if (!PLAN_CONTEXT_KEY_PATTERN.test(key)) {
        diagnostics.push({
          code: "INVALID_CONTEXT_KEY_FORMAT",
          severity: "warning",
          stepId: step.id,
          path: `steps[${i}].inputContextKeys`,
          message: `Context key "${key}" is not a camelCase identifier or step:<id> reference.`,
          suggestedFix: `Rename the key to camelCase (e.g. "uiEvidence") or use "step:<step-id>".`,
        });
      }
    }
  }

  // --- Rule: secret-looking values in toolInput --------------------------------
  // Plans must never carry credentials. Warning only: the value may be a
  // false positive, but it should be reviewed before execution.
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const sensitiveKeys = findSensitiveToolInputKeys(step.toolInput);
    for (const key of sensitiveKeys) {
      diagnostics.push({
        code: "SENSITIVE_DATA_IN_TOOL_INPUT",
        severity: "warning",
        stepId: step.id,
        path: `steps[${i}].toolInput.${key}`,
        message: `toolInput."${key}" looks like a credential; plans must not carry secrets.`,
        suggestedFix: `Remove "${key}" from toolInput; credentials belong to the OS credential store, never to plan JSON.`,
      });
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

  // --- Rule: Evidence-backed synthesis requires an independent verifier -----
  // Internal worker handoffs are not user-visible claims by themselves.  Gate
  // only the point where a user-facing synthesis step actually consumes a
  // non-preloaded producer artifact.  This keeps small/legacy direct-response
  // plans and tool-only DAGs valid while ensuring evidence-backed answers are
  // independently checked. Recovery plans are compiled against an existing
  // DAG and may rely on its verifier.
  if (!existingSteps || existingSteps.length === 0) {
    const verifierSteps = plan.steps.filter(isVerifierStep);
    const verifierToolAvailable = availableTools.some((tool) =>
      tool.name === "verifier.check" || tool.capabilityTags.includes("evidence_check"),
    );
    const preloadedSet = new Set(preloadedContextKeys);
    const explicitSynthesisStep = plan.steps.find((step) =>
      isUserVisibleSynthesisStep(step) &&
      consumesProducerArtifact(step, plan.steps, existingSteps ?? [], preloadedSet),
    );
    const synthesisEvidenceStep = explicitSynthesisStep;
    if (
      synthesisEvidenceStep &&
      verifierSteps.length === 0 &&
      verifierToolAvailable &&
      !diagnostics.some((diagnostic) => diagnostic.code === "MISSING_VERIFIER")
    ) {
      diagnostics.push({
        code: "MISSING_VERIFIER",
        severity: "error",
        stepId: synthesisEvidenceStep.id,
        path: `steps[${plan.steps.indexOf(synthesisEvidenceStep)}]`,
        message: "Evidence-backed user-visible synthesis requires an independent verifier step.",
        suggestedFix: "Add a verifier agent step using verifier.check/evidence_check and connect it to a producer artifact before synthesis.",
      });
    }
  }

  // Every verifier must consume at least one artifact produced by another
  // step.  Preloaded values such as userGoal/taskId are task metadata, not
  // independent evidence and cannot satisfy this gate.
  const verifierSteps = plan.steps.filter(isVerifierStep);
  for (const verifier of verifierSteps) {
    const verifierIndex = plan.steps.indexOf(verifier);
    const producerKeys = (verifier.inputContextKeys ?? [])
      .filter((key) => !preloadedSet.has(key))
      .filter((key) => {
        const producer = plan.steps.find(
          (candidate) => candidate.id !== verifier.id &&
            (candidate.outputContextKey === key || `step:${candidate.id}` === key),
        ) ?? (existingSteps ?? []).find(
          (candidate) => candidate.id !== verifier.id &&
            (candidate.outputContextKey === key || `step:${candidate.id}` === key),
        );
        return producer !== undefined;
      });
    if (producerKeys.length === 0) {
      diagnostics.push({
        code: "VERIFIER_MISSING_EVIDENCE",
        severity: "error",
        stepId: verifier.id,
        path: `steps[${verifierIndex}].inputContextKeys`,
        message: `Verifier step "${verifier.id}" must consume at least one non-preloaded producer artifact.`,
        suggestedFix: "Add an upstream producer outputContextKey and list that key in the verifier inputContextKeys (with a dependsOn edge).",
      });
    }
  }

  return diagnostics;
}

function isVerifierStep(step: CommanderDagStep): boolean {
  return step.assignedAgentKind === "verifier" ||
    step.toolName === "verifier.check" ||
    step.capability === "evidence_check" ||
    step.requiredCapabilities.includes("evidence_check");
}

function isUserVisibleSynthesisStep(step: CommanderDagStep): boolean {
  return step.toolName === "commander.synthesize" ||
    (step.assignedAgentKind === "commander" && (
      step.capability === "synthesis" ||
      step.requiredCapabilities.includes("synthesis")
    )) ||
    step.executionMode === "direct_response";
}

function consumesProducerArtifact(
  step: CommanderDagStep,
  planSteps: readonly CommanderDagStep[],
  existingSteps: readonly NonNullable<PlanValidationInput["existingSteps"]>[number][],
  preloadedContextKeys: ReadonlySet<string>,
): boolean {
  return (step.inputContextKeys ?? []).some((key) => {
    if (preloadedContextKeys.has(key)) return false;
    return planSteps.some((candidate) =>
      candidate.id !== step.id &&
      (candidate.outputContextKey === key || `step:${candidate.id}` === key),
    ) || existingSteps.some((candidate) =>
      candidate.id !== step.id &&
      (candidate.outputContextKey === key || `step:${candidate.id}` === key),
    );
  });
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
