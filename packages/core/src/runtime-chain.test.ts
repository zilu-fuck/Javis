import { describe, expect, it } from "vitest";
import { decideRuntimeChain } from "./runtime-chain";
import type { RouteDecision } from "./local-router";

function makeInput(overrides: Partial<Parameters<typeof decideRuntimeChain>[0]> = {}) {
  const routeDecision: RouteDecision = overrides.routeDecision ?? {
    level: "L1",
    mode: "direct_chat",
    score: 1,
    reasons: ["simple"],
  };

  return {
    userGoal: "hello",
    startMode: "auto" as const,
    routeDecision,
    recommendedWorkflowIds: [],
    hasChatTool: true,
    hasCommanderTool: true,
    hasKnownRouteIntent: false,
    hasVisionTask: false,
    hasUrl: false,
    isTextWriteGoal: false,
    isReadCurrentProjectGoal: false,
    isResearchGoal: false,
    isProjectInspectionGoal: false,
    isCodeReviewGoal: false,
    isPdfOrganizationGoal: false,
    ...overrides,
  };
}

describe("decideRuntimeChain", () => {
  it("keeps simple auto chat on the public direct-chat path", () => {
    const decision = decideRuntimeChain(makeInput());

    expect(decision.architecture).toBe("hub_router_eventbus_dispatch");
    expect(decision.dispatch.kind).toBe("direct_chat");
    expect(decision.surfaces.user).toBe("natural_response");
  });

  it("lets project-mode greetings use direct response without opening a clarification card", () => {
    const decision = decideRuntimeChain(makeInput({
      startMode: "project",
      routeDecision: {
        level: "L1",
        mode: "direct_chat",
        score: 0,
        reasons: ["casual_greeting", "simple"],
      },
    }));

    expect(decision.dispatch).toEqual({
      kind: "direct_chat",
      reason: "simple_chat_without_known_agent_intent",
    });
  });

  it("keeps other simple project-mode requests on Commander", () => {
    const decision = decideRuntimeChain(makeInput({ startMode: "project" }));

    expect(decision.dispatch.kind).toBe("commander_task");
  });

  it("does not let explicit chat mode bypass a confident workspace route", () => {
    const decision = decideRuntimeChain(makeInput({
      startMode: "chat",
      routeDecision: {
        level: "L2",
        mode: "single_agent_task",
        score: 0,
        reasons: ["custom_route"],
        customRoute: {
          route: "workspace.demo.triage",
          workflowId: "workspace.demo.triage-flow",
          score: 5,
          threshold: 4,
          signals: ["incident-triage"],
        },
      },
      recommendedWorkflowIds: ["workspace.demo.triage-flow"],
      hasKnownRouteIntent: true,
    }));

    expect(decision.dispatch).toEqual({
      kind: "single_agent_task",
      reason: "custom_route_workflow",
    });
  });

  it("routes project mode through Commander like the demo hub", () => {
    const decision = decideRuntimeChain(makeInput({
      startMode: "project",
      hasKnownRouteIntent: true,
    }));

    expect(decision.dispatch.kind).toBe("commander_task");
    expect(decision.selectedCapabilities).toContain("commander.dispatch");
  });

  it("routes project-mode text file writes through the approval write flow", () => {
    const decision = decideRuntimeChain(makeInput({
      userGoal: "\u5199\u4e00\u7bc7\u77ed\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6",
      startMode: "project",
      hasKnownRouteIntent: true,
      isTextWriteGoal: true,
    }));

    expect(decision.dispatch).toEqual({
      kind: "single_agent_task",
      reason: "text_write_requires_approval_flow",
    });
    expect(decision.selectedCapabilities).toContain("file.planWriteText");
    expect(decision.selectedCapabilities).toContain("file.writeText");
  });

  it("does not treat L3 alone as evidence that a creative text write needs Commander", () => {
    const decision = decideRuntimeChain(makeInput({
      userGoal: "\u5199\u4e00\u7bc7\u4e00\u4e07\u5b57\u7684\u6210\u957f\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6",
      startMode: "project",
      routeDecision: {
        level: "L3",
        mode: "commander_dag",
        score: 5,
        reasons: ["complex_generation"],
      },
      hasKnownRouteIntent: true,
      isTextWriteGoal: true,
    }));

    expect(decision.dispatch).toEqual({
      kind: "single_agent_task",
      reason: "text_write_requires_approval_flow",
    });
    expect(decision.preferredAgentKinds).not.toContain("commander");
    expect(decision.preferredAgentKinds).toContain("file");
  });

  it("routes evidence-backed file writes to Commander planning", () => {
    const decision = decideRuntimeChain(makeInput({
      userGoal: "\u5e2e\u6211\u62c9\u53d6\u5fae\u535a\u70ed\u641c\u524d20\u7684\u6570\u636e\uff0c\u4fdd\u5b58\u4e3amd\u6587\u4ef6",
      startMode: "project",
      routeDecision: {
        level: "L3",
        mode: "commander_dag",
        score: 5,
        reasons: ["research_intent"],
      },
      hasKnownRouteIntent: true,
      isTextWriteGoal: true,
      isResearchGoal: true,
      recommendedWorkflowIds: ["research-trending-topics"],
    }));

    expect(decision.dispatch).toEqual({
      kind: "commander_task",
      reason: "commander_handles_evidence_backed_write",
    });
    expect(decision.preferredAgentKinds).toContain("commander");
    expect(decision.preferredAgentKinds).toContain("research");
    expect(decision.preferredAgentKinds).toContain("file");
    expect(decision.selectedCapabilities).toContain("trend.fetchHotList");
    expect(decision.selectedCapabilities).toContain("file.writeText");
  });

  it("keeps explicit L2 tool work on the single-agent path", () => {
    const decision = decideRuntimeChain(makeInput({
      routeDecision: {
        level: "L2",
        mode: "single_agent_task",
        score: 3,
        reasons: ["tool_intent"],
      },
      hasKnownRouteIntent: true,
      isTextWriteGoal: true,
    }));

    expect(decision.dispatch.kind).toBe("single_agent_task");
    expect(decision.selectedCapabilities).toContain("file.writeText");
  });

  it("connects codebase understanding to Commander and Code Agent evidence", () => {
    const decision = decideRuntimeChain(makeInput({
      userGoal: "\u544a\u8bc9\u6211\u8fd9\u4e2a\u9879\u76ee\u662f\u5e72\u561b\u7684, \u4e0d\u8981\u5149\u770breadme, \u8981\u7ed3\u5408\u5b9e\u9645\u4ee3\u7801\u60c5\u51b5",
      routeDecision: {
        level: "L3",
        mode: "commander_dag",
        score: 4,
        reasons: ["codebase_understanding_intent"],
      },
      hasKnownRouteIntent: true,
      isReadCurrentProjectGoal: true,
      recommendedWorkflowIds: ["read-current-project"],
    }));

    expect(decision.dispatch.kind).toBe("commander_task");
    expect(decision.preferredAgentKinds).toContain("code");
    expect(decision.selectedCapabilities).toContain("code.searchRepository");
  });

  it("selects Javis specialist agents before Commander planning", () => {
    const decision = decideRuntimeChain(makeInput({
      userGoal: "\u8bf7\u5b89\u5168\u5ba1\u67e5\u8fd9\u4e2a TypeScript \u9879\u76ee",
      routeDecision: {
        level: "L3",
        mode: "commander_dag",
        score: 5,
        reasons: ["specialist_agent_intent"],
      },
      hasKnownRouteIntent: true,
    }));

    expect(decision.dispatch.kind).toBe("commander_task");
    expect(decision.preferredAgentKinds).toContain("security-reviewer");
    expect(decision.preferredAgentKinds).toContain("language-reviewer");
    expect(decision.selectedCapabilities).toContain("security_review");
    expect(decision.selectedCapabilities).toContain("language_review");
  });

  it("promotes L2 specialist intent to Commander when Commander is available", () => {
    const decision = decideRuntimeChain(makeInput({
      userGoal: "\u8bf7\u91cd\u6784\u8fd9\u6bb5 TypeScript \u4ee3\u7801\u5e76\u8ba9 reviewer \u68c0\u67e5",
      routeDecision: {
        level: "L2",
        mode: "single_agent_task",
        score: 3,
        reasons: ["specialist_agent_intent"],
      },
      hasKnownRouteIntent: true,
    }));

    expect(decision.dispatch).toEqual({
      kind: "commander_task",
      reason: "commander_specialist_or_source_evidence_chain",
    });
    expect(decision.preferredAgentKinds).toContain("refactor");
    expect(decision.preferredAgentKinds).toContain("language-reviewer");
  });
});
