import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfiguredModelProvider, ModelProviderError } from "./model-provider";
import type { ModelSettings } from "./model-settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("model provider", () => {
  beforeEach(() => {
    invokeMock.mockReset();
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
    invokeMock.mockResolvedValueOnce([
      { text: "Hel", model: "gpt-test", provider: "openai" },
      { text: "" },
      { text: "lo", model: "gpt-test", provider: "openai" },
    ]);
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
    expect(invokeMock).toHaveBeenCalledWith("stream_model_prompt", {
      request: expect.objectContaining({
        prompt: "Say hello",
        providerId: "openai",
        stopSequences: ["\n\n"],
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
