import { describe, expect, it } from "vitest";
import {
  CHAT_TURN_MIN_BUDGET_TOKENS,
  CHAT_TURN_OUTPUT_RESERVE_TOKENS,
  CHAT_TURN_SAFETY_TOKENS,
  DEFAULT_CHAT_TURN_WINDOW_TOKENS,
  clipChatTurnPrompt,
  estimateChatTurnTokens,
  resolveChatTurnBudgetTokens,
} from "./chat-turn-budget";

describe("chat turn token estimation", () => {
  it("counts ASCII and CJK without under-counting", () => {
    expect(estimateChatTurnTokens("")).toBe(0);
    expect(estimateChatTurnTokens("abc")).toBe(1);
    // CJK is estimated at one token per character, the conservative direction.
    expect(estimateChatTurnTokens("中文测试")).toBe(4);
    expect(estimateChatTurnTokens("中文abcdef")).toBe(4);
  });
});

describe("chat turn budget", () => {
  it("reserves output room and safety headroom", () => {
    expect(resolveChatTurnBudgetTokens(64_000)).toBe(
      64_000 - CHAT_TURN_OUTPUT_RESERVE_TOKENS - CHAT_TURN_SAFETY_TOKENS,
    );
  });

  it("falls back to a conservative window and never drops below the floor", () => {
    expect(resolveChatTurnBudgetTokens(undefined)).toBe(
      DEFAULT_CHAT_TURN_WINDOW_TOKENS - CHAT_TURN_OUTPUT_RESERVE_TOKENS - CHAT_TURN_SAFETY_TOKENS,
    );
    expect(resolveChatTurnBudgetTokens(16)).toBe(CHAT_TURN_MIN_BUDGET_TOKENS);
    expect(resolveChatTurnBudgetTokens(Number.NaN)).toBeGreaterThan(0);
  });
});

describe("clipChatTurnPrompt", () => {
  it("returns the prompt untouched when it fits", () => {
    const prompt = "解释一下这个函数的作用";
    const result = clipChatTurnPrompt(prompt, 32_000);
    expect(result.clipped).toBe(false);
    expect(result.prompt).toBe(prompt);
    expect(result.originalTokens).toBe(result.clippedTokens);
  });

  it("clips an oversized turn, keeps both ends, and reports the omission", () => {
    // 120k CJK characters is ~120k tokens: far past a 32k window.
    const prompt = `请总结以下文档：${"中".repeat(120_000)}结束语`;
    const result = clipChatTurnPrompt(prompt, 32_000);

    expect(result.clipped).toBe(true);
    expect(result.clippedTokens).toBeLessThanOrEqual(result.budgetTokens);
    expect(result.originalTokens).toBeGreaterThan(result.budgetTokens);
    // The user's opening instruction and the tail survive, so the model still
    // knows what was asked and how the document ended.
    expect(result.prompt.startsWith("请总结以下文档：")).toBe(true);
    expect(result.prompt.endsWith("结束语")).toBe(true);
    expect(result.prompt).toContain("已按模型上下文窗口截断");
  });

  it("scales the clip to the configured window", () => {
    const prompt = "中".repeat(50_000);
    const small = clipChatTurnPrompt(prompt, 16_000);
    const large = clipChatTurnPrompt(prompt, 64_000);
    expect(small.prompt.length).toBeLessThan(large.prompt.length);
    expect(large.clippedTokens).toBeLessThanOrEqual(large.budgetTokens);
  });

  it("preserves interior formatting of the retained text", () => {
    const body = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join("\n");
    const prompt = `${body}\n${"x".repeat(200_000)}`;
    const result = clipChatTurnPrompt(prompt, 8_000);
    expect(result.clipped).toBe(true);
    // Newlines in the kept head are not collapsed into single spaces.
    expect(result.prompt.slice(0, 400)).toContain("\n");
  });
});
