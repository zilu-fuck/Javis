/**
 * Prompt-determinism primitives (research roadmap P0-3).
 *
 * Providers reuse a prefix cache only when the cache-relevant bytes of
 * consecutive requests are identical. These helpers give prompt assembly a
 * locale-independent ordering primitive and give the model provider a
 * DSH-style runtime probe that verifies the item-wise prefix invariant
 * ("request N must be an item-wise prefix of request N+1") on live traffic.
 * Fingerprints are hashes only — never prompt content.
 */

/** Pure codepoint comparison; unlike `localeCompare` it never varies with ICU/locale. */
export function compareStringsByCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** FNV-1a 32-bit over UTF-16 code units; stable across engines and processes. */
export function hashPromptItem(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface CacheProbeItems {
  systemPrompt?: string;
  messages?: ReadonlyArray<{ role: string; content: string }>;
  prompt: string;
}

/**
 * One fingerprint per cache-relevant wire item, in provider-visible order:
 * system prompt first, then transcript messages, then the current prompt.
 */
export function computeCacheProbeFingerprints(items: CacheProbeItems): string[] {
  const fingerprints: string[] = [];
  if (items.systemPrompt !== undefined && items.systemPrompt !== "") {
    fingerprints.push(hashPromptItem(`system\u0000${items.systemPrompt}`));
  }
  for (const message of items.messages ?? []) {
    fingerprints.push(hashPromptItem(`${message.role}\u0000${message.content}`));
  }
  fingerprints.push(hashPromptItem(`user\u0000${items.prompt}`));
  return fingerprints;
}

export type CacheProbeViolation = {
  index: number;
  kind: "changed" | "shrunk";
};

/**
 * Item-wise prefix invariant: every item of `previous` must reappear
 * unchanged at the same position in `next`. Appends are expected; edits and
 * shrinks are cache breaks.
 */
export function findCacheProbeViolation(
  previous: readonly string[],
  next: readonly string[],
): CacheProbeViolation | null {
  for (let index = 0; index < previous.length; index += 1) {
    if (index >= next.length) return { index, kind: "shrunk" };
    if (previous[index] !== next[index]) return { index, kind: "changed" };
  }
  return null;
}

export function describeCacheProbeViolation(
  scope: string,
  violation: CacheProbeViolation,
  previous: readonly string[],
  next: readonly string[],
): string {
  const at = violation.index < previous.length ? previous[violation.index] : "—";
  const became = violation.index < next.length ? next[violation.index] : "—";
  return [
    `cache prefix broken (scope ${scope})`,
    `item ${violation.index} ${violation.kind}`,
    `${at} -> ${became}`,
    `items ${previous.length} -> ${next.length}`,
  ].join("; ");
}
