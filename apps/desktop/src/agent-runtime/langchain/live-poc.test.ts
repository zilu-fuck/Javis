import { describe, expect, it } from "vitest";
import {
  createReadOnlyToolExecutionGateway,
  type AgentChatRequest,
  type AgentChatResponse,
  type AgentChatStreamEvent,
  type AgentEvent,
  type AgentMessage,
  type AgentModelGateway,
  type AgentToolCall,
} from "@javis/core";
import { initialToolDescriptors } from "@javis/tools";
import { createLangChainAgentRuntime } from "./runner";

const LIVE_ENABLED = readEnvironmentVariable("JAVIS_RUN_LANGCHAIN_LIVE") === "1";
const API_KEY = readEnvironmentVariable("DEEPSEEK_API_KEY")?.trim();
const MODEL = readEnvironmentVariable("JAVIS_LANGCHAIN_LIVE_MODEL")?.trim() || "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";

describe("DeepSeek live POC request serialization", () => {
  it("flattens text messages while retaining assistant tool calls and tool results", () => {
    expect(toOpenAiMessage({
      role: "system",
      content: [{ type: "text", text: "system text" }],
    })).toEqual({ role: "system", content: "system text" });
    expect(toOpenAiMessage({
      role: "assistant",
      content: [],
      toolCalls: [{ id: "call-1", name: "web__search", arguments: { query: "rust" } }],
    })).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "web__search", arguments: '{"query":"rust"}' },
      }],
    });
    expect(toOpenAiMessage({
      role: "tool",
      toolCallId: "call-1",
      name: "web__search",
      content: [{ type: "text", text: "tool result" }],
      status: "success",
    })).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      name: "web__search",
      content: "tool result",
    });
  });
});

describe.skipIf(!LIVE_ENABLED)("LangChain read-only live POC", () => {
  it("runs a real model -> Javis gateway -> model -> final loop", async () => {
    if (!API_KEY) throw new Error("DEEPSEEK_API_KEY is required for the live POC.");
    const descriptor = initialToolDescriptors.find((item) => item.name === "web.search");
    if (!descriptor) throw new Error("web.search descriptor is not registered.");
    const dispatches: Array<{ toolName: string; query: unknown }> = [];
    const gateway = createReadOnlyToolExecutionGateway({
      descriptors: [descriptor],
      getAllowedToolNames: (agentKind) => agentKind === "research" ? ["web.search"] : [],
      dispatch: async (request) => {
        dispatches.push({ toolName: request.toolName, query: request.input.query });
        return [{
          url: "https://www.rust-lang.org/",
          title: "Rust Programming Language",
          excerpt: "Rust empowers everyone to build reliable and efficient software.",
          fetchedAt: "2026-07-19T00:00:00.000Z",
          provider: "langchain-live-fixture",
        }];
      },
    });
    const runtime = createLangChainAgentRuntime({
      modelGateway: createDeepSeekLiveGateway(API_KEY),
      toolGateway: gateway,
      toolSpecs: [{
        canonicalName: "web.search",
        modelName: "web__search",
        description: descriptor.summary,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      }],
    });
    const handle = runtime.run({
      id: "research-live-poc",
      kind: "research",
      instructions: [
        "Call web__search exactly once with the requested query before answering.",
        "After the tool result, answer with one concise factual sentence and do not call another tool.",
      ].join(" "),
      allowedToolNames: ["web.search"],
      limits: {
        maxModelCalls: 3,
        maxToolCalls: 1,
        modelTimeoutMs: 60_000,
        toolTimeoutMs: 5_000,
      },
    }, {
      taskId: "langchain-live-poc",
      runId: `langchain-live-${Date.now()}`,
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Use web search to find one reliable fact about the Rust programming language.",
        }],
      }],
      context: {},
    });
    const eventsPromise = collectEvents(handle.events);
    const result = await handle.result;
    const events = await eventsPromise;

    expect(result.status).toBe("completed");
    expect(typeof result.output).toBe("string");
    expect((result.output as string).trim().length).toBeGreaterThan(0);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toEqual({
      toolName: "web.search",
      query: expect.any(String),
    });
    const requested = events.find((event) => event.type === "tool.requested");
    const started = events.find((event) => event.type === "tool.started");
    expect(requested).toMatchObject({
      type: "tool.requested",
      toolCallId: expect.any(String),
      toolName: "web.search",
    });
    expect(started).toMatchObject({
      type: "tool.started",
      toolCallId: requested?.type === "tool.requested" ? requested.toolCallId : undefined,
      toolName: "web.search",
    });
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(events.some((event) => event.type === "usage.updated")).toBe(true);
    expect(events[events.length - 1]?.type).toBe("run.completed");
    expect(result.metrics).toMatchObject({
      backend: "langchain",
      status: "completed",
      modelCalls: 2,
      toolCalls: 1,
      usage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      },
    });
    console.info("LANGCHAIN_LIVE_EVIDENCE=" + JSON.stringify({
      status: "pass",
      scenario: "langchain-phase2-readonly-poc",
      provider: "deepseek",
      model: MODEL,
      canonicalToolName: dispatches[0]?.toolName,
      modelToolName: "web__search",
      toolCallIdPresent: requested?.type === "tool.requested" && requested.toolCallId.length > 0,
      finalAnswerPresent: true,
      modelCalls: result.metrics?.modelCalls,
      toolCalls: result.metrics?.toolCalls,
      usage: result.metrics?.usage,
    }));
  }, 90_000);
});

