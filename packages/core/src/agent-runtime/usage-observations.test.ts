import { describe, expect, it } from "vitest";
import type { AgentTokenUsage } from "./contracts";
import {
  summarizeUsageObservations,
  upsertUsageObservation,
  usageObservationFromEvent,
  type UsageObservation,
} from "./usage-observations";

function observation(overrides: Partial<UsageObservation>): UsageObservation {
  return {
    callId: "call-1",
    revision: 1,
    final: false,
    taskId: "task-1",
    agentKind: "research",
    backend: "langchain",
    availability: "reported",
    semantics: "cumulative_for_call",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    ...overrides,
  };
}

describe("usageObservationFromEvent", () => {
  it("maps a reported usage event to an observation", () => {
    expect(usageObservationFromEvent({
      callId: "step-1:model:1",
      taskId: "task-1",
      stepId: "step-1",
      attempt: 2,
      agentKind: "research",
      backend: "langchain",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: "deepseek", model: "deepseek-chat" },
      revision: 3,
      final: true,
    })).toEqual({
      callId: "step-1:model:1",
      revision: 3,
      final: true,
      taskId: "task-1",
      stepId: "step-1",
      attempt: 2,
      agentKind: "research",
      backend: "langchain",
      provider: "deepseek",
      model: "deepseek-chat",
      availability: "reported",
      semantics: "cumulative_for_call",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("marks an empty usage event as unavailable without inventing zeros", () => {
    const result = usageObservationFromEvent({
      callId: "call-x",
      taskId: "task-1",
      agentKind: "research",
      backend: "opencode",
      usage: {} as AgentTokenUsage,
    });
    expect(result).toMatchObject({
      availability: "unavailable",
    });
    expect(result).not.toHaveProperty("inputTokens");
    expect(result).not.toHaveProperty("outputTokens");
    expect(result).not.toHaveProperty("totalTokens");
  });
});

describe("upsertUsageObservation", () => {
  it("upserts the same callId by monotonically increasing revision", () => {
    let collection = upsertUsageObservation(new Map(), observation({ revision: 1, inputTokens: 10 }));
    collection = upsertUsageObservation(collection, observation({ revision: 2, inputTokens: 20 }));
    collection = upsertUsageObservation(collection, observation({ revision: 3, final: true, inputTokens: 30 }));
    expect([...collection.values()]).toEqual([expect.objectContaining({ revision: 3, final: true, inputTokens: 30 })]);
  });

  it("ignores stale events with a lower revision", () => {
    let collection = upsertUsageObservation(new Map(), observation({ revision: 2 }));
    collection = upsertUsageObservation(collection, observation({ revision: 1 }));
    expect([...collection.values()]).toEqual([expect.objectContaining({ revision: 2 })]);
  });

  it("seals a callId once a final observation lands", () => {
    let collection = upsertUsageObservation(new Map(), observation({ revision: 2, final: true }));
    collection = upsertUsageObservation(collection, observation({ revision: 2, final: false }));
    collection = upsertUsageObservation(collection, observation({ revision: 1 }));
    expect([...collection.values()]).toEqual([expect.objectContaining({ revision: 2, final: true })]);
  });

  it("keeps distinct callIds separate", () => {
    let collection = upsertUsageObservation(new Map(), observation({ callId: "call-a" }));
    collection = upsertUsageObservation(collection, observation({ callId: "call-b" }));
    expect([...collection.values()].map((item) => item.callId)).toEqual(["call-a", "call-b"]);
  });
});

describe("summarizeUsageObservations", () => {
  it("sums the latest revision of each call exactly once (stream + final dedupe)", () => {
    const collection = new Map<string, UsageObservation>();
    // One model call: stream deltas revision 1-2, final revision 3.
    let next = upsertUsageObservation(collection, observation({
      callId: "call-a",
      revision: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }));
    next = upsertUsageObservation(next, observation({
      callId: "call-a",
      revision: 2,
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    }));
    next = upsertUsageObservation(next, observation({
      callId: "call-a",
      revision: 3,
      final: true,
      inputTokens: 12,
      outputTokens: 9,
      totalTokens: 21,
    }));
    // Second call: single final record.
    next = upsertUsageObservation(next, observation({
      callId: "call-b",
      revision: 1,
      final: true,
      inputTokens: 3,
      outputTokens: 1,
      totalTokens: 4,
    }));
    const summary = summarizeUsageObservations(next);
    expect(summary).toMatchObject({
      inputTokens: 15,
      outputTokens: 10,
      totalTokens: 25,
      modelCalls: 2,
    });
  });

  it("buckets per agent kind", () => {
    let collection = upsertUsageObservation(new Map(), observation({ callId: "a", agentKind: "research", inputTokens: 10 }));
    collection = upsertUsageObservation(collection, observation({ callId: "b", agentKind: "file", inputTokens: 5 }));
    collection = upsertUsageObservation(collection, observation({ callId: "c", agentKind: "research", inputTokens: 2 }));
    const summary = summarizeUsageObservations(collection);
    // The fixture default output/total (5/15) applies per call.
    expect(summary.byAgentKind).toEqual([
      { agentKind: "research", inputTokens: 12, outputTokens: 10, totalTokens: 30, modelCalls: 2 },
      { agentKind: "file", inputTokens: 5, outputTokens: 5, totalTokens: 15, modelCalls: 1 },
    ]);
  });

  it("keeps unavailable observations out of token totals", () => {
    const collection = new Map<string, UsageObservation>();
    let next = upsertUsageObservation(collection, observation({
      callId: "ok",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }));
    next = upsertUsageObservation(next, observation({
      callId: "unknown",
      availability: "unavailable",
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    }));
    const summary = summarizeUsageObservations(next);
    expect(summary).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelCalls: 1,
    });
    // The unavailable record itself is preserved for audit.
    expect([...next.values()].map((item) => item.callId)).toEqual(["ok", "unknown"]);
  });

  it("tracks the most utilized context-window pair", () => {
    let collection = upsertUsageObservation(new Map(), observation({
      callId: "a",
      totalTokens: 10,
      contextWindowTokens: 100,
    }));
    collection = upsertUsageObservation(collection, observation({
      callId: "b",
      totalTokens: 80,
      contextWindowTokens: 200,
    }));
    const summary = summarizeUsageObservations(collection);
    expect(summary).toMatchObject({
      contextUsedTokens: 80,
      contextWindowTokens: 200,
    });
  });
});
