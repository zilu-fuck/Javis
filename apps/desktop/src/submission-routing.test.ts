import { describe, expect, it } from "vitest";
import { resolveVisionBridgeRuntimeMode } from "./submission-routing";

describe("resolveVisionBridgeRuntimeMode", () => {
  it("keeps project mode on Commander even when Vision Bridge runs", () => {
    expect(resolveVisionBridgeRuntimeMode("project", true)).toBe("project");
  });

  it("keeps chat bridge behavior outside project mode", () => {
    expect(resolveVisionBridgeRuntimeMode("chat", true)).toBe("chat");
    expect(resolveVisionBridgeRuntimeMode(undefined, true)).toBe("chat");
    expect(resolveVisionBridgeRuntimeMode("project", false)).toBe("project");
    expect(resolveVisionBridgeRuntimeMode(undefined, false)).toBeUndefined();
  });
});
