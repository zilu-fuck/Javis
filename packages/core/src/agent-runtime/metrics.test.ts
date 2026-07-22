import { describe, expect, it } from "vitest";
import {
  addAgentTokenUsage,
  createAgentRuntimeMetricsCollector,
  createAgentRuntimeRoutingMetricsCollector,
} from "./metrics";

describe("Agent runtime metrics", () => {
  it("aggregates success, latency, calls, and token usage without backend mixing", () => {
    const collector = createAgentRuntimeMetricsCollector("legacy");
    collector.record({
      backend: "legacy",
      status: "completed",
      durationMs: 30,
      modelCalls: 2,
      toolCalls: 1,
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    collector.record({
      backend: "legacy",
      status: "failed",
      durationMs: 10,
      modelCalls: 1,
      toolCalls: 0,
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    });

    expect(collector.snapshot()).toEqual({
      backend: "legacy",
      runCount: 2,
      completedRunCount: 1,
      successRate: 0.5,
      totalDurationMs: 40,
      averageDurationMs: 20,
      modelCalls: 3,
      toolCalls: 1,
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
    });
    expect(() => collector.record({
      backend: "langchain",
      status: "completed",
      durationMs: 0,
      modelCalls: 0,
      toolCalls: 0,
    })).toThrow("Cannot record langchain metrics in legacy collector");
  });

  it("adds reported totals without losing providers that omit totalTokens", () => {
    expect(addAgentTokenUsage(
      { inputTokens: 2, outputTokens: 3 },
      { inputTokens: 5, outputTokens: 7, totalTokens: 20 },
    )).toEqual({ inputTokens: 7, outputTokens: 10, totalTokens: 25 });
  });

  it("keeps the actual model profile dimensions while accumulating usage", () => {
    expect(addAgentTokenUsage(
      {
        inputTokens: 2,
        outputTokens: 1,
        provider: "openai",
        model: "model-a",
        contextWindowTokens: 8_192,
      },
      { inputTokens: 3, outputTokens: 2 },
    )).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
      provider: "openai",
      model: "model-a",
      contextWindowTokens: 8_192,
    });
  });

  it("keeps entirely missing provider usage unknown", () => {
    expect(addAgentTokenUsage(undefined, undefined)).toBeUndefined();

    const collector = createAgentRuntimeMetricsCollector("legacy");
    collector.record({
      backend: "legacy",
      status: "completed",
      durationMs: 1,
      modelCalls: 1,
      toolCalls: 0,
    });
    expect(collector.snapshot()).not.toHaveProperty("usage");
  });

  it("continues a durable aggregate without resetting pre-restart metrics", () => {
    const collector = createAgentRuntimeMetricsCollector("langchain", {
      backend: "langchain",
      runCount: 2,
      completedRunCount: 1,
      successRate: 0.5,
      totalDurationMs: 40,
      averageDurationMs: 20,
      modelCalls: 3,
      toolCalls: 1,
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
    });
    collector.record({
      backend: "langchain",
      status: "completed",
      durationMs: 20,
      modelCalls: 2,
      toolCalls: 1,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });

    expect(collector.snapshot()).toEqual({
      backend: "langchain",
      runCount: 3,
      completedRunCount: 2,
      successRate: 2 / 3,
      totalDurationMs: 60,
      averageDurationMs: 20,
      modelCalls: 5,
      toolCalls: 2,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    });
  });

  it("tracks fallback rate by provider, Agent kind, and task type across restart", () => {
    const collector = createAgentRuntimeRoutingMetricsCollector([{
      providerId: "openai",
      agentKind: "research",
      taskType: "read",
      routeCount: 2,
      rolloutTargetCount: 1,
      langchainRouteCount: 1,
      legacyRouteCount: 1,
      unavailableRouteCount: 0,
      fallbackCount: 0,
      fallbackRate: 0,
      fallbackReasons: [],
      observationIds: ["run-1:step-1", "run-1:step-2"],
    }]);
    collector.record({
      observationId: "run-2:step-1",
      providerId: "openai",
      agentKind: "research",
      taskType: "read",
      backend: "langchain",
      rolloutTargeted: true,
    });
    collector.record({
      observationId: "run-2:step-2",
      providerId: "anthropic",
      agentKind: "code",
      taskType: "preview",
      backend: "legacy",
      rolloutTargeted: true,
      fallbackReason: "native_tool_call_unavailable",
    });

    expect(collector.snapshot()).toEqual([{
      providerId: "anthropic",
      agentKind: "code",
      taskType: "preview",
      routeCount: 1,
      rolloutTargetCount: 1,
      langchainRouteCount: 0,
      legacyRouteCount: 1,
      unavailableRouteCount: 0,
      fallbackCount: 1,
      fallbackRate: 1,
      fallbackReasons: [{ reason: "native_tool_call_unavailable", count: 1 }],
      observationIds: ["run-2:step-2"],
    }, {
      providerId: "openai",
      agentKind: "research",
      taskType: "read",
      routeCount: 3,
      rolloutTargetCount: 2,
      langchainRouteCount: 2,
      legacyRouteCount: 1,
      unavailableRouteCount: 0,
      fallbackCount: 0,
      fallbackRate: 0,
      fallbackReasons: [],
      observationIds: ["run-1:step-1", "run-1:step-2", "run-2:step-1"],
    }]);
  });

  it("does not recount the same run and step after checkpoint resume", () => {
    const collector = createAgentRuntimeRoutingMetricsCollector();
    const observation = {
      observationId: "run-resume:step-1",
      providerId: "openai",
      agentKind: "research" as const,
      taskType: "read",
      backend: "langchain" as const,
      rolloutTargeted: true,
    };
    collector.record(observation);
    collector.record(observation);

    expect(collector.snapshot()[0]).toMatchObject({
      routeCount: 1,
      rolloutTargetCount: 1,
      langchainRouteCount: 1,
      observationIds: ["run-resume:step-1"],
    });
  });

  it("tracks OpenCode routes without breaking legacy snapshots", () => {
    const collector = createAgentRuntimeRoutingMetricsCollector();
    collector.record({
      observationId: "workflow-1:code-search:1",
      providerId: "openai",
      agentKind: "code",
      taskType: "read",
      backend: "opencode",
      rolloutTargeted: true,
    });

    expect(collector.snapshot()[0]).toMatchObject({
      routeCount: 1,
      opencodeRouteCount: 1,
      fallbackCount: 0,
    });
  });

  it("keeps direct and specialized routes distinct from unavailable routes", () => {
    const collector = createAgentRuntimeRoutingMetricsCollector();
    collector.record({
      observationId: "workflow-1:direct:1",
      providerId: "openai",
      agentKind: "commander",
      taskType: "direct",
      backend: "direct",
      rolloutTargeted: true,
    });
    collector.record({
      observationId: "workflow-1:computer:1",
      providerId: "openai",
      agentKind: "computer",
      taskType: "desktop",
      backend: "javis_specialized",
      rolloutTargeted: false,
    });

    expect(collector.snapshot()).toEqual([
      expect.objectContaining({
        agentKind: "commander",
        directRouteCount: 1,
        unavailableRouteCount: 0,
        rolloutTargetCount: 0,
        fallbackCount: 0,
      }),
      expect.objectContaining({
        agentKind: "computer",
        javisSpecializedRouteCount: 1,
        unavailableRouteCount: 0,
      }),
    ]);
  });

  it("accepts legacy observations without the dual-kernel identity fields", () => {
    const collector = createAgentRuntimeRoutingMetricsCollector();
    expect(collector.record({
      observationId: "legacy-observation-1",
      providerId: "openai",
      agentKind: "research",
      taskType: "read",
      backend: "langchain",
      rolloutTargeted: true,
    })).toBe(true);
    expect(collector.snapshot()[0]).toMatchObject({
      routeCount: 1,
      observationIds: ["legacy-observation-1"],
    });
  });

  it("keeps distinct observation IDs that share the first 160 characters", () => {
    const collector = createAgentRuntimeRoutingMetricsCollector();
    const prefix = "x".repeat(160);
    for (const suffix of [":attempt-1", ":attempt-2"]) {
      collector.record({
        observationId: `${prefix}${suffix}`,
        providerId: "openai",
        agentKind: "research",
        taskType: "read",
        backend: "langchain",
        rolloutTargeted: true,
      });
    }

    expect(collector.snapshot()[0]).toMatchObject({
      routeCount: 2,
      langchainRouteCount: 2,
      observationIds: [`${prefix}:attempt-1`, `${prefix}:attempt-2`],
    });
  });
});
