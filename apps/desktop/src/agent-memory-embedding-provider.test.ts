import { describe, expect, it, vi } from "vitest";
import { createAgentMemoryEmbeddingProvider } from "./agent-memory-embedding-provider";

describe("agent memory embedding provider", () => {
  it("uses local text embeddings by default", async () => {
    const provider = createAgentMemoryEmbeddingProvider({ kind: "local", dimensions: 64 });
    const [vector] = await provider.embedTexts(["local-first memory"]);

    expect(provider.dimensions).toBe(64);
    expect(vector).toHaveLength(64);
  });

  it("supports configurable OpenAI-compatible embedding providers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { embedding: [0.1, 0.2, 0.3] },
            { embedding: [0.4, 0.5, 0.6] },
          ],
        };
      },
    } as Response));
    const resolveApiKey = vi.fn(async () => "secret-key");
    const provider = createAgentMemoryEmbeddingProvider({
      kind: "openai-compatible",
      provider: "openai",
      model: "text-embedding-3-small",
      baseUrl: "https://api.example.test/v1/",
      apiKeyReference: "model.embedding",
      dimensions: 3,
    }, {
      fetch: fetchMock,
      resolveApiKey,
    });

    await expect(provider.embedTexts(["alpha", "beta"])).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(resolveApiKey).toHaveBeenCalledWith("model.embedding");
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: ["alpha", "beta"],
      }),
    });
  });

  it("can delegate OpenAI-compatible embedding execution to a native secret-hydrated provider", async () => {
    const embedOpenAiCompatible = vi.fn(async () => [[0.1, 0.2, 0.3]]);
    const resolveApiKey = vi.fn(async () => {
      throw new Error("JS secret resolver should not be used when native embedding is available");
    });
    const provider = createAgentMemoryEmbeddingProvider({
      kind: "openai-compatible",
      provider: "openai",
      model: "text-embedding-3-small",
      baseUrl: "https://api.example.test/v1/",
      apiKeyReference: "model.embedding",
      dimensions: 3,
    }, {
      embedOpenAiCompatible,
      resolveApiKey,
    });

    await expect(provider.embedTexts([" alpha "])).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(embedOpenAiCompatible).toHaveBeenCalledWith({
      providerId: "openai",
      model: "text-embedding-3-small",
      baseUrl: "https://api.example.test/v1/",
      apiKeyReference: "model.embedding",
      texts: ["alpha"],
    });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("rejects invalid external embedding responses", async () => {
    const provider = createAgentMemoryEmbeddingProvider({
      kind: "openai-compatible",
      provider: "openai",
      model: "text-embedding-3-small",
      baseUrl: "https://api.example.test/v1",
      apiKeyReference: "model.embedding",
    }, {
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return { data: [{ embedding: ["nope"] }] };
        },
      } as Response)),
      resolveApiKey: vi.fn(async () => "secret-key"),
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow("invalid embedding response");
  });
});
