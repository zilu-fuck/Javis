import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolSpec } from "@javis/core";
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "langchain/browser";

const { invokeMock, listenMock, eventHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { createAgentModelGateway } from "../agent-model-gateway";
import { JavisChatModel } from "./javis-chat-model";

const toolSpec: AgentToolSpec = {
  canonicalName: "web.search",
  modelName: "web__search",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const providers = [
  {
    provider: "openai",
    protocol: "openai-compatible" as const,
    baseUrl: "https://api.openai.test/v1",
  },
  {
    provider: "anthropic",
    protocol: "anthropic" as const,
    baseUrl: "https://api.anthropic.test/v1",
  },
];

describe("typed native model chat integration", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    eventHandlers.clear();
    listenMock.mockImplementation(async (name, handler) => {
      eventHandlers.set(name, handler);
      return vi.fn();
    });
  });

  for (const fixture of providers) {
    it(`completes a ${fixture.provider} native non-stream tool loop`, async () => {
      invokeMock.mockImplementation(async (command, args) => {
        expect(command).toBe("complete_model_chat");
        const messages = args.request.messages as Array<{ role: string }>;
        return messages.some((message) => message.role === "tool")
          ? {
              message: {
                role: "assistant",
                content: [{ type: "text", text: `${fixture.provider} final` }],
              },
              finishReason: "stop",
              usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
            }
          : {
              message: {
                role: "assistant",
                content: [],
                toolCalls: [{
                  id: `${fixture.provider}-call-1`,
                  name: "web__search",
                  arguments: { query: "rust" },
                }],
              },
              finishReason: "tool_calls",
              usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            };
      });
      const model = createModel(fixture);
      const user = new HumanMessage("Search Rust");
      const first = await model._generate([user], {});
      const assistant = first.generations[0]!.message as AIMessage;
      expect(assistant.tool_calls).toEqual([expect.objectContaining({
        id: `${fixture.provider}-call-1`,
        name: "web__search",
        args: { query: "rust" },
      })]);
      expect(first.llmOutput).toEqual({
        tokenUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      });

      const result = new ToolMessage({
        content: "Rust evidence",
        tool_call_id: `${fixture.provider}-call-1`,
        name: "web__search",
        status: "success",
      });
      const final = await model._generate([user, assistant, result], {});
      expect(final.generations[0]?.text).toBe(`${fixture.provider} final`);
      expect(invokeMock).toHaveBeenCalledTimes(2);
      for (const call of invokeMock.mock.calls) {
        expect(call[1].request.protocol).toBe(fixture.protocol);
      }
    });

    it(`completes a ${fixture.provider} native streamed tool loop`, async () => {
      invokeMock.mockImplementation(async (command, args) => {
        if (command !== "stream_model_chat_start") return undefined;
        const streamId = args.streamId as string;
        const messages = args.request.messages as Array<{ role: string }>;
        const emit = (event: Record<string, unknown>) => {
          eventHandlers.get("stream-model-chat-event")?.({
            payload: { streamId, event },
          });
        };
        emit({ type: "message_start", messageId: streamId });
        if (messages.some((message) => message.role === "tool")) {
          emit({ type: "text_delta", delta: `${fixture.provider} streamed final` });
          emit({
            type: "usage",
            usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
          });
          emit({ type: "message_end", finishReason: "stop" });
        } else {
          emit({
            type: "tool_call_start",
            index: 0,
            id: `${fixture.provider}-stream-call`,
            name: "web__search",
          });
          emit({ type: "tool_call_arguments_delta", index: 0, delta: "{\"query\":" });
          emit({ type: "tool_call_arguments_delta", index: 0, delta: "\"rust\"}" });
          emit({ type: "tool_call_end", index: 0 });
          emit({
            type: "usage",
            usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
          });
          emit({ type: "message_end", finishReason: "tool_calls" });
        }
        return streamId;
      });

      const model = createModel(fixture);
      const user = new HumanMessage("Search Rust");
      const firstChunks = [];
      for await (const chunk of model._streamResponseChunks([user], {})) {
        firstChunks.push(chunk);
      }
      const toolChunks = firstChunks.flatMap((chunk) =>
        chunk.message instanceof AIMessageChunk
          ? chunk.message.tool_call_chunks ?? []
          : []
      );
      const argumentsText = toolChunks.map((chunk) => chunk.args ?? "").join("");
      const assistant = new AIMessage({
        content: "",
        tool_calls: [{
          id: `${fixture.provider}-stream-call`,
          name: "web__search",
          args: JSON.parse(argumentsText) as Record<string, unknown>,
        }],
      });
      const result = new ToolMessage({
        content: "Rust evidence",
        tool_call_id: `${fixture.provider}-stream-call`,
        name: "web__search",
        status: "success",
      });
      const finalChunks = [];
      for await (const chunk of model._streamResponseChunks([user, assistant, result], {})) {
        finalChunks.push(chunk);
      }

      expect(argumentsText).toBe("{\"query\":\"rust\"}");
      expect(firstChunks.some((chunk) =>
        chunk.message instanceof AIMessageChunk &&
        chunk.message.usage_metadata?.total_tokens === 8
      )).toBe(true);
      expect(finalChunks.map((chunk) => chunk.text).join(""))
        .toBe(`${fixture.provider} streamed final`);
      expect(invokeMock).toHaveBeenCalledTimes(2);
      for (const call of invokeMock.mock.calls) {
        expect(call[1].request.protocol).toBe(fixture.protocol);
      }
    });
  }
});

function createModel(fixture: (typeof providers)[number]): JavisChatModel {
  return new JavisChatModel({
    gateway: createAgentModelGateway({
      provider: fixture.provider,
      model: `${fixture.provider}-test-model`,
      apiKeyReference: `model.${fixture.provider}`,
      baseUrl: fixture.baseUrl,
    }),
    tools: [toolSpec],
  });
}
