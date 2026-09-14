import { describe, expect, it, vi } from "vitest";
import {
  collectPlannerWorkspaceInventory,
  formatPlannerWorkspaceInventory,
  summarizeWorkspaceInspection,
} from "./planner-workspace-inventory";

describe("workspace inspection summary", () => {
  it("keeps the fields the planner can act on", () => {
    const summary = summarizeWorkspaceInspection({
      workspacePath: "E:/shop",
      entries: [{}, {}, {}],
      topLevelDirectories: ["apps", "packages"],
      moduleCandidates: ["apps/desktop"],
      manifests: ["package.json"],
      ignoredDirectories: ["node_modules"],
      riskIndicators: [{ label: "filename-risk", path: "a.exe" }, { path: "no-label" }],
      truncated: true,
    });
    expect(summary).toEqual({
      workspacePath: "E:/shop",
      entries: 3,
      topLevelDirectories: ["apps", "packages"],
      moduleCandidates: ["apps/desktop"],
      manifests: ["package.json"],
      ignoredDirectories: ["node_modules"],
      riskIndicators: ["filename-risk"],
      truncated: true,
    });
  });

  it("rejects payloads that carry nothing the planner can use", () => {
    expect(summarizeWorkspaceInspection(undefined)).toBeUndefined();
    expect(summarizeWorkspaceInspection("not an object")).toBeUndefined();
    expect(summarizeWorkspaceInspection({ workspacePath: "E:/empty", entries: [] })).toBeUndefined();
  });
});

describe("planner workspace inventory formatting", () => {
  it("renders one bounded line per category", () => {
    const text = formatPlannerWorkspaceInventory({
      workspacePath: "E:/shop",
      entries: 42,
      topLevelDirectories: Array.from({ length: 25 }, (_, index) => `dir-${index}`),
      moduleCandidates: ["apps/desktop"],
      manifests: ["package.json"],
      ignoredDirectories: [],
      riskIndicators: [],
      truncated: true,
    });
    expect(text).toContain("workspace=E:/shop entries=42 truncated=true");
    expect(text).toContain("top-level: dir-0, dir-1");
    expect(text).toContain("(+5 more)");
    expect(text).toContain("modules: apps/desktop");
    expect(text).toContain("manifests: package.json");
    // Empty categories must not produce empty lines.
    expect(text).not.toContain("ignored:");
    expect(text).not.toContain("risk:");
    expect(text.split("\n").every((line) => line.trim().length > 0)).toBe(true);
  });
});

describe("planner workspace inventory collection", () => {
  it("returns nothing when the tool or the workspace is missing", async () => {
    expect(await collectPlannerWorkspaceInventory({ workspacePath: "E:/shop" })).toBe("");
    const inspectWorkspace = vi.fn();
    expect(await collectPlannerWorkspaceInventory({ inspectWorkspace })).toBe("");
    expect(inspectWorkspace).not.toHaveBeenCalled();
  });

  it("degrades to nothing instead of blocking planning when inspection fails", async () => {
    const text = await collectPlannerWorkspaceInventory({
      workspacePath: "E:/shop",
      inspectWorkspace: () => Promise.reject(new Error("workspace guard refused")),
    });
    expect(text).toBe("");
  });

  it("asks for a bounded inspection and renders the result", async () => {
    const inspectWorkspace = vi.fn(async () => ({
      workspacePath: "E:/shop",
      entries: [],
      topLevelDirectories: ["apps"],
      moduleCandidates: [],
      manifests: ["package.json"],
      ignoredDirectories: ["node_modules"],
      riskIndicators: [],
      truncated: false,
    }));
    const text = await collectPlannerWorkspaceInventory({ workspacePath: "E:/shop", inspectWorkspace });
    expect(inspectWorkspace).toHaveBeenCalledWith({ maxDepth: 2, maxEntries: 120 });
    expect(text).toContain("workspace=E:/shop");
    expect(text).toContain("top-level: apps");
  });

  it("returns nothing for a payload with no usable structure", async () => {
    const text = await collectPlannerWorkspaceInventory({
      workspacePath: "E:/shop",
      inspectWorkspace: async () => ({ workspacePath: "E:/shop" }),
    });
    expect(text).toBe("");
  });
});
