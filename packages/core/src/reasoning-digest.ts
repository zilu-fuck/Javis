/**
 * Durable reasoning digest.
 *
 * Provider thinking (`reasoning_content` / `reasoning`) is streamed for the live
 * panel and then thrown away: the delta reducer deleted the accumulated text when
 * the stream ended, so a finished step left no trace of *why* the model did what
 * it did. This module turns that text into something safe to keep.
 *
 * Two constraints come from the codebase's existing stance on model-authored
 * text (`workflow-executor.ts` ReAct reason sanitizer): reasons can quote tool
 * observations, so they must be redacted, and durable logs must stay small, so
 * they must be bounded.
 */
import { redactSensitiveText } from "./sensitive-data";

/** Matches the ReAct reason cap so every durable "why" reads at the same size. */
export const MAX_REASONING_DIGEST_CHARS = 320;

const REASONING_TAG_PATTERN = /<\s*\/?\s*(?:think|thinking|analysis|reasoning)\b[^>]*>/giu;
const IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu;

/**
 * Redacts and bounds a reasoning stream for durable storage. Returns undefined
 * when nothing usable is left, so callers can keep the previous digest instead
 * of overwriting it with an empty string.
 */
export function summarizeReasoningDigest(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = redactSensitiveText(
    text.replace(REASONING_TAG_PATTERN, " ").replace(IMAGE_DATA_URL_PATTERN, "[redacted:image data URL]"),
  )
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  if (characters.length <= MAX_REASONING_DIGEST_CHARS) return normalized;
  return `${characters.slice(0, MAX_REASONING_DIGEST_CHARS).join("")}...[truncated]`;
}
