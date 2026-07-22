import { describe, expect, it, vi } from "vitest";
import type { AgentModelGateway, AgentToolSpec } from "@javis/core";
import { AIMessage, HumanMessage, ToolMessage } from "langchain/browser";
import { JavisChatModel, toAgentMessages } from "./javis-chat-model";

const toolSpec: AgentToolSpec = {
  canonicalName: "web.search",
  modelName: "web__search",
  description: "Search the web",
  inputSchema: { type: "object", properties: {} },
};

function gateway(): AgentModelGateway {
  return {
    capabilities: () => ({
      nativeToolCalling: true,
      streamingToolCalls: false,
      structuredOutput: false,
      parallelToolCalls: true,
    }),
    complete: vi.fn(async () => ({
      message: {
        role: "assistant" as const,
        content: [],
        toolCalls: [{ id: "call-1", name: "web__search", arguments: { query: "rust" } }],
      },
      finishReason: "tool_calls" as const,
      usage: { inputTokens: 4, outputTokens: 2 },
    })),
    stream: async function* () {
      yield { type: "tool_call_start" as const, index: 0, id: "call-1", name: "web__search" };
      yield { type: "tool_call_arguments_delta" as const, index: 0, delta: "{\"query\":\"rust\"}" };
      yield { type: "tool_call_end" as const, index: 0 };
      yield { type: "message_end" as const, finishReason: "tool_calls" as const };
    },
  };
}

describe("JavisChatModel", () => {
  it("binds tools without mutating the shared model", () => {
    const model = new JavisChatModel({ gateway: gateway(), tools: [toolSpec] });
    const bound = model.bindTools([{ name: "web__search" }]);
    expect(bound).not.toBe(model);
    expect(bound.toolSpecs).toEqual([toolSpec]);
    expect(model.toolSpecs).toEqual([toolSpec]);
  });

  it("maps native tool calls to AIMessage.tool_calls", async () => {
    const model = new JavisChatModel({ gateway: gateway(), tools: [toolSpec] });
    const result = await model._generate([new HumanMessage("Search")], {});
    expect(result.generations[0]?.message).toBeInstanceOf(AIMessage);
    expect((result.generations[0]?.message as AIMessage).tool_calls).toEqual([{
      id: "call-1",
      name: "web__search",
      args: { query: "rust" },
      type: "tool_call",
    }]);
  });

  it("preserves tool_call_id, name, and status on the next model turn", () => {
    const messages = toAgentMessages([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: "web__search", args: { query: "rust" } }],
      }),
      new ToolMessage({
        content: "result",
        tool_call_id: "call-1",
        name: "web__search",
        status: "success",
      }),
    ]);
    expect(messages[1]).toEqual({
      role: "tool",
      toolCallId: "call-1",
      name: "web__search",
      content: [{ type: "text", text: "result" }],
      status: "success",
    });
  });

  it("maps streaming arguments to AIMessageChunk.tool_call_chunks", async () => {
    const model = new JavisChatModel({ gateway: gateway(), tools: [toolSpec] });
    const chunks = [];
    for await (const chunk of model._streamResponseChunks([new HumanMessage("Search")], {})) {
      chunks.push(chunk);
    }
    expect(chunks[0]?.message).toMatchObject({
      tool_call_chunks: [{ index: 0, id: "call-1", name: "web__search", args: "" }],
    });
    expect(chunks[1]?.message).toMatchObject({
      tool_call_chunks: [{ index: 0, args: "{\"query\":\"rust\"}" }],
    });
    expect(chunks[chunks.length - 1]?.generationInfo).toEqual({ finishReason: "tool_calls" });
  });

  it("forwards LangChain provider strategy schema to the model gateway", async () => {
    const complete = vi.fn<AgentModelGateway["complete"]>(async () => ({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "{\"answer\":\"ok\"}" }],
      },
      finishReason: "stop",
    }));
    const model = new JavisChatModel({
      gateway: { ...gateway(), complete },
      tools: [toolSpec],
    });
    const bound = model.bindTools([{ name: "web__search" }], {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "result",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
      },
    } as Parameters<JavisChatModel["bindTools"]>[1]);

    await bound._generate([new HumanMessage("Answer")], {});
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      responseSchema: expect.objectContaining({ required: ["answer"] }),
    }));
  });

  it("fails before dispatching a model call beyond the configured limit", async () => {
    const modelGateway = gateway();
    const model = new JavisChatModel({
      gateway: modelGateway,
      tools: [toolSpec],
      maxModelCalls: 1,
    });

    await model._generate([new HumanMessage("First")], {});
    await expect(model._generate([new HumanMessage("Second")], {}))
      .rejects.toThrow("model call limit (1)");
    expect(modelGateway.complete).toHaveBeenCalledTimes(1);
  });
});
