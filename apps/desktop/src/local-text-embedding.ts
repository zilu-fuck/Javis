export interface LocalTextEmbeddingProvider {
  dimensions: number;
  provider: string;
  embedTexts(texts: string[]): Promise<number[][]>;
}

export function createLocalTextEmbeddingProvider(options: {
  dimensions?: number;
  provider?: string;
} = {}): LocalTextEmbeddingProvider {
  const dimensions = Math.max(32, Math.min(4096, Math.trunc(options.dimensions ?? 256)));
  const provider = options.provider ?? "local-text-hash-embedding";
  return {
    dimensions,
    provider,
    async embedTexts(texts) {
      return texts.map((text) => [...createHashedTextVector(text, dimensions)]);
    },
  };
}

export function createHashedTextVector(text: string, dimensions: number): Float64Array {
  const vector = new Float64Array(Math.max(1, Math.trunc(dimensions)));
  for (const token of extractSemanticTokens(text)) {
    const index = hashSemanticToken(token) % vector.length;
    vector[index] += 1;
  }
  return vector;
}

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function extractSemanticTokens(text: string): string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9_\u4e00-\u9fff]+/g, " ")
    .toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) ?? [];
  return tokens.flatMap((token) => token.length > 3 && /^[a-z0-9_]+$/.test(token)
    ? [token, ...characterNgrams(token, 3)]
    : [token]);
}

function characterNgrams(value: string, size: number): string[] {
  const output: string[] = [];
  for (let index = 0; index <= value.length - size; index += 1) {
    output.push(value.slice(index, index + size));
  }
  return output;
}

function hashSemanticToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
