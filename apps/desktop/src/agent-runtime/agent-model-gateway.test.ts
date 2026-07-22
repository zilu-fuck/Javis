import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleAdapter,
  registerAdapter,
  type AgentChatRequest,
} from "@javis/core";

const { invokeMock, listenMock, eventHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { createAgentModelGateway } from "./agent-model-gateway";

const request: AgentChatRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "Search" }] }],
  tools: [{
    canonicalName: "web.search",
    modelName: "web__search",
    description: "Search the web",
    inputSchema: { type: "object", properties: {} },
  }],
};

describe("createAgentModelGateway", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    eventHandlers.clear();
    listenMock.mockImplementation(async (name, handler) => {
      eventHandlers.set(name, handler);
      return vi.fn();
    });
  });

  it("calls the typed native chat command with provider-native tools", async () => {
    invokeMock.mockResolvedValue({
      message: {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call-1", name: "web__search", arguments: { query: "rust" } }],
      },
      finishReason: "tool_calls",
    });
    const gateway = createAgentModelGateway({
      provider: "openai",
      model: "gpt-test",
      apiKeyReference: "model.openai",
      baseUrl: "https://example.test/v1",
    });
    expect(gateway.capabilities().structuredOutput).toBe(true);

    await expect(gateway.complete({ ...request, timeoutMs: 1_234 })).resolves.toMatchObject({
      finishReason: "tool_calls",
    });
    expect(invokeMock).toHaveBeenCalledWith("complete_model_chat", {
      request: expect.objectContaining({
        messages: request.messages,
        tools: request.tools,
        protocol: "openai-compatible",
        parallelToolCalls: true,
        timeoutMs: 1_234,
      }),
    });
  });

  it.each([
    ["openai", "gpt-test", "openai-compatible"],
    ["deepseek", "deepseek-chat", "openai-compatible"],
    ["anthropic", "claude-test", "anthropic"],
  ] as const)(
    "exposes native Tool Call only through the typed %s provider protocol fixture",
    async (provider, model, protocol) => {
      invokeMock.mockResolvedValue({
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        finishReason: "stop",
      });
      const gateway = createAgentModelGateway({
        provider,
        model,
        apiKeyReference: `model.${provider}`,
        baseUrl: "https://example.test/v1",
      });

      expect(gateway.capabilities()).toMatchObject({
        nativeToolCalling: true,
        streamingToolCalls: true,
      });
      await gateway.complete(request);
      expect(invokeMock).toHaveBeenLastCalledWith("complete_model_chat", {
        request: expect.objectContaining({ protocol, tools: request.tools }),
      });
    },
  );

  it("enables native tool calling for compatible providers by default", async () => {
    invokeMock.mockResolvedValue({
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      finishReason: "stop",
    });
    const gateway = createAgentModelGateway({
      provider: "ollama",
      model: "local-model",
      apiKeyReference: "model.ollama",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(gateway.capabilities()).toMatchObject({
      nativeToolCalling: true,
      streamingToolCalls: true,
      structuredOutput: false,
      parallelToolCalls: false,
    });
    await expect(gateway.complete(request)).resolves.toMatchObject({ finishReason: "stop" });
    const nativeRequest = invokeMock.mock.calls[0]?.[1]?.request;
    expect(nativeRequest).not.toHaveProperty("parallelToolCalls");
  });

  it("honors provider and request-level Tool Call capability switches", async () => {
    invokeMock.mockResolvedValue({
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      finishReason: "stop",
    });
    const openai = createAgentModelGateway({
      provider: "openai",
      model: "gpt-test",
      apiKeyReference: "model.openai",
      baseUrl: "https://example.test/v1",
    });
    await openai.complete({ ...request, parallelToolCalls: false });
    expect(invokeMock).toHaveBeenLastCalledWith("complete_model_chat", {
      request: expect.objectContaining({ parallelToolCalls: false }),
    });

    registerAdapter(new OpenAICompatibleAdapter(
      "legacy-gateway-test",
      "https://example.test/v1",
      {
        vision: false,
        code: true,
        longContext: false,
        nativeToolCalling: false,
        streamingToolCalls: false,
      },
    ));
    const unsupported = createAgentModelGateway({
      provider: "legacy-gateway-test",
      model: "legacy-model",
      apiKeyReference: "model.legacy",
      baseUrl: "https://example.test/v1",
    });
    expect(unsupported.capabilities().nativeToolCalling).toBe(false);
    await expect(unsupported.complete(request)).rejects.toThrow(
      "explicitly disables native tool calling",
    );
  });

  it("honors an already-aborted request before exposing a result", async () => {
    invokeMock.mockResolvedValue({ message: { role: "assistant", content: [] }, finishReason: "stop" });
    const controller = new AbortController();
    controller.abort();
    const gateway = createAgentModelGateway({
      provider: "anthropic",
      model: "claude-test",
      apiKeyReference: "model.anthropic",
      baseUrl: "https://api.anthropic.com",
    });
    await expect(gateway.complete({ ...request, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("streams provider-neutral tool-call events from the native command", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command !== "stream_model_chat_start") return undefined;
      const streamId = args.streamId as string;
      const handler = eventHandlers.get("stream-model-chat-event");
      handler?.({
        payload: {
          streamId,
          event: { type: "tool_call_start", index: 0, id: "call-1", name: "web__search" },
        },
      });
      handler?.({
        payload: {
          streamId,
          event: { type: "tool_call_arguments_delta", index: 0, delta: "{}" },
        },
      });
      handler?.({
        payload: {
          streamId,
          event: { type: "tool_call_end", index: 0 },
        },
      });
      handler?.({
        payload: {
          streamId,
          event: { type: "message_end", finishReason: "tool_calls" },
        },
      });
      return streamId;
    });
    const gateway = createAgentModelGateway({
      provider: "openai",
      model: "gpt-test",
      apiKeyReference: "model.openai",
      baseUrl: "https://example.test/v1",
    });
    const events = [];
    for await (const event of gateway.stream(request)) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "tool_call_start",
      "tool_call_arguments_delta",
      "tool_call_end",
      "message_end",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("stream_model_chat_start", {
      request: expect.any(Object),
      streamId: expect.stringMatching(/^chat-stream-/),
    });
  });

  it("does not start a native stream for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const gateway = createAgentModelGateway({
      provider: "openai",
      model: "gpt-test",
      apiKeyReference: "model.openai",
      baseUrl: "https://example.test/v1",
    });
    const iterator = gateway.stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "stream_model_chat_start",
      expect.anything(),
    );
  });

  it("cancels an in-flight native stream when the request is aborted", async () => {
    invokeMock.mockImplementation(async (command, args) =>
      command === "stream_model_chat_start" ? args.streamId : undefined
    );
    const controller = new AbortController();
    const gateway = createAgentModelGateway({
      provider: "openai",
      model: "gpt-test",
      apiKeyReference: "model.openai",
      baseUrl: "https://example.test/v1",
    });
    const iterator = gateway.stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("stream_model_chat_start", expect.anything());
    });
    const streamId = invokeMock.mock.calls.find(([command]) =>
      command === "stream_model_chat_start"
    )?.[1]?.streamId;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).toHaveBeenCalledWith("stream_model_chat_cancel", { streamId });
  });
});
