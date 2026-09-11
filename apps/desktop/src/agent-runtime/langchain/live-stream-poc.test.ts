import { describe, expect, it } from "vitest";
import type {
  AgentChatStreamEvent,
  AgentEvent,
  AgentModelGateway,
} from "@javis/core";
import { HumanMessage } from "langchain/browser";
import { JavisChatModel } from "./javis-chat-model";

const LIVE_ENABLED = readEnvironmentVariable("JAVIS_RUN_LANGCHAIN_LIVE") === "1";
const API_KEY = readEnvironmentVariable("DEEPSEEK_API_KEY")?.trim();
const MODEL = readEnvironmentVariable("JAVIS_LANGCHAIN_LIVE_MODEL")?.trim() || "deepseek-reasoner";
const ENDPOINT = readEnvironmentVariable("JAVIS_LANGCHAIN_LIVE_ENDPOINT")?.trim()
  || "https://api.deepseek.com/chat/completions";

function readEnvironmentVariable(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
}

/**
 * Streaming live POC (Phase 3 acceptance aid). Unlike live-poc.test.ts this
 * exercises the SSE streaming path of the chat model against a real
 * OpenAI-compatible endpoint, including reasoning_content deltas emitted by
 * reasoning-capable models (DeepSeek R-series, GLM, Qwen).
 */
function createOpenAiCompatibleStreamGateway(apiKey: string): AgentModelGateway {
  return {
    capabilities: () => ({
      nativeToolCalling: true,
      streamingToolCalls: true,
      structuredOutput: false,
      parallelToolCalls: false,
    }),
    async complete() {
      throw new Error("The streaming live POC uses stream() only.");
    },
    async *stream(): AsyncIterable<AgentChatStreamEvent> {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "What is 17 * 23? Answer with just the number." }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Live stream request failed with HTTP ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newlineIndex = buffered.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffered.slice(0, newlineIndex).trim();
          buffered = buffered.slice(newlineIndex + 1);
          newlineIndex = buffered.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const data = line.slice("data:".length).trim();
          if (data === "[DONE]") return;
          let parsed: {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
          if (reasoning) yield { type: "reasoning_delta", delta: reasoning };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield { type: "text_delta", delta: content };
          const usage = parsed.usage;
          if (usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined) {
            yield {
              type: "usage",
              usage: {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                totalTokens: usage.prompt_tokens + usage.completion_tokens,
              },
            };
          }
        }
      }
      yield { type: "message_end", finishReason: "stop" };
    },
  };
}

describe.skipIf(!LIVE_ENABLED)("LangChain streaming live POC", () => {
  it("streams a real answer with usage and forwards reasoning deltas without leaking them", { timeout: 120_000 }, async () => {
    if (!API_KEY) throw new Error("DEEPSEEK_API_KEY is required for the live streaming POC.");
    const events: AgentEvent[] = [];
    const model = new JavisChatModel({
      gateway: createOpenAiCompatibleStreamGateway(API_KEY),
      onEvent: (event) => events.push(event),
    });
    let text = "";
    for await (const chunk of model._streamResponseChunks(
      [new HumanMessage("What is 17 * 23? Answer with just the number.")],
      {},
    )) {
      text += chunk.text;
    }

    expect(text.trim().replace(/[^0-9]/gu, "")).toContain("391");
    expect(events.some((event) => event.type === "usage.updated")).toBe(true);
    const reasoningDeltas = events.filter((event) => event.type === "model.reasoning_delta");
    if (reasoningDeltas.length > 0) {
      // The reasoning model produced thinking — it must stay out of the answer.
      const reasoningText = reasoningDeltas
        .map((event) => (event.type === "model.reasoning_delta" ? event.delta : ""))
        .join("");
      expect(text).not.toContain(reasoningText);
    }
  });
});
