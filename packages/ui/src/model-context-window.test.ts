import { describe, expect, it } from "vitest";
import {
  inferContextTokensFromModelName,
  resolveContextTokens,
  withInferredContextTokens,
} from "./model-context-window";

describe("model context window inference", () => {
  it("recognizes known 1M context models", () => {
    expect(inferContextTokensFromModelName("xiaomi/mimo-v2.5-pro", "mimo")).toBe(1_048_576);
    expect(inferContextTokensFromModelName("mimo-v2.5-pro", "mimo")).toBe(1_048_576);
    expect(inferContextTokensFromModelName("deepseek-v4-pro", "deepseek")).toBe(1_000_000);
    expect(inferContextTokensFromModelName("gpt-4.1-mini", "openai")).toBe(1_000_000);
  });

  it("recognizes explicit future model context hints", () => {
    expect(inferContextTokensFromModelName("vendor-next-1m")).toBe(1_000_000);
    expect(inferContextTokensFromModelName("vendor-next-1024k")).toBe(1_048_576);
    expect(inferContextTokensFromModelName("vendor-next-200k")).toBe(200_000);
    expect(inferContextTokensFromModelName("model-ctx262144")).toBe(262_144);
  });

  it("prefers explicit profile context tokens over inference", () => {
    expect(resolveContextTokens({
      provider: "openai",
      model: "gpt-4o",
      contextTokens: 999_999,
    })).toBe(999_999);
  });

  it("adds inferred context tokens without mutating known values", () => {
    expect(withInferredContextTokens({
      provider: "mimo",
      model: "mimo-v2.5-pro",
    })).toMatchObject({ contextTokens: 1_048_576 });
    expect(withInferredContextTokens({
      provider: "mimo",
      model: "mimo-v2.5-pro",
      contextTokens: 512_000,
    })).toMatchObject({ contextTokens: 512_000 });
  });
});
