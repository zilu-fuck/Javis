import type { ModelProvider } from "./model-provider";

export interface PreprocessedInput {
  language: string;
  intent: string;
  user_style: string;
  must_keep: string[];
  must_avoid: string[];
  missing_info: string[];
}

const DEFAULT_TIMEOUT_MS = 2000;

export async function preprocessChineseInput(
  userGoal: string,
  modelProvider: ModelProvider,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PreprocessedInput | undefined> {
  if (!containsCjk(userGoal)) {
    return undefined;
  }
  try {
    const response = await withTimeout(
      modelProvider.complete(createInputPreprocessorPrompt(userGoal), {
        maxTokens: 700,
        temperature: 0,
        locale: "zh-CN",
      }),
      timeoutMs,
    );
    return normalizePreprocessedInput(parseJsonObject(response.text));
  } catch {
    return undefined;
  }
}

export function createInputPreprocessorPrompt(userGoal: string): string {
  return [
    "You are Javis Chinese input preprocessor. Return JSON only.",
    "Extract the user's intent, preferred style, constraints to keep, constraints to avoid, and missing information.",
    "Do not answer the user's task. Do not invent facts.",
    "Schema:",
    "{\"language\":\"zh-CN\",\"intent\":\"技术解释\",\"user_style\":\"正式自然\",\"must_keep\":[\"原意\"],\"must_avoid\":[\"AI腔\"],\"missing_info\":[]}",
    `User input: ${userGoal}`,
  ].join("\n");
}

function normalizePreprocessedInput(value: unknown): PreprocessedInput {
  if (!isRecord(value)) {
    throw new Error("Preprocessed input response must be an object.");
  }
  return {
    language: stringValue(value.language, "zh-CN"),
    intent: stringValue(value.intent, "未分类"),
    user_style: stringValue(value.user_style, "自然"),
    must_keep: stringArray(value.must_keep),
    must_avoid: stringArray(value.must_avoid),
    missing_info: stringArray(value.missing_info),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error("Input preprocessing timed out.")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Preprocessed input response did not contain a JSON object.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
