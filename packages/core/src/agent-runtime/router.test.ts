import { describe, expect, it } from "vitest";
import type { AgentRouteRequest } from "./contracts";
import { routeAgentRuntime } from "./router";

const BASE_REQUEST: AgentRouteRequest = {
  taskId: "task-1",
  workflowRunId: "workflow-1",
  stepId: "inspect",
  attempt: 1,
  executionMode: "react",
  primaryCapability: "file_scan",
  agentKind: "file",
  permissionLevel: "read",
  provider: "openai",
  model: "gpt-test",
};

describe("routeAgentRuntime", () => {
  it("keeps deterministic steps and desktop input in Javis-owned backends", () => {
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, executionMode: "direct_tool_call", permissionLevel: "confirmed_write" },
      { langchain: true, opencode: true },
    ).backend).toBe("direct");
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, executionMode: "desktop_input", agentKind: "computer" },
      { langchain: true, opencode: true },
    ).backend).toBe("javis_specialized");
  });

  it("routes code capabilities to OpenCode and general capabilities to LangChain", () => {
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, primaryCapability: "code_search", agentKind: "code" },
      { langchain: true, opencode: true },
    ).backend).toBe("opencode");
    expect(routeAgentRuntime(BASE_REQUEST, { langchain: true, opencode: true }).backend)
      .toBe("langchain");
  });

  it("routes code proposals to OpenCode as a code-only capability", () => {
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, primaryCapability: "code_propose", agentKind: "code" },
      { langchain: true, opencode: true },
    )).toMatchObject({
      backend: "opencode",
      selectionReason: "primary_capability:code_propose",
    });
  });

  it("never sends confirmed-write or dangerous work into an Agent loop", () => {
    for (const permissionLevel of ["confirmed_write", "dangerous"] as const) {
      expect(routeAgentRuntime(
        { ...BASE_REQUEST, permissionLevel },
        { langchain: true, opencode: true },
      )).toMatchObject({
        backend: "unavailable",
        selectionReason: `agent_runtime_forbidden_for_permission:${permissionLevel}`,
      });
    }
  });

  it("fails closed when route identity or the selected backend is unavailable", () => {
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, primaryCapability: undefined },
      { langchain: true, opencode: true },
    ).selectionReason).toBe("missing_primary_capability");
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, primaryCapability: "code_search", agentKind: "code" },
      { langchain: true, opencode: false },
    )).toMatchObject({
      backend: "unavailable",
      selectionReason: "opencode_unavailable",
    });
  });

  it("requires a model profile only for direct responses and runtime steps", () => {
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, executionMode: "direct_tool_call", provider: undefined, model: undefined },
      { langchain: true, opencode: true },
    ).backend).toBe("direct");
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, executionMode: "direct_response", provider: undefined, model: undefined },
      { langchain: true, opencode: true },
    )).toMatchObject({ backend: "unavailable", selectionReason: "missing_model_profile" });
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, provider: undefined, model: undefined },
      { langchain: true, opencode: true },
    )).toMatchObject({ backend: "unavailable", selectionReason: "missing_model_profile" });
  });

  it("allows legacy fallback only when explicitly enabled before execution", () => {
    expect(routeAgentRuntime(
      { ...BASE_REQUEST, primaryCapability: "code_search", agentKind: "code" },
      { langchain: true, opencode: false, legacyFallback: true },
    )).toMatchObject({
      backend: "legacy",
      fallbackReason: "runtime_factory_unavailable",
    });
  });
});
