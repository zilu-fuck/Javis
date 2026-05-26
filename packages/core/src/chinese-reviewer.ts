export type ChineseReviewMode = "full" | "terms-only";

export interface ChineseReviewScore {
  accuracy: number;
  naturalness: number;
  style_match: number;
  term_consistency: number;
  constraint_following: number;
  redundancy: number;
  needs_revision: boolean;
}

export interface ChineseReviewResult {
  text: string;
  score: ChineseReviewScore;
}

export const CHINESE_REVIEW_SCORE_SCHEMA = {
  accuracy: "number 0-10",
  naturalness: "number 0-10",
  style_match: "number 0-10",
  term_consistency: "number 0-10",
  constraint_following: "number 0-10",
  redundancy: "number 0-10, where 10 means no redundant or templated wording",
  needs_revision: "boolean",
} as const;

const DEFAULT_SCORE: ChineseReviewScore = {
  accuracy: 8,
  naturalness: 8,
  style_match: 8,
  term_consistency: 8,
  constraint_following: 8,
  redundancy: 8,
  needs_revision: false,
};

export function createChineseReviewPrompt(text: string, mode: ChineseReviewMode): string {
  const modeInstruction =
    mode === "terms-only"
      ? "Only fix terminology consistency. Preserve the original structure exactly, especially JSON keys and JSON shape."
      : [
          "Lightly revise the Chinese text so it reads naturally.",
          "Remove templated phrasing such as repeated firstly/secondly/finally structures.",
          "Vary sentence length naturally.",
          "Preserve the original meaning and do not add facts.",
        ].join("\n");

  return [
    "You are Javis ChineseReviewer. Return one JSON object only.",
    modeInstruction,
    "Keep technical terms such as Agent, Token, diff, patch, hunk, workspace, approval, proposal, verifier, Commander, and open source consistent with Javis terminology.",
    "Output schema:",
    "{\"text\":\"reviewed complete text\",\"score\":{\"accuracy\":8,\"naturalness\":8,\"style_match\":8,\"term_consistency\":8,\"constraint_following\":8,\"redundancy\":8,\"needs_revision\":false}}",
    "Score dimensions are internal and must not be included inside text.",
    "Text to review:",
    text,
  ].join("\n");
}

export function createChineseRevisionPrompt(text: string, score: ChineseReviewScore): string {
  return [
    "You are Javis ChineseReviewer. Return one JSON object only.",
    "The previous review decided this text still needs one revision. Rewrite once, lightly.",
    "Preserve meaning, facts, structure, code, paths, commands, and JSON keys.",
    `Previous score: ${JSON.stringify(score)}`,
    "Output schema:",
    "{\"text\":\"reviewed complete text\",\"score\":{\"accuracy\":8,\"naturalness\":8,\"style_match\":8,\"term_consistency\":8,\"constraint_following\":8,\"redundancy\":8,\"needs_revision\":false}}",
    "Text to revise:",
    text,
  ].join("\n");
}

export function parseChineseReviewResult(text: string): ChineseReviewResult {
  const value = parseJsonObject(text);
  if (!isRecord(value)) {
    throw new Error("Chinese review response must be a JSON object.");
  }
  return {
    text: stringValue(value.text, text),
    score: normalizeScore(value.score),
  };
}

function normalizeScore(value: unknown): ChineseReviewScore {
  if (!isRecord(value)) {
    return DEFAULT_SCORE;
  }
  return {
    accuracy: scoreValue(value.accuracy, DEFAULT_SCORE.accuracy),
    naturalness: scoreValue(value.naturalness, DEFAULT_SCORE.naturalness),
    style_match: scoreValue(value.style_match, DEFAULT_SCORE.style_match),
    term_consistency: scoreValue(value.term_consistency, DEFAULT_SCORE.term_consistency),
    constraint_following: scoreValue(
      value.constraint_following,
      DEFAULT_SCORE.constraint_following,
    ),
    redundancy: scoreValue(value.redundancy, DEFAULT_SCORE.redundancy),
    needs_revision: value.needs_revision === true,
  };
}

function scoreValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(10, Math.max(0, Math.round(value)))
    : fallback;
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
