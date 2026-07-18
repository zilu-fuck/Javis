import { describe, expect, it } from "vitest";
import type { ModelProfile } from "./model-settings";
import { bridgeVisionIfNeeded } from "./vision-bridge";

function profile(
  slot: "primary" | "multimodal",
  vision: boolean,
  model = "test-model",
): ModelProfile {
  return {
    id: slot,
    slot,
    displayName: slot,
    provider: "openai",
    model,
    apiKeyReference: `model.${slot}`,
    baseUrl: "https://example.test/v1",
    capabilities: { vision, code: false, longContext: false },
  };
}

describe("bridgeVisionIfNeeded", () => {
  it("strips inline image markers and forwards media to a vision-capable primary model", async () => {
    const result = await bridgeVisionIfNeeded({
      userMessage: "[image: data:image/png;base64,AA==]\nDescribe this image",
      primaryProfile: profile("primary", true),
      multimodalProfile: profile("multimodal", true),
      locale: "en",
    });

    expect(result).toEqual({
      enrichedMessage: "Describe this image",
      bridgeUsed: false,
      passThroughImages: true,
    });
    expect(result.enrichedMessage).not.toContain("base64");
  });

  it("does not leak image data when no bridge-capable model is configured", async () => {
    const result = await bridgeVisionIfNeeded({
      userMessage: "[image: data:image/png;base64,AA==]\nDescribe this image",
      primaryProfile: profile("primary", false),
      multimodalProfile: profile("multimodal", false, ""),
      locale: "en",
    });

    expect(result.bridgeUsed).toBe(false);
    expect(result.passThroughImages).toBe(false);
    expect(result.enrichedMessage).toContain("Describe this image");
    expect(result.enrichedMessage).not.toContain("base64");
  });

  it("does not silently drop images when model profiles are unavailable", async () => {
    const result = await bridgeVisionIfNeeded({
      userMessage: "[image: data:image/png;base64,AA==]\nDescribe this image",
      locale: "en",
    });

    expect(result.bridgeUsed).toBe(false);
    expect(result.passThroughImages).toBe(false);
    expect(result.enrichedMessage).toContain("no vision-capable model is configured");
    expect(result.enrichedMessage).not.toContain("base64");
  });
});
