import { describe, expect, it } from "vitest";
import { createRouteRegistry } from "./route-registry";

describe("createRouteRegistry", () => {
  it("rejects duplicate route kinds and preserves the original registration", () => {
    const registry = createRouteRegistry();
    registry.register("code", "original-workflow", () => ({
      route: "code",
      score: 7,
      signals: ["original"],
    }));

    expect(() => registry.register("code", "shadow-workflow", () => ({
      route: "code",
      score: 99,
      signals: ["shadow"],
    }))).toThrow(/already registered and cannot be shadowed/);

    expect(registry.getWorkflowId("code")).toBe("original-workflow");
    expect(registry.scoreAll("review code")).toEqual([{
      route: "code",
      score: 7,
      signals: ["original"],
    }]);
  });

  it("allows an explicitly unregistered route kind to be registered again", () => {
    const registry = createRouteRegistry();
    registry.register("research", "first-workflow", () => ({
      route: "research",
      score: 1,
      signals: [],
    }));
    registry.unregister("research");

    expect(() => registry.register("research", "second-workflow", () => ({
      route: "research",
      score: 2,
      signals: ["replacement-after-unload"],
    }))).not.toThrow();
    expect(registry.getWorkflowId("research")).toBe("second-workflow");
  });
});
