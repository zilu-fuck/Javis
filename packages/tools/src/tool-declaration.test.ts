import { describe, expect, it } from "vitest";
import { initialToolDescriptors } from "./descriptors";
import type { ToolDescriptor } from "./types";
import {
  isPermissionRelaxation,
  isToolNameWellFormed,
  mergeToolDeclarations,
  permissionRank,
  validateToolDeclaration,
} from "./tool-declaration";

function baseDescriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "code.searchRepository",
    permissionLevel: "read",
    summary: "Search the repository",
    capabilityTags: ["code_search"],
    ownerAgentKinds: ["code", "explorer"],
    ...overrides,
  };
}

describe("tool name and permission helpers", () => {
  it("accepts the {category}.{action} form and rejects everything else", () => {
    expect(isToolNameWellFormed("code.searchRepository")).toBe(true);
    expect(isToolNameWellFormed("file.writeText")).toBe(true);
    for (const bad of ["searchRepository", "code.", ".search", "Code.Search", "code/search", "code..x"]) {
      expect(isToolNameWellFormed(bad), `${bad} must be rejected`).toBe(false);
    }
  });

  it("ranks permissions so the dangerous direction is detectable", () => {
    expect(permissionRank("read")).toBeLessThan(permissionRank("preview"));
    expect(permissionRank("preview")).toBeLessThan(permissionRank("confirmed_write"));
    expect(permissionRank("confirmed_write")).toBeLessThan(permissionRank("dangerous"));
    // Relaxing a level is the dangerous direction; tightening it is not.
    expect(isPermissionRelaxation("confirmed_write", "read")).toBe(true);
    expect(isPermissionRelaxation("read", "confirmed_write")).toBe(false);
    expect(isPermissionRelaxation("read", "read")).toBe(false);
  });
});

describe("validateToolDeclaration", () => {
  it("accepts a well-formed declaration", () => {
    const result = validateToolDeclaration({
      name: "trend.fetchHotList",
      permissionLevel: "read",
      capabilityTags: ["trend_fetch"],
      ownerAgentKinds: ["research"],
      inputSchema: { type: "object", properties: { provider: { type: "string" } }, required: ["provider"] },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor?.permissionLevel).toBe("read");
  });

  it("rejects a malformed tool name before anything else", () => {
    const result = validateToolDeclaration({ name: "NotATool" });
    expect(result.descriptor).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ severity: "error", path: "tools[0].name" });
  });

  it("requires lower_snake_case capability tags", () => {
    const result = validateToolDeclaration({
      name: "a.b",
      permissionLevel: "read",
      capabilityTags: ["CodeSearch"],
    });
    expect(result.descriptor).toBeUndefined();
    expect(result.diagnostics[0].message).toContain("lower_snake_case");
  });

  it("defaults a missing permission level to read without flagging it", () => {
    // Whether this is worth a warning depends on whether the tool exists, which
    // only the merge step knows.
    const result = validateToolDeclaration({ name: "a.b" });
    expect(result.descriptor?.permissionLevel).toBe("read");
    expect(result.diagnostics).toEqual([]);
  });

  it("catches schema mistakes that would make validation meaningless", () => {
    const required = validateToolDeclaration({
      name: "a.b",
      permissionLevel: "read",
      inputSchema: { type: "object", properties: { goal: { type: "string" } }, required: ["missing"] },
    });
    expect(required.descriptor).toBeUndefined();
    expect(required.diagnostics[0].message).toContain("is not declared in properties");

    const pattern = validateToolDeclaration({
      name: "a.b",
      permissionLevel: "read",
      inputSchema: { type: "string", pattern: "[unclosed" },
    });
    expect(pattern.descriptor).toBeUndefined();
    expect(pattern.diagnostics[0].message).toContain("not a valid regular expression");

    const array = validateToolDeclaration({
      name: "a.b",
      permissionLevel: "read",
      outputSchema: { type: "array" },
    });
    expect(array.descriptor).toBeDefined();
    expect(array.diagnostics[0]).toMatchObject({ severity: "warning" });
  });
});

