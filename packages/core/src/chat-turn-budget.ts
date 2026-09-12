/**
 * Pre-flight budget for the *current* chat turn (A5).
 *
 * History is already windowed by `selectModelContextMessages`, which caps it at
 * 64k / 256k tokens. A provider context-length error therefore has to come from
 * the turn being answered: a pasted document, or an injected `@document`
 * reference. Production hit exactly that:
 *
 *   maximum context length is 1048565 tokens. However, you requested 1259929
 *   tokens (1257881 in the messages, 2048 in the completion).
 *
 * Trimming the turn costs one notice; not trimming it costs a full round trip and,
 * on a cache-bearing provider, a cold prefix.
 *
 * This is deliberately *not* the history windowing path: history clipping may
 * collapse whitespace and drop whole turns, while the turn being answered is the
 * user's own text and keeps its formatting apart from the cut.
 */

/** Conservative window when the caller does not know the model's context size. */
export const DEFAULT_CHAT_TURN_WINDOW_TOKENS = 32_000;

/** Room held back for the completion. */
export const CHAT_TURN_OUTPUT_RESERVE_TOKENS = 8_192;

/** Extra headroom so provider-side framing tokens do not push us over. */
export const CHAT_TURN_SAFETY_TOKENS = 1_024;

/** Never clip a turn below this, even for a tiny configured window. */
export const CHAT_TURN_MIN_BUDGET_TOKENS = 2_048;

/** Share of the budget kept from the start; the rest keeps the tail. */
const CHAT_TURN_HEAD_SHARE = 0.8;

export interface ClipChatTurnResult {
  /** The prompt to send. Identical to the input when it already fits. */
  prompt: string;
  clipped: boolean;
  /** Estimated tokens before and after clipping. */
  originalTokens: number;
  clippedTokens: number;
  budgetTokens: number;
}

/**
 * Token estimate, byte-based and tokenizer-independent.
 *
 * It deliberately over-counts CJK rather than under-count: under-counting is the
 * failure that produces a provider 400.
 */
export function estimateChatTurnTokens(text: string): number {
  if (!text) return 0;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code > 0x7f ? 3 : 1;
  }
  return Math.ceil(bytes / 3);
}

export function resolveChatTurnBudgetTokens(contextWindowTokens?: number): number {
  const window = typeof contextWindowTokens === "number"
    && Number.isFinite(contextWindowTokens)
    && contextWindowTokens > 0
    ? Math.floor(contextWindowTokens)
    : DEFAULT_CHAT_TURN_WINDOW_TOKENS;
  return Math.max(
    CHAT_TURN_MIN_BUDGET_TOKENS,
    window - CHAT_TURN_OUTPUT_RESERVE_TOKENS - CHAT_TURN_SAFETY_TOKENS,
  );
}

export function clipChatTurnPrompt(
  prompt: string,
  contextWindowTokens?: number,
): ClipChatTurnResult {
  const budgetTokens = resolveChatTurnBudgetTokens(contextWindowTokens);
  const originalTokens = estimateChatTurnTokens(prompt);
  if (originalTokens <= budgetTokens) {
    return { prompt, clipped: false, originalTokens, clippedTokens: originalTokens, budgetTokens };
  }

  const omittedTokens = Math.max(0, originalTokens - budgetTokens);
  const build = (keepCharacters: number): string => {
    const head = Math.floor(keepCharacters * CHAT_TURN_HEAD_SHARE);
    const tail = Math.max(0, keepCharacters - head);
    return [
      prompt.slice(0, head),
      `\n\n[本轮输入过长，已按模型上下文窗口截断约 ${omittedTokens} tokens]\n\n`,
      tail > 0 ? prompt.slice(prompt.length - tail) : "",
    ].join("");
  };

  // The notice itself costs tokens, and tokens per character are not uniform, so
  // the first estimate can still land above budget. Shrink until it fits.
  let keepCharacters = Math.max(1, Math.floor(prompt.length * budgetTokens / originalTokens));
  let clipped = build(keepCharacters);
  let attempts = 0;
  while (estimateChatTurnTokens(clipped) > budgetTokens && keepCharacters > 1 && attempts < 16) {
    keepCharacters = Math.max(1, Math.floor(keepCharacters * 0.9));
    clipped = build(keepCharacters);
    attempts += 1;
  }

  return {
    prompt: clipped,
    clipped: true,
    originalTokens,
    clippedTokens: estimateChatTurnTokens(clipped),
    budgetTokens,
  };
}
