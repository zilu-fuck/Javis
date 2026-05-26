import { describe, expect, it } from "vitest";
import {
  CHINESE_REVIEW_SCORE_SCHEMA,
  createChineseReviewPrompt,
  createChineseRevisionPrompt,
  parseChineseReviewResult,
} from "./chinese-reviewer";
import {
  buildTerminologyPromptPrefix,
  injectTerminologyPrompt,
  shouldInjectTerminology,
} from "./terminology";

describe("ChineseReviewer prompt helpers", () => {
  it("builds a terms-only prompt that preserves structured output", () => {
    const prompt = createChineseReviewPrompt("{\"summary\":\"Token 被翻译成令牌\"}", "terms-only");

    expect(prompt).toContain("Only fix terminology consistency");
    expect(prompt).toContain("Preserve the original structure");
    expect(prompt).toContain("Token");
  });

  it("parses review text and clamps internal score fields", () => {
    const result = parseChineseReviewResult(JSON.stringify({
      text: "Agent 和 Token 保持英文。",
      score: {
        accuracy: 11,
        naturalness: 7.4,
        style_match: -1,
        term_consistency: 9,
        constraint_following: 8,
        redundancy: 6,
        needs_revision: true,
      },
    }));

    expect(result.text).toBe("Agent 和 Token 保持英文。");
    expect(result.score).toMatchObject({
      accuracy: 10,
      naturalness: 7,
      style_match: 0,
      needs_revision: true,
    });
  });

  it("creates a one-shot revision prompt without leaking scores into user text", () => {
    const prompt = createChineseRevisionPrompt("首先其次最后，这段话比较模板化。", {
      accuracy: 8,
      naturalness: 5,
      style_match: 7,
      term_consistency: 8,
      constraint_following: 8,
      redundancy: 3,
      needs_revision: true,
    });

    expect(prompt).toContain("Rewrite once");
    expect(prompt).toContain("\"score\"");
    expect(CHINESE_REVIEW_SCORE_SCHEMA.needs_revision).toBe("boolean");
  });
});

describe("Javis terminology prompt helpers", () => {
  it("injects terminology only for Chinese locale", () => {
    expect(shouldInjectTerminology("zh-CN")).toBe(true);
    expect(shouldInjectTerminology("en")).toBe(false);
    expect(buildTerminologyPromptPrefix("zh-CN")).toContain("Agent");
    expect(injectTerminologyPrompt("Return JSON only.", "zh-CN")).toContain("Return JSON only.");
    expect(injectTerminologyPrompt("Return JSON only.", "en")).toBe("Return JSON only.");
  });
});
