import type {
  AgentRouteRequest,
  AgentRuntimeFallbackReason,
  WorkflowExecutionBackend,
} from "./contracts";

const OPENCODE_CAPABILITIES = new Set([
  "code_search",
  "code_trace",
  "code_propose",
  "language_review",
  "security_review",
  "code_explore",
  "performance_analysis",
  "build_fix",
  "test_run",
  "refactor",
]);

export interface AgentRuntimeAvailability {
  langchain: boolean;
  opencode: boolean;
  javisSpecialized?: boolean;
  legacyFallback?: boolean;
}

export interface AgentRouteResolution {
  backend: WorkflowExecutionBackend;
  selectionReason: string;
  fallbackReason?: AgentRuntimeFallbackReason;
}

export function routeAgentRuntime(
  request: AgentRouteRequest,
  availability: AgentRuntimeAvailability,
): AgentRouteResolution {
  if (request.executionMode === "direct_tool_call") {
    return {
      backend: "direct",
      selectionReason: `execution_mode:${request.executionMode}`,
    };
  }
  if (request.executionMode === "direct_response") {
    return hasModelProfile(request)
      ? {
          backend: "direct",
          selectionReason: `execution_mode:${request.executionMode}`,
        }
      : { backend: "unavailable", selectionReason: "missing_model_profile" };
  }
  if (request.executionMode === "desktop_input") {
    if (request.permissionLevel === "confirmed_write" ||
        request.permissionLevel === "dangerous") {
      return {
        backend: "unavailable",
        selectionReason: `agent_runtime_forbidden_for_permission:${request.permissionLevel}`,
      };
    }
    if (!hasModelProfile(request)) {
      return { backend: "unavailable", selectionReason: "missing_model_profile" };
    }
    return availability.javisSpecialized === false
      ? { backend: "unavailable", selectionReason: "javis_specialized_unavailable" }
      : { backend: "javis_specialized", selectionReason: "execution_mode:desktop_input" };
  }
  if (request.permissionLevel === "confirmed_write" || request.permissionLevel === "dangerous") {
    return {
      backend: "unavailable",
      selectionReason: `agent_runtime_forbidden_for_permission:${request.permissionLevel}`,
    };
  }
  const primaryCapability = request.primaryCapability?.trim();
  if (!primaryCapability) {
    return { backend: "unavailable", selectionReason: "missing_primary_capability" };
  }
  if (!hasModelProfile(request)) {
    return { backend: "unavailable", selectionReason: "missing_model_profile" };
  }

  const target = OPENCODE_CAPABILITIES.has(primaryCapability)
    ? "opencode"
    : "langchain";
  if (availability[target]) {
    return {
      backend: target,
      selectionReason: `primary_capability:${primaryCapability}`,
    };
  }
  if (availability.legacyFallback) {
    return {
      backend: "legacy",
      selectionReason: `${target}_unavailable_before_start`,
      fallbackReason: "runtime_factory_unavailable",
    };
  }
  return {
    backend: "unavailable",
    selectionReason: `${target}_unavailable`,
    fallbackReason: "runtime_factory_unavailable",
  };
}

function hasModelProfile(request: AgentRouteRequest): boolean {
  return Boolean(request.provider?.trim() && request.model?.trim());
}
