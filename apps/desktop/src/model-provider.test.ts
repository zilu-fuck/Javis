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
    });
    const provider = createConfiguredModelProvider(createSettings());

    await expect(provider.complete("Plan it", { maxTokens: 100, temperature: 0 })).resolves.toEqual({
      text: "done",
      model: "gpt-test",
      provider: "openai",
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
    invokeMock.mockResolvedValueOnce("stream-1");
    listenMock.mockImplementation(async (eventName, handler) => {
      if (eventName === "stream-model-chunk") {
        handler({ payload: { stream_id: "stream-1", text: "Hel", model: "gpt-test", provider: "openai", index: 0 } } as never);
        handler({ payload: { stream_id: "other", text: "skip", index: 0 } } as never);
        handler({ payload: { stream_id: "stream-1", text: "lo", model: "gpt-test", provider: "openai", index: 1 } } as never);
      }
      if (eventName === "stream-model-done") {
        handler({ payload: { stream_id: "stream-1", total_chunks: 2 } } as never);
      }
      return (() => {}) as () => void;
    });
    const provider = createConfiguredModelProvider(createSettings());
    const seen: string[] = [];

    const chunks = [];
    for await (const chunk of provider.stream("Say hello", {
      stopSequences: ["\n\n"],
      onChunk: (chunk) => seen.push(chunk.text),
    })) {
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(seen).toEqual(["Hel", "lo"]);
    expect(invokeMock).toHaveBeenCalledWith("stream_model_prompt_start", {
      request: expect.objectContaining({
        prompt: "Say hello",
        providerId: "openai",
        stopSequences: ["\n\n"],
      }),
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
        locale: "zh-CN",
      }),
    });
  });

  it("normalizes provider errors for complete and stream", async () => {
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