describe("mergeToolDeclarations", () => {
  it("returns the builtin set untouched with no declarations", () => {
    const result = mergeToolDeclarations([baseDescriptor()], []);
    expect(result.descriptors).toHaveLength(1);
    expect(result).toMatchObject({ disabledNames: [], addedNames: [], overriddenNames: [], diagnostics: [] });
  });

  it("adds a brand new tool", () => {
    const result = mergeToolDeclarations([baseDescriptor()], [
      { name: "acme.runReport", permissionLevel: "read", capabilityTags: ["acme_report"], ownerAgentKinds: ["research"] },
    ]);
    expect(result.addedNames).toEqual(["acme.runReport"]);
    expect(result.descriptors.map((descriptor) => descriptor.name)).toContain("acme.runReport");
  });

  it("warns when a new tool declares no permission level", () => {
    const result = mergeToolDeclarations([baseDescriptor()], [{ name: "acme.runReport" }]);
    expect(result.descriptors.find((descriptor) => descriptor.name === "acme.runReport")?.permissionLevel)
      .toBe("read");
    expect(result.diagnostics[0]).toMatchObject({ severity: "warning", path: "tools[0].permissionLevel" });
  });

  it("overrides only the fields a declaration states", () => {
    const result = mergeToolDeclarations([baseDescriptor()], [
      { name: "code.searchRepository", summary: "Custom summary" },
    ]);
    const merged = result.descriptors.find((descriptor) => descriptor.name === "code.searchRepository");
    expect(merged?.summary).toBe("Custom summary");
    expect(merged?.permissionLevel).toBe("read");
    expect(merged?.capabilityTags).toEqual(["code_search"]);
    expect(result.overriddenNames).toEqual(["code.searchRepository"]);
  });

  it("replaces owners wholesale so a narrowed allowlist is not silently widened", () => {
    const result = mergeToolDeclarations([baseDescriptor()], [
      { name: "code.searchRepository", ownerAgentKinds: ["code"] },
    ]);
    expect(result.descriptors[0].ownerAgentKinds).toEqual(["code"]);
  });

  it("refuses to lower a permission level, with a diagnostic", () => {
    const result = mergeToolDeclarations(
      [baseDescriptor({ permissionLevel: "confirmed_write" })],
      [{ name: "code.searchRepository", permissionLevel: "read" }],
    );
    expect(result.overriddenNames).toEqual([]);
    expect(result.descriptors[0].permissionLevel).toBe("confirmed_write");
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      path: "tools[0].permissionLevel",
    });
    expect(result.diagnostics[0].message).toContain("never loosen it");
  });

  it("allows raising a permission level", () => {
    const result = mergeToolDeclarations([baseDescriptor()], [
      { name: "code.searchRepository", permissionLevel: "confirmed_write" },
    ]);
    expect(result.descriptors[0].permissionLevel).toBe("confirmed_write");
    expect(result.diagnostics).toEqual([]);
  });

  it("disables a builtin tool", () => {
    const result = mergeToolDeclarations(
      [baseDescriptor(), baseDescriptor({ name: "shell.runReadOnlyCommand", capabilityTags: ["shell_readonly"] })],
      [{ name: "shell.runReadOnlyCommand", disabled: true }],
    );
    expect(result.disabledNames).toEqual(["shell.runReadOnlyCommand"]);
    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual(["code.searchRepository"]);
  });

  it("warns rather than fails when disabling a tool that does not exist", () => {
    const result = mergeToolDeclarations([baseDescriptor()], [{ name: "nope.nope", disabled: true }]);
    expect(result.disabledNames).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ severity: "warning" });
  });

  it("does not mutate the base descriptors", () => {
    const base = [baseDescriptor()];
    mergeToolDeclarations(base, [{ name: "code.searchRepository", summary: "changed" }]);
    expect(base[0].summary).toBe("Search the repository");
  });

  it("applies cleanly to the real builtin registry", () => {
    const result = mergeToolDeclarations(initialToolDescriptors, [
      { name: "code.searchRepository", summary: "Declared summary" },
      { name: "file.scanMarkdownDocuments", disabled: true },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.overriddenNames).toEqual(["code.searchRepository"]);
    expect(result.disabledNames).toEqual(["file.scanMarkdownDocuments"]);
    expect(result.descriptors).toHaveLength(initialToolDescriptors.length - 1);
    // Every other builtin survives.
    for (const descriptor of initialToolDescriptors) {
      if (descriptor.name === "file.scanMarkdownDocuments") continue;
      expect(result.descriptors.some((item) => item.name === descriptor.name)).toBe(true);
    }
  });
});
