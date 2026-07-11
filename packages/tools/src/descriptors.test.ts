import { describe, expect, it } from "vitest";
import { initialToolDescriptors } from "./descriptors";

describe("tool descriptors", () => {
  it("treats native path launching as approval-gated", () => {
    const descriptor = initialToolDescriptors.find((tool) => tool.name === "computer.openPath");

    expect(descriptor?.permissionLevel).toBe("confirmed_write");
    expect(descriptor?.writeRiskLevel).toBe("risky");
  });
});
