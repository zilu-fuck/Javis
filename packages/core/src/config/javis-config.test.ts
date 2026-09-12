import { describe, expect, it } from "vitest";
import {
  CONFIG_SCOPE_PRECEDENCE,
  JAVIS_CONFIG_VERSION,
  parseJavisConfigDocument,
  resolveJavisConfig,
  type JavisConfigLayer,
} from "./javis-config";

function layer(scope: JavisConfigLayer["scope"], document: unknown, path?: string): JavisConfigLayer {
  return {
    scope,
    ...(path ? { path } : {}),
    document: document as JavisConfigLayer["document"],
  };
}

describe("parseJavisConfigDocument", () => {
  it("accepts a minimal document and defaults the version", () => {
    const result = parseJavisConfigDocument("{}", "config.json");
    expect(result.diagnostics).toEqual([]);
    expect(result.document?.version).toBe(JAVIS_CONFIG_VERSION);
  });

  it("reports invalid JSON and non-object documents as errors", () => {
    expect(parseJavisConfigDocument("{ nope", "config.json").diagnostics[0]).toMatchObject({
      severity: "error",
      path: "config.json",
    });
    expect(parseJavisConfigDocument("[1,2]", "config.json").diagnostics[0].message)
      .toContain("must contain a JSON object");
    expect(parseJavisConfigDocument("null", "config.json").document).toBeUndefined();
  });

  it("warns about a future version but still parses the known fields", () => {
    const result = parseJavisConfigDocument(
      JSON.stringify({ version: 99, hooks: [{ id: "h", phase: "beforeToolCall", action: { kind: "deny", reason: "no" } }] }),
      "config.json",
    );
    expect(result.diagnostics[0]).toMatchObject({ severity: "warning", path: "config.json.version" });
    expect(result.document?.hooks).toHaveLength(1);
  });

  it("rejects an unsupported hook action instead of accepting code hooks", () => {
    const result = parseJavisConfigDocument(
      JSON.stringify({ hooks: [{ id: "h", phase: "beforeToolCall", action: { kind: "exec", command: "curl evil" } }] }),
      "config.json",
    );
    expect(result.document?.hooks).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ severity: "error", path: "config.json.hooks[0].action.kind" });
    expect(result.diagnostics[0].message).toContain("unsupported hook action");
  });

  it("requires the fields each hook action needs", () => {
    const result = parseJavisConfigDocument(
      JSON.stringify({
        hooks: [
          { id: "deny", phase: "beforeToolCall", action: { kind: "deny" } },
          { id: "annotate", phase: "afterToolCall", action: { kind: "annotate", field: "x" } },
          { id: "notify", phase: "onTaskFail", action: { kind: "notify" } },
        ],
      }),
      "config.json",
    );
    expect(result.document?.hooks).toEqual([]);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics.map((d) => d.path)).toEqual([
      "config.json.hooks[0].action.reason",
      "config.json.hooks[1].action",
      "config.json.hooks[2].action.message",
    ]);
  });

  it("rejects an unknown hook phase", () => {
    const result = parseJavisConfigDocument(
      JSON.stringify({ hooks: [{ id: "h", phase: "onEverything", action: { kind: "notify", message: "x" } }] }),
      "config.json",
    );
    expect(result.document?.hooks).toEqual([]);
    expect(result.diagnostics[0].message).toContain("hook phase must be one of");
  });

  it("keeps valid entries when a sibling is invalid", () => {
    const result = parseJavisConfigDocument(
      JSON.stringify({
        agents: [{ kind: "code" }, { displayName: "no kind" }],
      }),
      "config.json",
    );
    expect(result.document?.agents).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("rejects a non-array declaration section", () => {
    const result = parseJavisConfigDocument(JSON.stringify({ hooks: {} }), "config.json");
    expect(result.document?.hooks).toBeUndefined();
    expect(result.diagnostics[0].message).toContain("must be an array");
  });

  it("normalizes optional agent fields and drops mistyped ones", () => {
    const result = parseJavisConfigDocument(
      JSON.stringify({
        agents: [{
          kind: "code",
          modelSlot: "primary",
          maxIterations: 4,
          allowedToolNames: ["code.searchRepository"],
          additionalToolNames: "not-an-array",
          systemPrompt: { zhCN: "你是代码代理" },
        }],
      }),
      "config.json",
    );
    expect(result.document?.agents?.[0]).toEqual({
      kind: "code",
      modelSlot: "primary",
      maxIterations: 4,
      allowedToolNames: ["code.searchRepository"],
      systemPrompt: { zhCN: "你是代码代理" },
    });
  });
});

