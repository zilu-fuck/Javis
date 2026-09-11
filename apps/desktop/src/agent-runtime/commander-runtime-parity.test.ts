import { describe, expect, it, vi } from "vitest";
import {
  createInitialTaskSnapshot,
  runCommanderDagTask,
  type AgentModelGateway,
  type AgentRuntimeFactory,
  type RuntimeEventEnvelope,
  type TaskSnapshot,
  type WorkflowCheckpoint,
} from "@javis/core";
import {
  initialToolDescriptors,
  type CommanderTool,
} from "@javis/tools";
import { createLangChainAgentRuntime } from "./langchain/runner";

describe("Commander AgentRuntime backend parity", () => {
  it("matches durable events and result artifacts for the LangChain backend", async () => {
    const outcomes = ["completed", "failed", "request_input", "invalid_request_input"] as const;
    for (const outcome of outcomes) {
      const langchain = await runCase("langchain", outcome);
      expect(langchain.status).toBe(outcome === "completed" ? "completed" : "failed");
      expect(langchain.eventKinds[langchain.eventKinds.length - 1]).toBe(
        outcome === "completed" ? "task.completed" : "task.failed",
      );
      expect(langchain.hasOutputArtifact).toBe(outcome === "completed");
      expect(langchain.requestedInput).toBe(outcome === "request_input");
      if (outcome === "completed") {
        expect(langchain.outputPayload).toBe("Final Rust answer.");
      } else {
        expect(langchain.outputPayload).toBeUndefined();
      }
    }
  });

  it("resumes a completed LangChain step without replaying its tool call", async () => {
    const taskId = "desktop-langchain-resume";
    const plan = vi.fn(async () => ({
      title: "LangChain resume",
      reasoning: "Persist and resume one completed read step.",
      steps: [{
        id: "research-step",
        title: "Search Rust",
        assignedAgentKind: "research",
        toolName: "web.search",
        toolInput: { query: "rust" },
        executionMode: "react" as const,
        dependsOn: [],
        outputContextKey: "researchEvidence",
        successCriteria: "Return source-backed evidence.",
      }],
    }));
    const commanderTool: CommanderTool = {
      plan,
    };
    const toolOutput = [{
      url: "https://example.test/rust",
      title: "Rust",
      excerpt: "Rust source evidence is long enough for the workflow validator.",
      fetchedAt: "2026-07-19T00:00:00.000Z",
      provider: "fixture",
    }];
    const searchWeb = vi.fn(async () => toolOutput);
    const createAgentRuntime = vi.fn<AgentRuntimeFactory>(({ toolGateway, toolSpecs }) =>
      createLangChainAgentRuntime({
        modelGateway: createFixtureGateway("completed"),
        toolGateway,
        toolSpecs,
      })
    );
    const runtimeEvents: RuntimeEventEnvelope[] = [];
    const checkpoints: WorkflowCheckpoint[] = [];
    const first = createController();

    await runCommanderDagTask({
      controller: first.controller,
      commanderTool,
      webTool: {
        searchWeb,
        fetchWebSource: vi.fn(async ({ url }) => ({ ...toolOutput[0], url })),
      },
      getAgentRuntimeBackend: () => "langchain",
      createAgentRuntime,
      runtimeEventSink: {
        append: async (event) => {
          runtimeEvents.push(event);
        },
      },
      checkpointSink: {
        save: async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      },
      taskId,
      userGoal: "research rust",
      availableToolDescriptors: initialToolDescriptors,
    });

    const checkpoint = [...checkpoints].reverse().find((candidate) =>
      candidate.completedStepIds.includes("research-step") &&
      candidate.agentRuntimeMetrics?.some((metrics) => metrics.backend === "langchain")
    );
    expect(checkpoint).toBeDefined();
    if (!checkpoint) throw new Error("Expected a completed LangChain checkpoint.");
    const runtimeCreations = createAgentRuntime.mock.calls.length;
    const toolCalls = searchWeb.mock.calls.length;
    const planCalls = plan.mock.calls.length;
    const resumed = createController();
    const checkpointWithoutRoutingMetrics: WorkflowCheckpoint = {
      ...checkpoint,
      agentRuntimeRoutingMetrics: undefined,
    };

    await runCommanderDagTask({
      controller: resumed.controller,
      commanderTool,
      webTool: {
        searchWeb,
        fetchWebSource: vi.fn(async ({ url }) => ({ ...toolOutput[0], url })),
      },
      getAgentRuntimeBackend: () => "langchain",
      createAgentRuntime,
      taskId,
      userGoal: "research rust",
      availableToolDescriptors: initialToolDescriptors,
      resumeFromCheckpoint: {
        checkpoint: checkpointWithoutRoutingMetrics,
        events: runtimeEvents.filter((event) => event.sequence <= checkpoint.eventSequence),
      },
    });

    expect(plan).toHaveBeenCalledTimes(planCalls);
    expect(createAgentRuntime).toHaveBeenCalledTimes(runtimeCreations);
    expect(searchWeb).toHaveBeenCalledTimes(toolCalls);
    const finalSnapshot = resumed.emitted[resumed.emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.agentRuntimeMetrics).toEqual(checkpoint.agentRuntimeMetrics);
    expect(finalSnapshot?.agentRuntimeRoutingMetrics).toEqual(
      checkpoint.agentRuntimeRoutingMetrics,
    );
    expect(runtimeEvents.filter((event) =>
      (event.payload as { kind?: string }).kind === "agent.runtime_routed"
    )).toHaveLength(1);
    expect(finalSnapshot?.tokenUsage).toEqual(checkpoint.tokenUsage);
    expect(finalSnapshot?.durableResume?.completedStepIds).toContain("research-step");

    const routeEvent = runtimeEvents.find((event) =>
      (event.payload as { kind?: string }).kind === "agent.runtime_routed"
    );
    expect(routeEvent).toBeDefined();
    if (!routeEvent) throw new Error("Expected a durable routing observation.");
    const incompleteCheckpoint: WorkflowCheckpoint = {
      ...checkpointWithoutRoutingMetrics,
      completedStepIds: [],
      pendingStepIds: ["research-step"],
      runningStepIds: [],
      contextSnapshot: {},
      eventSequence: routeEvent.sequence,
    };
    const incompleteResume = createController();

    await runCommanderDagTask({
      controller: incompleteResume.controller,
      commanderTool,
      webTool: {
        searchWeb,
        fetchWebSource: vi.fn(async ({ url }) => ({ ...toolOutput[0], url })),
      },
      getAgentRuntimeBackend: () => "langchain",
      createAgentRuntime,
      taskId,
      userGoal: "research rust",
      availableToolDescriptors: initialToolDescriptors,
      resumeFromCheckpoint: {
        checkpoint: incompleteCheckpoint,
        events: runtimeEvents.filter((event) => event.sequence <= routeEvent.sequence),
      },
    });

    const incompleteFinal = incompleteResume.emitted[incompleteResume.emitted.length - 1];
    expect(incompleteFinal?.status).toBe("completed");
    expect(incompleteFinal?.agentRuntimeRoutingMetrics).toEqual([
      expect.objectContaining({
        routeCount: 2,
        rolloutTargetCount: 2,
        langchainRouteCount: 2,
        fallbackCount: 0,
        observationIds: [
          expect.stringMatching(/:research-step:attempt-1$/u),
          expect.stringMatching(/:research-step:attempt-2$/u),
        ],
      }),
    ]);
  });
});

