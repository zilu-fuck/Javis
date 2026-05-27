import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfiguredModelProvider, ModelProviderError } from "./model-provider";
import type { ModelSettings } from "./model-settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

describe("model provider", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("keeps complete compatible with the configured completion command", async () => {
    invokeMock.mockResolvedValueOnce({
      text: "done",
      model: "gpt-test",
      provider: "openai",
      tokenUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
    const provider = createConfiguredModelProvider(createSettings());

    await expect(provider.complete("Plan it", { maxTokens: 100, temperature: 0 })).resolves.toEqual({
      text: "done",
      model: "gpt-test",
      provider: "openai",
      tokenUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
    expect(invokeMock).toHaveBeenCalledWith("complete_model_prompt", {
      request: {
        prompt: "Plan it",
        providerId: "openai",
        model: "openai/gpt-test",
        apiKeyReference: "default",
        baseUrl: "https://api.example.test/v1",
        maxTokens: 100,
        temperature: 0,
        stopSequences: undefined,
        locale: undefined,
      },
    });
  });

  it("adapts stream chunks to an AsyncIterable and optional callback", async () => {
    const NOW = 1000;
    const RAND = 0.123;
    const PREDICTABLE_ID = `stream-${NOW}-${RAND.toString(36).slice(2)}`;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(Math, "random").mockReturnValue(RAND);

    invokeMock.mockResolvedValueOnce(undefined);
    listenMock.mockImplementation(async (eventName, handler) => {
      if (eventName === "stream-model-chunk") {
        handler({ payload: { streamId: PREDICTABLE_ID, text: "Hel", model: "gpt-test", provider: "openai", index: 0 } } as never);
        handler({ payload: { streamId: "other", text: "skip", index: 0 } } as never);
        handler({ payload: { streamId: PREDICTABLE_ID, text: "lo", model: "gpt-test", provider: "openai", index: 1 } } as never);
      }
      if (eventName === "stream-model-done") {
        handler({
          payload: {
            streamId: PREDICTABLE_ID,
            totalChunks: 2,
            tokenUsage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
          },
        } as never);
      }
      return (() => {}) as () => void;
    });
    const provider = createConfiguredModelProvider(createSettings());
    const seen: string[] = [];
    const usages: Array<{ inputTokens: number; outputTokens: number; totalTokens?: number }> = [];

    const chunks = [];
    for await (const chunk of provider.stream("Say hello", {
      stopSequences: ["\n\n"],
      onChunk: (chunk) => seen.push(chunk.text),
      onUsage: (usage) => usages.push(usage),
    })) {
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(seen).toEqual(["Hel", "lo"]);
    expect(usages).toEqual([{ inputTokens: 8, outputTokens: 2, totalTokens: 10 }]);
    expect(invokeMock).toHaveBeenCalledWith("stream_model_prompt_start", {
      request: expect.objectContaining({
        prompt: "Say hello",
        providerId: "openai",
        stopSequences: ["\n\n"],
      }),
      streamId: PREDICTABLE_ID,
    });
  });

  it("injects terminology rules for Chinese model calls", async () => {
    invokeMock.mockResolvedValueOnce({
      text: "done",
      model: "deepseek-chat",
      provider: "deepseek",
    });
    const provider = createConfiguredModelProvider(createSettings());

    await provider.complete("Return JSON only.", { locale: "zh-CN" });

    expect(invokeMock).toHaveBeenCalledWith("complete_model_prompt", {
      request: expect.objectContaining({
        prompt: expect.stringContaining("Javis terminology rules for Chinese output"),
        providerId: "openai",
        locale: "zh-CN",
      }),
    });
  });

  it("normalizes provider errors for complete and stream", async () => {
    // listen is called before invoke now, so provide a no-op unlisten
    listenMock.mockResolvedValue((() => {}) as () => void);
    invokeMock.mockRejectedValueOnce("missing key").mockRejectedValueOnce(new Error("offline"));
    const provider = createConfiguredModelProvider(createSettings());

    await expect(provider.complete("Plan it")).rejects.toMatchObject({
      name: "ModelProviderError",
      provider: "openai",
      message: "missing key",
    });
    await expect(provider.stream("Plan it")[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      ModelProviderError,
    );
  });
});

function createSettings(): ModelSettings {
  return {
    provider: "openai",
    model: "openai/gpt-test",
    apiKey: "",
    apiKeyReference: "default",
    baseUrl: "https://api.example.test/v1",
  };
}
