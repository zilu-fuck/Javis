import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredModelProvider,
  createModelProviderFromProfile,
  ModelProviderError,
} from "./model-provider";
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
        imageDataUrl: undefined,
        images: undefined,
        providerId: "openai",
        model: "openai/gpt-test",
        apiKeyReference: "default",
        baseUrl: "https://api.example.test/v1",
        maxTokens: 100,
        temperature: 0,
        stopSequences: undefined,
        locale: undefined,
        protocol: "openai-compatible",
      },
    });
  });

  it("passes multi-image inputs to the native completion request", async () => {
    invokeMock.mockResolvedValueOnce({
      text: "done",
      model: "gpt-test",
      provider: "openai",
    });
    const provider = createConfiguredModelProvider(createSettings());

    await provider.complete("Describe these", {
      imageDataUrl: "data:image/png;base64,one",
      images: ["data:image/png;base64,one", "data:image/png;base64,two"],
    });

    expect(invokeMock).toHaveBeenCalledWith("complete_model_prompt", {
      request: expect.objectContaining({
        prompt: "Describe these",
        imageDataUrl: "data:image/png;base64,one",
        images: ["data:image/png;base64,one", "data:image/png;base64,two"],
      }),
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

  it("uses the async L1 stream command when requested", async () => {
    const NOW = 2000;
    const RAND = 0.456;
    const predictableId = `stream-${NOW}-${RAND.toString(36).slice(2)}`;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(Math, "random").mockReturnValue(RAND);

    invokeMock.mockResolvedValueOnce(undefined);
    listenMock.mockImplementation(async (event, callback) => {
      if (event === "stream-model-done") {
        setTimeout(() => callback({
          payload: {
            streamId: predictableId,
            totalChunks: 0,
          },
        } as never), 0);
      }
      return (() => {}) as () => void;
    });
    const provider = createConfiguredModelProvider(createSettings());

    for await (const _chunk of provider.stream("hello", { streamMode: "l1" })) {
      // no chunks in this fixture
    }

    expect(invokeMock).toHaveBeenCalledWith("stream_model_prompt_l1_start", {
      request: expect.objectContaining({
        prompt: "hello",
        providerId: "openai",
      }),
      streamId: predictableId,
    });
  });

  it("injects terminology rules for Chinese user-facing text calls", async () => {
    invokeMock.mockResolvedValueOnce({
      text: "done",
      model: "deepseek-chat",
      provider: "deepseek",
    });
    const provider = createConfiguredModelProvider(createSettings());

    await provider.complete("请用中文总结这次任务。", { locale: "zh-CN" });

    expect(invokeMock).toHaveBeenCalledWith("complete_model_prompt", {
      request: expect.objectContaining({
        prompt: expect.stringContaining("Javis terminology rules for Chinese output"),
        providerId: "openai",
        locale: "zh-CN",
      }),
    });
  });

  it("does not inject terminology rules into structured JSON requests", async () => {
    invokeMock.mockResolvedValueOnce({
      text: "{}",
      model: "deepseek-chat",
      provider: "deepseek",
    });
    const provider = createConfiguredModelProvider(createSettings());

    await provider.complete("Return JSON only.", { locale: "zh-CN" });

    expect(invokeMock).toHaveBeenCalledWith("complete_model_prompt", {
      request: expect.objectContaining({
        prompt: "Return JSON only.",
        providerId: "openai",
        locale: "zh-CN",
      }),
    });
  });

  it("awaits profile model request assembly before invoking completion", async () => {
    invokeMock.mockResolvedValueOnce({
      text: "done",
      model: "gpt-test",
      provider: "openai",
    });
    const provider = createModelProviderFromProfile({
      id: "profile-1",
      provider: "openai",
      model: "openai/gpt-test",
      apiKeyReference: "default",
      baseUrl: "https://api.example.test/v1",
    });

    await expect(provider.complete("Plan it", { agentKind: "commander" })).resolves.toEqual({
      text: "done",
      model: "gpt-test",
      provider: "openai",
    });

    expect(invokeMock).toHaveBeenCalledWith("complete_model_prompt", {
      request: expect.objectContaining({
        prompt: expect.stringContaining("Plan it"),
        providerId: "openai",
        model: "openai/gpt-test",
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
