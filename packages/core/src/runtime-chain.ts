import { inferSpecialistAgentHints, isCodebaseUnderstandingRequest, isSpecialistAgentRequest } from "./agent-intent";
import type { RouteDecision } from "./local-router";
import type { WorkbenchWorkflowId } from "./workflows";

export type RuntimeChainStartMode = "auto" | "chat" | "project";

export type RuntimeChainDispatchKind =
  | "direct_chat"
  | "clarification"
  | "vision_task"
  | "single_agent_task"
  | "commander_task"
  | "legacy_fallback";

export interface RuntimeChainDecisionInput {
  userGoal: string;
  startMode: RuntimeChainStartMode;
  routeDecision: RouteDecision;
  recommendedWorkflowIds: WorkbenchWorkflowId[];
  hasChatTool: boolean;
  hasCommanderTool: boolean;
  hasKnownRouteIntent: boolean;
  hasVisionTask: boolean;
  hasUrl: boolean;
  isTextWriteGoal: boolean;
  isReadCurrentProjectGoal: boolean;
  isResearchGoal: boolean;
  isProjectInspectionGoal: boolean;
  isCodeReviewGoal: boolean;
  isPdfOrganizationGoal: boolean;
}

export interface RuntimeChainDecision {
  architecture: "hub_router_eventbus_dispatch";
  dispatch: {
    kind: RuntimeChainDispatchKind;
    reason: string;
  };
  routeDecision: RouteDecision;
  selectedCapabilities: string[];
  preferredAgentKinds: string[];
  recommendedWorkflowIds: WorkbenchWorkflowId[];
  surfaces: {
    user: "natural_response";
    commander: "natural_summary_and_structured_replay";
  };
}

export function decideRuntimeChain(input: RuntimeChainDecisionInput): RuntimeChainDecision {
  return {
    architecture: "hub_router_eventbus_dispatch",
    dispatch: decideDispatch(input),
    routeDecision: input.routeDecision,
    selectedCapabilities: inferSelectedCapabilities(input),
    preferredAgentKinds: inferPreferredAgentKinds(input),
    recommendedWorkflowIds: input.recommendedWorkflowIds,
    surfaces: {
      user: "natural_response",
      commander: "natural_summary_and_structured_replay",
    },
  };
}

function decideDispatch(input: RuntimeChainDecisionInput): RuntimeChainDecision["dispatch"] {
  if (input.routeDecision.customRoute) {
    return { kind: "single_agent_task", reason: "custom_route_workflow" };
  }

  if (input.startMode === "chat") {
    return input.hasChatTool
      ? { kind: "direct_chat", reason: "explicit_chat_mode" }
      : { kind: "clarification", reason: "chat_mode_without_chat_tool" };
  }

  // Agent/project mode is a capability ceiling: originMode stays project and
  // write/workflow goals keep Commander. A pure L1 casual greeting may still
  // use the direct model response so "你好" does not open a clarification card.
  // The caller labels that path as agent-mode direct response, not chat mode.
  if (
    (
      input.startMode !== "project" ||
      input.routeDecision.reasons.includes("casual_greeting")
    ) &&
    input.routeDecision.level === "L1" &&
    input.hasChatTool &&
    !input.hasKnownRouteIntent
  ) {
    return { kind: "direct_chat", reason: "simple_chat_without_known_agent_intent" };
  }

  if (input.hasVisionTask) {
    return { kind: "vision_task", reason: "vision_requires_multimodal_agent" };
  }

  if (shouldCommanderPlanTextWrite(input)) {
    return { kind: "commander_task", reason: "commander_handles_evidence_backed_write" };
  }

  if (input.isTextWriteGoal) {
    return { kind: "single_agent_task", reason: "text_write_requires_approval_flow" };
  }

  if (
    input.hasCommanderTool &&
    (isSpecialistAgentRequest(input.userGoal) || isCodebaseUnderstandingRequest(input.userGoal))
  ) {
    return { kind: "commander_task", reason: "commander_specialist_or_source_evidence_chain" };
  }

  if (input.startMode !== "project" && input.routeDecision.level === "L2") {
    return { kind: "single_agent_task", reason: "single_agent_route" };
  }

  if (input.hasCommanderTool) {
    return { kind: "commander_task", reason: "commander_primary_chain" };
  }

  return { kind: "legacy_fallback", reason: "commander_unavailable" };
}

function inferSelectedCapabilities(input: RuntimeChainDecisionInput): string[] {
  const capabilities = new Set<string>();
  capabilities.add("memory.search");

  if (input.hasUrl || input.isResearchGoal) {
    capabilities.add("web.search");
    capabilities.add("web.fetchSource");
  }
  if (input.isResearchGoal || input.recommendedWorkflowIds.includes("research-trending-topics")) {
    capabilities.add("trend.fetchHotList");
  }
  if (input.isTextWriteGoal) {
    capabilities.add("file.planWriteText");
    capabilities.add("file.writeText");
  }
  if (input.isReadCurrentProjectGoal || isCodebaseUnderstandingRequest(input.userGoal)) {
    capabilities.add("file.scanMarkdownDocuments");
    capabilities.add("shell.runReadOnlyCommand");
    capabilities.add("code.searchRepository");
    capabilities.add("code.traceCallChain");
  }
  if (input.isProjectInspectionGoal) {
    capabilities.add("shell.runReadOnlyCommand");
  }
  if (input.isCodeReviewGoal) {
    capabilities.add("code.inspectRepository");
    capabilities.add("code.searchRepository");
  }
  if (input.isPdfOrganizationGoal) {
    capabilities.add("file.planPdfOrganization");
  }
  if (input.hasVisionTask) {
    capabilities.add("vision.analyze");
  }

  for (const hint of inferSpecialistAgentHints(input.userGoal)) {
    for (const capability of hint.capabilities) {
      capabilities.add(capability);
    }
  }

  if (input.hasCommanderTool) {
    capabilities.add("commander.plan");
    capabilities.add("commander.dispatch");
  }

  return [...capabilities];
}

function inferPreferredAgentKinds(input: RuntimeChainDecisionInput): string[] {
  const agents = new Set<string>();

  if (
    input.hasCommanderTool &&
    ((input.routeDecision.level === "L3" && !input.isTextWriteGoal) || shouldCommanderPlanTextWrite(input))
  ) {
    agents.add("commander");
  }
  if (input.isReadCurrentProjectGoal || input.isCodeReviewGoal || isCodebaseUnderstandingRequest(input.userGoal)) {
    agents.add("code");
  }
  if (input.isTextWriteGoal || input.isPdfOrganizationGoal) {
    agents.add("file");
  }
  if (input.hasUrl || input.isResearchGoal) {
    agents.add("research");
  }
  if (input.isProjectInspectionGoal) {
    agents.add("shell");
  }
  if (input.hasVisionTask) {
    agents.add("vision");
  }

  for (const hint of inferSpecialistAgentHints(input.userGoal)) {
    agents.add(hint.agentKind);
  }

  return [...agents];
}

function shouldCommanderPlanTextWrite(input: RuntimeChainDecisionInput): boolean {
  if (!input.hasCommanderTool || !input.isTextWriteGoal) {
    return false;
  }
  return Boolean(
    input.hasUrl ||
    input.isReadCurrentProjectGoal ||
    input.isResearchGoal ||
    input.isProjectInspectionGoal ||
    input.isCodeReviewGoal ||
    input.isPdfOrganizationGoal ||
    input.recommendedWorkflowIds.length > 0 ||
    isSpecialistAgentRequest(input.userGoal) ||
    isCodebaseUnderstandingRequest(input.userGoal),
  );
}