async function runCase(
  backend: "langchain",
  outcome: "completed" | "failed" | "request_input" | "invalid_request_input",
) {
  const taskId = `desktop-parity-${backend}-${outcome}`;
  const commanderTool: CommanderTool = {
    plan: vi.fn(async () => ({
      title: "Desktop backend parity",
      reasoning: "Use the same read-only research step.",
      steps: [{
        id: "research-step",
        title: "Search Rust",
        assignedAgentKind: "research",
        toolName: "web.search",
        toolInput: { query: "rust" },
        executionMode: "react" as const,
        dependsOn: [],
        outputContextKey: "researchEvidence",
        successCriteria: "Return source-backed evidence.",
      }],
    })),
  };
  const toolOutput = [{
    url: "https://example.test/rust",
    title: "Rust",
    excerpt: "Rust source evidence is long enough for the workflow validator.",
    fetchedAt: "2026-07-19T00:00:00.000Z",
    provider: "fixture",
  }];
  const searchWeb = vi.fn(async () => toolOutput);
  const createAgentRuntime: AgentRuntimeFactory = ({ toolGateway, toolSpecs }) =>
    createLangChainAgentRuntime({
      modelGateway: createFixtureGateway(outcome),
      toolGateway,
      toolSpecs,
    });
  const runtimeEvents: RuntimeEventEnvelope[] = [];
  let checkpoint: WorkflowCheckpoint | undefined;
  const { controller, emitted } = createController();

  await runCommanderDagTask({
    controller,
    commanderTool,
    webTool: {
      searchWeb,
      fetchWebSource: vi.fn(async ({ url }) => ({ ...toolOutput[0], url })),
    },
    getAgentRuntimeBackend: () => backend,
    createAgentRuntime,
    runtimeConfig: {
      maxStepRetries: 0,
      maxReplans: 0,
      failureRecoveryEnabled: false,
    },
    runtimeEventSink: {
      append: async (envelope) => {
        runtimeEvents.push(envelope);
      },
    },
    checkpointSink: {
      save: async (value) => {
        checkpoint = value;
      },
    },
    taskId,
    userGoal: "research rust",
    availableToolDescriptors: initialToolDescriptors,
  });

  const finalSnapshot = emitted[emitted.length - 1];
  const outputArtifact = checkpoint?.contextSnapshot.researchEvidence;
  return {
    status: finalSnapshot?.status,
    eventKinds: runtimeEvents.map((event) =>
      (event.payload as { kind?: string }).kind ?? "unknown"
    ),
    searchCalls: searchWeb.mock.calls.length,
    hasOutputArtifact: outputArtifact !== undefined,
    outputPayload: outputArtifact?.payload,
    handoffStatus: finalSnapshot?.handoffReport?.handoffs.find((handoff) =>
      handoff.contextKey === "researchEvidence"
    )?.status,
    requestedInput: finalSnapshot?.logs.some((log) =>
      log.detail.includes("request_input") && log.detail.includes("researchQuery")
    ) ?? false,
  };
}

