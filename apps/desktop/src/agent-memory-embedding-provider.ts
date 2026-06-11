import type { AgentMemoryEmbeddingProvider } from "./agent-memory";
import { createLocalTextEmbeddingProvider } from "./local-text-embedding";

export type AgentMemoryEmbeddingProviderConfig =
  | {
    kind: "local";
    dimensions?: number;
    provider?: string;
  }
  | {
    kind: "openai-compatible";
    provider: string;
    model: string;
    baseUrl: string;
    apiKeyReference: string;
    dimensions?: number;
  };

export interface AgentMemoryEmbeddingProviderDependencies {
  fetch?: typeof fetch;
  resolveApiKey?(reference: string): Promise<string>;
  embedOpenAiCompatible?(request: AgentMemoryOpenAiCompatibleEmbeddingRequest): Promise<number[][]>;
}

export interface AgentMemoryOpenAiCompatibleEmbeddingRequest {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKeyReference: string;
  texts: string[];
}

interface OpenAiEmbeddingResponse {
  data?: Array<{
    embedding?: unknown;
  }>;
}

export function createAgentMemoryEmbeddingProvider(
  config: AgentMemoryEmbeddingProviderConfig = { kind: "local" },
  dependencies: AgentMemoryEmbeddingProviderDependencies = {},
): AgentMemoryEmbeddingProvider {
  if (config.kind === "local") {
    return createLocalTextEmbeddingProvider({
      dimensions: config.dimensions,
      provider: config.provider,
    });
  }
  return createOpenAiCompatibleEmbeddingProvider(config, dependencies);
}

function createOpenAiCompatibleEmbeddingProvider(
  config: Extract<AgentMemoryEmbeddingProviderConfig, { kind: "openai-compatible" }>,
  dependencies: AgentMemoryEmbeddingProviderDependencies,
): AgentMemoryEmbeddingProvider {
  const dimensions = Math.max(1, Math.trunc(config.dimensions ?? 1536));
  return {
    dimensions,
    async embedTexts(texts) {
      const cleanTexts = texts.map((text) => text.trim());
      if (cleanTexts.some((text) => !text)) {
        throw new Error("Embedding input texts must be non-empty.");
      }
      if (dependencies.embedOpenAiCompatible) {
        return dependencies.embedOpenAiCompatible({
          providerId: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          apiKeyReference: config.apiKeyReference,
          texts: cleanTexts,
        });
      }
      const apiKey = await dependencies.resolveApiKey?.(config.apiKeyReference);
      if (!apiKey) {
        throw new Error("Embedding provider requires an API key reference resolver.");
      }
      const fetchImpl = dependencies.fetch ?? globalThis.fetch;
      if (!fetchImpl) {
        throw new Error("Embedding provider requires fetch.");
      }
      const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          input: cleanTexts,
        }),
      });
      if (!response.ok) {
        throw new Error(`Embedding provider request failed with HTTP ${response.status}.`);
      }
      const json = await response.json() as OpenAiEmbeddingResponse;
      const vectors = (json.data ?? []).map((item) => parseEmbeddingVector(item.embedding));
      if (vectors.length !== cleanTexts.length || vectors.some((vector) => !vector)) {
        throw new Error("Embedding provider returned an invalid embedding response.");
      }
      return vectors.map((vector) => vector!);
    },
  };
}

function parseEmbeddingVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const vector = value.map((item) => Number(item));
  return vector.length > 0 && vector.every(Number.isFinite) ? vector : undefined;
}
