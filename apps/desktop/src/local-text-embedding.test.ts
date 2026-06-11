import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  createHashedTextVector,
  createLocalTextEmbeddingProvider,
} from "./local-text-embedding";

describe("local text embedding", () => {
  it("creates deterministic local embeddings without external services", async () => {
    const provider = createLocalTextEmbeddingProvider({ dimensions: 64 });
    const [query, related, unrelated] = await provider.embedTexts([
      "approval restore after desktop restart",
      "restore approval records after app restart",
      "render image thumbnails in gallery",
    ]);

    expect(provider.provider).toBe("local-text-hash-embedding");
    expect(query).toHaveLength(64);
    expect(provider.dimensions).toBe(64);
    expect(cosineSimilarity(query!, related!)).toBeGreaterThan(cosineSimilarity(query!, unrelated!));
  });

  it("uses the same hash vector primitive as semantic reranking", () => {
    const vector = createHashedTextVector("agentMemory local-first", 32);

    expect(vector).toHaveLength(32);
    expect([...vector].some((value) => value > 0)).toBe(true);
  });
});
