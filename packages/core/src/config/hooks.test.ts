import { beforeEach, describe, expect, it } from "vitest";
import type { JavisHookDeclaration } from "./javis-config";
import {
  configureHooks,
  createHookRegistry,
  evaluateHooks,
  hookAppliesToTool,
  listConfiguredHooks,
  resetHooks,
  validateHookDeclarations,
} from "./hooks";

function hook(overrides: Partial<JavisHookDeclaration> & Pick<JavisHookDeclaration, "id" | "phase" | "action">): JavisHookDeclaration {
  return overrides;
}

const denyShell = hook({
  id: "deny-shell",
  phase: "beforeToolCall",
  tool: "shell.runReadOnlyCommand",
  action: { kind: "deny", reason: "shell is disabled for this project" },
});
const requireApprovalForWrites = hook({
  id: "writes-need-approval",
  phase: "beforeToolCall",
  tool: "file.writeText",
  action: { kind: "requireApproval", reason: "writing files needs a human" },
});
const annotateSearch = hook({
  id: "tag-search",
  phase: "afterToolCall",
  tool: "code.searchRepository",
  action: { kind: "annotate", field: "reviewed", value: "true" },
});
const notifyFailure = hook({
  id: "notify-failure",
  phase: "onTaskFail",
  action: { kind: "notify", message: "a task failed; check the diagnostics bundle" },
});

beforeEach(() => {
  resetHooks();
});

describe("hookAppliesToTool", () => {
  it("treats a missing tool as a wildcard", () => {
    expect(hookAppliesToTool({ ...denyShell, tool: undefined }, "anything")).toBe(true);
  });

  it("matches exact names, prefixes and the wildcard", () => {
    expect(hookAppliesToTool(denyShell, "shell.runReadOnlyCommand")).toBe(true);
    expect(hookAppliesToTool(denyShell, "shell.runWorkspaceCommand")).toBe(false);
    expect(hookAppliesToTool({ ...denyShell, tool: "shell.*" }, "shell.runWorkspaceCommand")).toBe(true);
    expect(hookAppliesToTool({ ...denyShell, tool: "*" }, "anything.at.all")).toBe(true);
  });

  it("does not apply a tool-scoped hook to a phase without a tool", () => {
    expect(hookAppliesToTool(denyShell, undefined)).toBe(false);
  });
});

describe("createHookRegistry.evaluate", () => {
  it("allows everything when no hook is declared", () => {
    const decision = createHookRegistry().evaluate({ phase: "beforeToolCall", toolName: "x" });
    expect(decision).toEqual({
      decision: "allow",
      reasons: [],
      annotations: [],
      notices: [],
      appliedHookIds: [],
    });
  });

  it("denies a matching tool and reports the reason", () => {
    const decision = createHookRegistry([denyShell]).evaluate({
      phase: "beforeToolCall",
      toolName: "shell.runReadOnlyCommand",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasons).toEqual(["shell is disabled for this project"]);
    expect(decision.appliedHookIds).toEqual(["deny-shell"]);
  });

  it("ignores hooks for other phases and other tools", () => {
    const registry = createHookRegistry([denyShell, notifyFailure]);
    expect(registry.evaluate({ phase: "beforeToolCall", toolName: "file.scanMarkdownDocuments" }).decision)
      .toBe("allow");
    expect(registry.evaluate({ phase: "afterToolCall", toolName: "shell.runReadOnlyCommand" }).decision)
      .toBe("allow");
  });

  it("collects a deny and a require-approval reason together, with deny winning", () => {
    const registry = createHookRegistry([
      requireApprovalForWrites,
      hook({
        id: "deny-writes",
        phase: "beforeToolCall",
        tool: "file.writeText",
        action: { kind: "deny", reason: "writes are frozen" },
      }),
    ]);
    const decision = registry.evaluate({ phase: "beforeToolCall", toolName: "file.writeText" });
    expect(decision.decision).toBe("deny");
    expect(decision.reasons).toEqual(["writing files needs a human", "writes are frozen"]);
  });

  it("never downgrades a deny to a requirement, whatever the declaration order", () => {
    const registry = createHookRegistry([
      hook({
        id: "deny-writes",
        phase: "beforeToolCall",
        tool: "file.writeText",
        action: { kind: "deny", reason: "writes are frozen" },
      }),
      requireApprovalForWrites,
    ]);
    expect(registry.evaluate({ phase: "beforeToolCall", toolName: "file.writeText" }).decision).toBe("deny");
  });

  it("collects annotations and notices per phase", () => {
    const registry = createHookRegistry([annotateSearch, notifyFailure]);
    const after = registry.evaluate({ phase: "afterToolCall", toolName: "code.searchRepository" });
    expect(after.decision).toBe("allow");
    expect(after.annotations).toEqual([{ field: "reviewed", value: "true" }]);

    const failed = registry.evaluate({ phase: "onTaskFail" });
    expect(failed.notices).toEqual(["a task failed; check the diagnostics bundle"]);
  });

  it("skips disabled hooks", () => {
    const registry = createHookRegistry([{ ...denyShell, enabled: false }]);
    expect(registry.evaluate({ phase: "beforeToolCall", toolName: "shell.runReadOnlyCommand" }).decision)
      .toBe("allow");
  });

  it("applies hooks in declaration order", () => {
    const registry = createHookRegistry([
      hook({ id: "first", phase: "onTaskFail", action: { kind: "notify", message: "1" } }),
      hook({ id: "second", phase: "onTaskFail", action: { kind: "notify", message: "2" } }),
    ]);
    const decision = registry.evaluate({ phase: "onTaskFail" });
    expect(decision.appliedHookIds).toEqual(["first", "second"]);
    expect(decision.notices).toEqual(["1", "2"]);
  });

  it("lists and replaces its declarations", () => {
    const registry = createHookRegistry([denyShell]);
    expect(registry.list().map((item) => item.id)).toEqual(["deny-shell"]);
    registry.reset([notifyFailure]);
    expect(registry.list().map((item) => item.id)).toEqual(["notify-failure"]);
    // The caller's array must not become shared mutable state.
    const source = [denyShell];
    const other = createHookRegistry(source);
    source.push(notifyFailure);
    expect(other.list()).toHaveLength(1);
  });
});

describe("validateHookDeclarations", () => {
  it("accepts a clean declaration list", () => {
    expect(validateHookDeclarations([denyShell, annotateSearch])).toEqual([]);
  });

  it("warns about duplicate ids and rejects unsupported action kinds", () => {
    const diagnostics = validateHookDeclarations([
      denyShell,
      { ...denyShell },
      hook({
        id: "code-hook",
        phase: "onTaskFail",
        // Deliberately unsupported: code hooks are not a config feature.
        action: { kind: "exec" } as unknown as JavisHookDeclaration["action"],
      }),
    ]);
    expect(diagnostics.map((d) => d.severity)).toEqual(["warning", "error"]);
    expect(diagnostics[0].message).toContain("duplicate hook id");
  });
});

describe("process-wide hook registry", () => {
  it("is empty until configured and resettable", () => {
    expect(listConfiguredHooks()).toEqual([]);
    expect(evaluateHooks({ phase: "beforeToolCall", toolName: "x" }).decision).toBe("allow");

    configureHooks([denyShell]);
    expect(listConfiguredHooks().map((item) => item.id)).toEqual(["deny-shell"]);
    expect(evaluateHooks({ phase: "beforeToolCall", toolName: "shell.runReadOnlyCommand" }).decision)
      .toBe("deny");

    resetHooks();
    expect(listConfiguredHooks()).toEqual([]);
  });
});