function createFixtureGateway(
  outcome: "completed" | "failed" | "request_input" | "invalid_request_input",
): AgentModelGateway {
  return {
    capabilities: () => ({
      nativeToolCalling: true,
      streamingToolCalls: false,
      structuredOutput: false,
      parallelToolCalls: true,
    }),
    async complete(request) {
      if (outcome === "failed") throw new Error("Parity failure.");
      if (outcome === "request_input" || outcome === "invalid_request_input") {
        return {
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{
              id: "call-input",
              name: "javis__request_input",
              arguments: {
                contextKeys: outcome === "invalid_request_input"
                  ? ["researchQuery", "researchQuery"]
                  : ["researchQuery"],
                requestedAgentKind: "commander",
                reason: "Need upstream query context.",
              },
            }],
          },
          finishReason: "tool_calls",
        };
      }
      const hasToolResult = request.messages.some((message) => message.role === "tool");
      return hasToolResult
        ? {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Final Rust answer." }],
            },
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
          }
        : {
            message: {
              role: "assistant",
              content: [],
              toolCalls: [{
                id: "call-search",
                name: "web__search",
                arguments: { query: "rust" },
              }],
            },
            finishReason: "tool_calls",
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          };
    },
    async *stream() {
      throw new Error("The Phase 3 parity fixture uses non-streaming model calls.");
    },
  };
}

function createController() {
  let snapshot = createInitialTaskSnapshot();
  const emitted: TaskSnapshot[] = [];
  return {
    emitted,
    controller: {
      emit(nextSnapshot: TaskSnapshot) {
        snapshot = nextSnapshot;
        emitted.push(nextSnapshot);
      },
      getSnapshot() {
        return snapshot;
      },
      async wait() {},
    },
  };
}
