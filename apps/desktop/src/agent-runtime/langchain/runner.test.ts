import { describe, expect, it, vi } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  AgentModelGateway,
  AgentToolSpec,
  ToolExecutionGateway,
} from "@javis/core";
import { createLangChainAgentRuntime } from "./runner";

const spec: AgentToolSpec = {
  canonicalName: "web.search",
  modelName: "web__search",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const definition: AgentDefinition = {
  id: "research-agent",
  kind: "research",
  liveAgentKinds: ["commander", "research", "explorer"],
  instructions: "Use the search tool, then answer.",
  allowedToolNames: ["web.search"],
  limits: {
    maxModelCalls: 3,
    maxToolCalls: 2,
    modelTimeoutMs: 5_000,
    toolTimeoutMs: 5_000,
  },
};

describe("LangChain Agent runtime", () => {
  it("completes a native model -> tool -> model loop without the JSON decider", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>(async (request) => {
      expect(request.parallelToolCalls).toBe(false);
      const hasToolResult = request.messages.some((message) => message.role === "tool");
      return hasToolResult
        ? {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Rust result" }],
            },
            finishReason: "stop",
            usage: { inputTokens: 8, outputTokens: 3 },
          }
        : {
            message: {
              role: "assistant",
              content: [],
              toolCalls: [{
                id: "call-1",
                name: "web__search",
                arguments: { query: "rust" },
              }],
            },
            finishReason: "tool_calls",
            usage: { inputTokens: 5, outputTokens: 2 },
          };
    });
    const modelGateway: AgentModelGateway = {
      capabilities: () => ({
        nativeToolCalling: true,
        streamingToolCalls: false,
        structuredOutput: false,
        parallelToolCalls: true,
      }),
      complete,
      stream: async function* () { return; },
    };
    const execute = vi.fn<ToolExecutionGateway["execute"]>(async () => ({
      status: "success",
      output: { results: ["Rust"] },
    }));
    const runtime = createLangChainAgentRuntime({
      modelGateway,
      toolGateway: { execute },
      toolSpecs: [spec],
    });
    const handle = runtime.run(definition, {
      taskId: "task-1",
      runId: "run-1",
      workflowRunId: "workflow-1",
      agentRunId: "agent-run-1",
      stepId: "search-rust",
      attempt: 2,
      messages: [{ role: "user", content: [{ type: "text", text: "Search Rust" }] }],
      context: {},
    });
    const eventsPromise = collectEvents(handle.events);

    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      termination: "returned",
      output: "Rust result",
      stepResult: {
        status: "completed",
        output: "Rust result",
        evidence: [{
          kind: "log",
          label: "LangChain final response",
          reference: "search-rust",
        }],
        assumptions: [],
        unresolvedQuestions: [],
      },
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
      metrics: {
        backend: "langchain",
        status: "completed",
        modelCalls: 2,
        toolCalls: 1,
        usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
      },
    });
    const events = await eventsPromise;
    expect(complete).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "web.search",
      input: { query: "rust" },
    }));
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "model.started",
      "tool.requested",
      "model.completed",
      "usage.updated",
      "tool.started",
      "tool.completed",
      "model.started",
      "model.completed",
      "usage.updated",
      "run.completed",
    ]);
    expect(events.find((event) => event.type === "tool.started")).toMatchObject({
      toolCallId: "call-1",
      toolName: "web.search",
      callId: "call-1",
      stepId: "search-rust",
      attempt: 2,
    });
    expect(events.find((event) => event.type === "model.started")).toMatchObject({
      callId: "search-rust:model:1",
      stepId: "search-rust",
      attempt: 2,
    });
    const completedEvent = events[events.length - 1];
    expect(completedEvent).toMatchObject({
      type: "run.completed",
      result: {
        status: "completed",
        metrics: {
          backend: "langchain",
          modelCalls: 2,
          toolCalls: 1,
        },
      },
    });
  });

  it("streams one ordered model/tool/model loop without duplicate deltas or tool events", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>();
    const stream = vi.fn<AgentModelGateway["stream"]>((request) => (async function* () {
      expect(request.parallelToolCalls).toBe(false);
      const hasToolResult = request.messages.some((message) => message.role === "tool");
      yield { type: "message_start" as const, messageId: hasToolResult ? "message-2" : "message-1" };
      if (hasToolResult) {
        yield { type: "text_delta" as const, delta: "Rust " };
        yield { type: "text_delta" as const, delta: "result" };
        yield {
          type: "usage" as const,
          usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
        };
        yield { type: "message_end" as const, finishReason: "stop" as const };
        return;
      }
      yield {
        type: "tool_call_start" as const,
        index: 0,
        id: "call-stream-1",
        name: "web__search",
      };
      yield {
        type: "tool_call_arguments_delta" as const,
        index: 0,
        delta: '{"query":"rust"}',
      };
      yield { type: "tool_call_end" as const, index: 0 };
      yield {
        type: "usage" as const,
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      };
      yield { type: "message_end" as const, finishReason: "tool_calls" as const };
    })());
    const execute = vi.fn<ToolExecutionGateway["execute"]>(async () => ({
      status: "success",
      output: { results: ["Rust"] },
    }));
    const runtime = createLangChainAgentRuntime({
      modelGateway: {
        capabilities: () => ({
          nativeToolCalling: true,
          streamingToolCalls: true,
          structuredOutput: false,
          parallelToolCalls: true,
        }),
        complete,
        stream,
      },
      toolGateway: { execute },
      toolSpecs: [spec],
    });
    const handle = runtime.run(definition, {
      taskId: "task-stream",
      runId: "run-stream",
      messages: [{ role: "user", content: [{ type: "text", text: "Search Rust" }] }],
      context: {},
    });
    const eventsPromise = collectEvents(handle.events);

    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      output: "Rust result",
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
      metrics: {
        backend: "langchain",
        modelCalls: 2,
        toolCalls: 1,
      },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "web.search",
      input: { query: "rust" },
    }));
    const events = await eventsPromise;
    expect(events).toEqual([
      { type: "run.started", runId: "run-stream" },
      { type: "model.started", callIndex: 1 },
      { type: "tool.requested", toolCallId: "call-stream-1", toolName: "web.search" },
      { type: "usage.updated", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: "model.completed", callIndex: 1, finishReason: "tool_calls" },
      { type: "tool.started", toolCallId: "call-stream-1", toolName: "web.search" },
      {
        type: "tool.completed",
        toolCallId: "call-stream-1",
        toolName: "web.search",
        output: { results: ["Rust"] },
      },
      { type: "model.started", callIndex: 2 },
      { type: "model.delta", delta: "Rust " },
      { type: "model.delta", delta: "result" },
      { type: "usage.updated", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
      { type: "model.completed", callIndex: 2, finishReason: "stop" },
      {
        type: "run.completed",
        result: expect.objectContaining({
          status: "completed",
          output: "Rust result",
          metrics: expect.objectContaining({ modelCalls: 2, toolCalls: 1 }),
        }),
      },
    ]);
  });

  it("maps the internal request-input control tool to AgentRunResult", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>(async () => ({
      message: {
        role: "assistant",
        content: [],
        toolCalls: [{
          id: "call-input",
          name: "javis__request_input",
          arguments: {
            contextKeys: ["repositorySummary"],
            requestedAgentKind: "explorer",
            reason: "Repository context is missing.",
          },
        }],
      },
      finishReason: "tool_calls",
    }));
    const execute = vi.fn<ToolExecutionGateway["execute"]>();
    const runtime = createLangChainAgentRuntime({
      modelGateway: gatewayWith(complete),
      toolGateway: { execute },
      toolSpecs: [spec],
    });
    const handle = runtime.run(definition, {
      taskId: "task-input",
      runId: "run-input",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      context: {},
    });
    const eventsPromise = collectEvents(handle.events);

    await expect(handle.result).resolves.toMatchObject({
      status: "request_input",
      reason: "Repository context is missing.",
      requestedContextKeys: ["repositorySummary"],
      requestedAgentKind: "explorer",
      stepResult: {
        status: "needs_clarification",
        requestedContextKeys: ["repositorySummary"],
        unresolvedQuestions: ["Repository context is missing."],
      },
      metrics: {
        backend: "langchain",
        status: "request_input",
        modelCalls: 1,
        toolCalls: 0,
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect((await eventsPromise).map((event) => event.type)).toEqual([
      "run.started",
      "model.started",
      "tool.requested",
      "model.completed",
      "context.requested",
      "run.completed",
    ]);
  });

  it.each([
    {
      label: "duplicate context keys",
      input: { contextKeys: ["repositorySummary", "repositorySummary"] },
      reason: "requestedContextKeys must not contain duplicates",
    },
    {
      label: "too many context keys",
      input: { contextKeys: Array.from({ length: 17 }, (_, index) => `context${index}`) },
      reason: "cannot contain more than 16 keys",
    },
    {
      label: "unregistered requested Agent",
      input: { contextKeys: ["repositorySummary"], requestedAgentKind: "not-registered" },
      reason: "must identify a live registered agent",
    },
  ])("fails the run for $label instead of weakening legacy request_input validation", async ({
    input,
    reason,
  }) => {
    const complete = vi.fn<AgentModelGateway["complete"]>(async () => ({
      message: {
        role: "assistant",
        content: [],
        toolCalls: [{
          id: "call-invalid-input",
          name: "javis__request_input",
          arguments: input,
        }],
      },
      finishReason: "tool_calls",
    }));
    const runtime = createLangChainAgentRuntime({
      modelGateway: gatewayWith(complete),
      toolGateway: { execute: vi.fn() },
      toolSpecs: [spec],
    });
    const handle = runtime.run(definition, {
      taskId: "task-invalid-input",
      runId: "run-invalid-input",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      context: {},
    });
    const eventsPromise = collectEvents(handle.events);

    await expect(handle.result).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining(reason),
    });
    expect((await eventsPromise).map((event) => event.type)).toEqual([
      "run.started",
      "model.started",
      "tool.requested",
      "model.completed",
      "run.failed",
    ]);
  });

  it("emits one ordered failure terminal when the model returns an unknown tool alias", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>(async () => ({
      message: {
        role: "assistant",
        content: [],
        toolCalls: [{
          id: "call-unknown",
          name: "write__file",
          arguments: {},
        }],
      },
      finishReason: "tool_calls",
    }));
    const runtime = createLangChainAgentRuntime({
      modelGateway: gatewayWith(complete),
      toolGateway: { execute: vi.fn() },
      toolSpecs: [spec],
    });
    const handle = runtime.run(definition, {
      taskId: "task-failed",
      runId: "run-failed",
      messages: [{ role: "user", content: [{ type: "text", text: "Fail safely" }] }],
      context: {},
    });
    const eventsPromise = collectEvents(handle.events);

    await expect(handle.result).resolves.toMatchObject({
      status: "failed",
      reason: "Model returned unknown tool alias: write__file.",
      stepResult: {
        status: "failed",
        error: "Model returned unknown tool alias: write__file.",
        errorDetail: {
          code: "langchain_runtime_failed",
          phase: "runtime",
          retryable: false,
        },
      },
      metrics: {
        backend: "langchain",
        status: "failed",
        modelCalls: 1,
        toolCalls: 0,
      },
    });
    expect((await eventsPromise).map((event) => event.type)).toEqual([
      "run.started",
      "model.started",
      "run.failed",
    ]);
  });

  it("cancels a hung model call through AgentRunHandle.cancel", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>((request) =>
      new Promise((_, reject) => {
        const abort = () => reject(
          request.signal?.reason ?? new DOMException("Cancelled", "AbortError"),
        );
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      })
    );
    const runtime = createLangChainAgentRuntime({
      modelGateway: gatewayWith(complete),
      toolGateway: { execute: vi.fn() },
      toolSpecs: [spec],
    });
    const handle = runtime.run(definition, {
      taskId: "task-cancel",
      runId: "run-cancel",
      messages: [{ role: "user", content: [{ type: "text", text: "Wait" }] }],
      context: {},
    });
    const eventsPromise = collectEvents(handle.events);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

    handle.cancel();

    await expect(handle.result).resolves.toMatchObject({
      status: "cancelled",
      metrics: {
        backend: "langchain",
        status: "cancelled",
        modelCalls: 1,
        toolCalls: 0,
      },
    });
    expect((await eventsPromise).map((event) => event.type)).toEqual([
      "run.started",
      "model.started",
      "run.failed",
    ]);
  });

  it("uses the LangChain tool strategy when outputSchema is configured", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>(async (request) => {
      const structuredTool = request.tools?.find((tool) =>
        tool.modelName === "javis__structured_output"
      );
      expect(structuredTool?.inputSchema).toMatchObject({
        required: ["answer"],
      });
      return {
        message: {
          role: "assistant",
          content: [],
          toolCalls: [{
            id: "call-result",
            name: "javis__structured_output",
            arguments: { answer: "Rust result" },
          }],
        },
        finishReason: "tool_calls",
      };
    });
    const runtime = createLangChainAgentRuntime({
      modelGateway: gatewayWith(complete),
      toolGateway: { execute: vi.fn() },
      toolSpecs: [spec],
    });
    const handle = runtime.run({
      ...definition,
      outputSchema: {
        title: "research_result",
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    }, {
      taskId: "task-output",
      runId: "run-output",
      messages: [{ role: "user", content: [{ type: "text", text: "Answer" }] }],
      context: {},
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      output: { answer: "Rust result" },
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("uses provider-native structured output when the gateway declares support", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>(async (request) => {
      expect(request.responseSchema).toMatchObject({
        title: "javis__structured_output",
        required: ["answer"],
      });
      return {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "{\"answer\":\"Native result\"}" }],
        },
        finishReason: "stop",
      };
    });
    const modelGateway = gatewayWith(complete);
    modelGateway.capabilities = () => ({
      nativeToolCalling: true,
      streamingToolCalls: false,
      structuredOutput: true,
      parallelToolCalls: true,
    });
    const runtime = createLangChainAgentRuntime({
      modelGateway,
      toolGateway: { execute: vi.fn() },
      toolSpecs: [spec],
    });
    const handle = runtime.run({
      ...definition,
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    }, {
      taskId: "task-native-output",
      runId: "run-native-output",
      messages: [{ role: "user", content: [{ type: "text", text: "Answer" }] }],
      context: {},
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      output: { answer: "Native result" },
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

function gatewayWith(
  complete: AgentModelGateway["complete"],
): AgentModelGateway {
  return {
    capabilities: () => ({
      nativeToolCalling: true,
      streamingToolCalls: false,
      structuredOutput: false,
      parallelToolCalls: true,
    }),
    complete,
    stream: async function* () { return; },
  };
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}