describe("resolveJavisConfig", () => {
  const builtin = layer("builtin", {
    hooks: [
      { id: "block-secrets", phase: "beforeToolCall", action: { kind: "deny", reason: "builtin" } },
      { id: "notify-fail", phase: "onTaskFail", action: { kind: "notify", message: "builtin notice" } },
    ],
  });
  const user = layer("user", {
    hooks: [
      { id: "block-secrets", phase: "beforeToolCall", action: { kind: "requireApproval", reason: "user override" } },
    ],
  });
  const project = layer("project", {
    hooks: [{ id: "notify-fail", phase: "onTaskFail", action: { kind: "notify", message: "project notice" } }],
  });

  it("applies later scopes over earlier ones by id", () => {
    const resolved = resolveJavisConfig([builtin, user, project]);
    const blockSecrets = resolved.hooks.find((hook) => hook.id === "block-secrets");
    expect(blockSecrets?.action).toEqual({ kind: "requireApproval", reason: "user override" });
    expect(resolved.hooks.find((hook) => hook.id === "notify-fail")?.action)
      .toEqual({ kind: "notify", message: "project notice" });
  });

  it("is independent of the order layers are supplied in", () => {
    const forwards = resolveJavisConfig([builtin, user, project]);
    const backwards = resolveJavisConfig([project, user, builtin]);
    expect(backwards.hooks.map((hook) => hook.id).sort()).toEqual(forwards.hooks.map((hook) => hook.id).sort());
    expect(backwards.origins).toEqual(forwards.origins);
  });

  it("records which scope supplied each declaration", () => {
    const resolved = resolveJavisConfig([builtin, project]);
    expect(resolved.origins["hook:block-secrets"]).toBe("builtin");
    expect(resolved.origins["hook:notify-fail"]).toBe("project");
  });

  it("lets a higher scope remove an inherited declaration with enabled:false", () => {
    const resolved = resolveJavisConfig([
      builtin,
      layer("project", { hooks: [{ id: "block-secrets", phase: "beforeToolCall", enabled: false, action: { kind: "deny", reason: "x" } }] }),
    ]);
    expect(resolved.hooks.map((hook) => hook.id)).toEqual(["notify-fail"]);
  });

  it("lets a higher scope disable an inherited tool and skill", () => {
    const resolved = resolveJavisConfig([
      layer("builtin", {
        tools: [{ name: "shell.runReadOnlyCommand", permissionLevel: "read" }],
        skills: [{ id: "kb", path: "skills/kb" }, { id: "other", path: "skills/other" }],
      }),
      layer("project", {
        tools: [{ name: "shell.runReadOnlyCommand", disabled: true }],
        skills: [{ id: "kb", path: "skills/kb", enabled: false }],
      }),
    ]);
    expect(resolved.tools).toEqual([]);
    expect(resolved.skills.map((skill) => skill.id)).toEqual(["other"]);
  });

  it("merges tool declarations field by field", () => {
    const resolved = resolveJavisConfig([
      layer("builtin", { tools: [{ name: "t", permissionLevel: "read", capabilityTags: ["a"] }] }),
      layer("project", { tools: [{ name: "t", permissionLevel: "confirmed_write" }] }),
    ]);
    expect(resolved.tools).toEqual([{
      name: "t",
      permissionLevel: "confirmed_write",
      capabilityTags: ["a"],
    }]);
  });

  it("carries parse diagnostics from every layer into the result", () => {
    const resolved = resolveJavisConfig([
      layer("builtin", {}),
      { ...layer("project", {}), diagnostics: [{ severity: "warning", path: "p", message: "m" }] },
    ]);
    expect(resolved.diagnostics).toEqual([{ severity: "warning", path: "p", message: "m" }]);
  });

  it("returns empty collections for no layers", () => {
    const resolved = resolveJavisConfig([]);
    expect(resolved).toMatchObject({ agents: [], hooks: [], tools: [], skills: [], plugins: [] });
    expect(resolved.origins).toEqual({});
  });

  it("documents its precedence order", () => {
    expect(CONFIG_SCOPE_PRECEDENCE).toEqual(["builtin", "user", "project"]);
  });
});
