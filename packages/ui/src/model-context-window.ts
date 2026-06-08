const DEFAULT_CONTEXT_TOKENS = 128_000;

const KNOWN_MODEL_CONTEXT_TOKENS: Array<[RegExp, number]> = [
  [/xiaomi\/?mimo-v?2\.5-pro/i, 1_048_576],
  [/mimo-v?2\.5-pro/i, 1_048_576],
  [/deepseek-v4-pro/i, 1_000_000],
  [/deepseek-chat/i, 1_000_000],
  [/^deepseek$/i, 1_000_000],
  [/deepseek-v4-flash/i, 128_000],
  [/gpt-4\.1(?:-|$)/i, 1_000_000],
  [/gpt-4\.1$/i, 1_000_000],
  [/gpt-4o(?:-|$)/i, 128_000],
  [/gpt-4o$/i, 128_000],
  [/claude-(?:opus|sonnet|haiku)-4/i, 200_000],
  [/minimax\/?minimax-m2\.[157]/i, 204_800],
  [/minimax-m2\.[157]/i, 204_800],
  [/glm-5(?:\.1)?/i, 256_000],
];

export interface ContextWindowModelProfile {
  provider?: string;
  model?: string;
  contextTokens?: number | null;
  capabilities?: {
    longContext?: boolean;
  };
}

export function getDefaultContextTokens(): number {
  return DEFAULT_CONTEXT_TOKENS;
}

export function inferContextTokensFromModelName(
  model: string | undefined,
  provider?: string,
): number | undefined {
  const normalizedModel = model?.trim();
  if (!normalizedModel) return undefined;

  const searchText = `${provider ?? ""}/${normalizedModel}`;
  for (const [pattern, tokens] of KNOWN_MODEL_CONTEXT_TOKENS) {
    if (pattern.test(searchText) || pattern.test(normalizedModel)) {
      return tokens;
    }
  }

  const explicit = parseExplicitContextHint(normalizedModel);
  if (explicit) return explicit;

  if (provider?.toLowerCase() === "mimo" && /mimo/i.test(normalizedModel)) {
    return 1_048_576;
  }

  return undefined;
}

export function resolveContextTokens(
  profile: ContextWindowModelProfile | undefined,
): number {
  if (!profile) return DEFAULT_CONTEXT_TOKENS;
  if (isUsableTokenLimit(profile.contextTokens)) {
    return Math.round(profile.contextTokens);
  }
  return inferContextTokensFromModelName(profile.model, profile.provider)
    ?? DEFAULT_CONTEXT_TOKENS;
}

export function withInferredContextTokens<T extends ContextWindowModelProfile>(
  profile: T,
): T {
  if (isUsableTokenLimit(profile.contextTokens)) return profile;
  const contextTokens = inferContextTokensFromModelName(profile.model, profile.provider);
  return contextTokens ? { ...profile, contextTokens } : profile;
}

function parseExplicitContextHint(model: string): number | undefined {
  const compact = model.toLowerCase().replace(/[\s_]+/g, "-");
  if (/(?:^|[-/.])1m(?:[-/.]|$)|1-million|1000k|1024k/.test(compact)) {
    return compact.includes("1024k") ? 1_048_576 : 1_000_000;
  }

  const kMatch = compact.match(/(?:^|[-/.])(\d{2,4})k(?:[-/.]|$)/);
  if (kMatch) {
    const tokens = Number(kMatch[1]) * 1_000;
    if (tokens >= 32_000) return tokens;
  }

  const tokenMatch = compact.match(/(?:context|ctx|window)[-/.]?(\d{5,7})/);
  if (tokenMatch) {
    const tokens = Number(tokenMatch[1]);
    if (tokens >= 32_000) return tokens;
  }

  return undefined;
}

function isUsableTokenLimit(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
