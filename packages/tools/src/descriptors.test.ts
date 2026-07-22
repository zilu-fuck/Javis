import { describe, expect, it } from "vitest";
import { initialToolDescriptors } from "./descriptors";

describe("tool descriptors", () => {
  it("treats native path launching as approval-gated", () => {
    const descriptor = initialToolDescriptors.find((tool) => tool.name === "computer.openPath");

    expect(descriptor?.permissionLevel).toBe("confirmed_write");
    expect(descriptor?.writeRiskLevel).toBe("risky");
  });

  it("declares a generic Page Agent fallback for structured trend failures", () => {
    const descriptor = initialToolDescriptors.find((tool) => tool.name === "trend.fetchHotList");

    expect(descriptor?.summary).toContain("unsupported site");
    expect(descriptor?.summary).toContain("Page Agent");
    expect(descriptor?.metadata).toMatchObject({
      failureFallbackAgentKind: "page-agent",
      failureFallbackCapability: "browser_navigate",
    });
    expect(descriptor?.summary).not.toMatch(/bilibili|B站|哔哩/iu);
  });
});