function createDeepSeekLiveGateway(apiKey: string): AgentModelGateway {
  return {
    capabilities: () => ({
      nativeToolCalling: true,
      // Deliberately false: this live POC exercises the non-streaming path
      // only (stream() throws below). The production deepseek adapter
      // declares streamingToolCalls: true; streamed tool-call acceptance is
      // Phase 3 scope, not part of this read-only POC.
      streamingToolCalls: false,
      structuredOutput: true,
      parallelToolCalls: true,
    }),
    async complete(request): Promise<AgentChatResponse> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new DOMException("Live model request timed out.", "TimeoutError")),
        request.timeoutMs ?? 60_000,
      );
      const abort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: request.model || MODEL,
            messages: request.messages.map(toOpenAiMessage),
            tools: request.tools?.map((spec) => ({
              type: "function",
              function: {
                name: spec.modelName,
                description: spec.description,
                parameters: spec.inputSchema,
              },
            })),
            tool_choice: toOpenAiToolChoice(request.toolChoice),
            parallel_tool_calls: request.parallelToolCalls,
            temperature: request.temperature ?? 0,
            max_tokens: request.maxTokens,
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`DeepSeek live request failed with HTTP ${response.status}.`);
        }
        return parseOpenAiResponse(await response.json());
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
      }
    },
    async *stream(): AsyncIterable<AgentChatStreamEvent> {
      throw new Error("The Phase 2 live POC uses the non-streaming model gateway.");
    },
  };
}

function toOpenAiMessage(message: AgentMessage): Record<string, unknown> {
  const content = message.content.every((block) => block.type === "text")
    ? message.content.map((block) => block.type === "text" ? block.text : "").join("")
    : message.content.map((block) => block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image_url", image_url: { url: block.url } });
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content.map((block) => block.type === "text" ? block.text : "").join(""),
    };
  }
  return { role: message.role, content };
}

function toOpenAiToolChoice(choice: AgentChatRequest["toolChoice"]): unknown {
  if (!choice || typeof choice === "string") return choice ?? "auto";
  return { type: "function", function: { name: choice.name } };
}

function parseOpenAiResponse(value: unknown): AgentChatResponse {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    throw new Error("DeepSeek live response has no choices.");
  }
  const choice = value.choices[0];
  if (!isRecord(choice.message)) throw new Error("DeepSeek live response has no assistant message.");
  const message = choice.message;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(parseToolCall)
    : undefined;
  const content = typeof message.content === "string" && message.content.length > 0
    ? [{ type: "text" as const, text: message.content }]
    : [];
  const usage = isRecord(value.usage) &&
    typeof value.usage.prompt_tokens === "number" &&
    typeof value.usage.completion_tokens === "number"
    ? {
        inputTokens: value.usage.prompt_tokens,
        outputTokens: value.usage.completion_tokens,
        totalTokens: typeof value.usage.total_tokens === "number"
          ? value.usage.total_tokens
          : value.usage.prompt_tokens + value.usage.completion_tokens,
      }
    : undefined;
  return {
    message: { role: "assistant", content, toolCalls },
    finishReason: toolCalls?.length ? "tool_calls" : "stop",
    usage,
  };
}

function parseToolCall(value: unknown): AgentToolCall {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.function) ||
    typeof value.function.name !== "string" || typeof value.function.arguments !== "string") {
    throw new Error("DeepSeek returned an invalid tool call.");
  }
  const parsedArguments: unknown = JSON.parse(value.function.arguments);
  if (!isRecord(parsedArguments)) throw new Error("DeepSeek tool arguments must be an object.");
  return { id: value.id, name: value.function.name, arguments: parsedArguments };
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvironmentVariable(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
}
