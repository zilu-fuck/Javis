import { describe, expect, it } from "vitest";
import { getProviderCapabilities } from "./app-runtime";

describe("getProviderCapabilities", () => {
  it("returns capabilities for openai", () => {
    const caps = getProviderCapabilities("openai");
    expect(caps.vision).toBe(true);
    expect(caps.code).toBe(true);
    expect(caps.longContext).toBe(true);
  });

  it("returns capabilities for deepseek (no vision)", () => {
    const caps = getProviderCapabilities("deepseek");
    expect(caps.vision).toBe(false);
    expect(caps.code).toBe(true);
  });

  it("returns capabilities for anthropic", () => {
    const caps = getProviderCapabilities("anthropic");
    expect(caps.vision).toBe(true);
    expect(caps.code).toBe(true);
  });

  it("falls back to OpenAIAdapter for unknown provider", () => {
    const caps = getProviderCapabilities("unknown-provider");
    // Should not throw — falls back to OpenAI adapter capabilities
    expect(caps.vision).toBe(true);
    expect(caps.code).toBe(true);
  });

  it("is case-insensitive", () => {
    const caps = getProviderCapabilities("DeepSeek");
    expect(caps.vision).toBe(false); // DeepSeek's actual capability
  });
});
