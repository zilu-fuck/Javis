import { describe, expect, it } from "vitest";
import {
  PLUGIN_MANIFEST_VERSION,
  isPluginCapability,
  parsePluginManifest,
  planPluginInstall,
  type JavisPluginManifest,
} from "./plugin-manifest";

function manifest(overrides: Partial<JavisPluginManifest> = {}): JavisPluginManifest {
  return {
    id: "acme-tools",
    name: "Acme Tools",
    version: "1.0.0",
    requestedCapabilities: ["read_tools"],
    ...overrides,
  };
}

describe("parsePluginManifest", () => {
  it("accepts a minimal manifest", () => {
    const parsed = parsePluginManifest(JSON.stringify({
      id: "acme-tools",
      name: "Acme Tools",
      version: "1.0.0",
      capabilities: ["read_tools"],
    }));
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest?.requestedCapabilities).toEqual(["read_tools"]);
    expect(PLUGIN_MANIFEST_VERSION).toBe(1);
  });

  it("requires a kebab-case id, a name and a semver version", () => {
    const bad = parsePluginManifest(JSON.stringify({ id: "Acme_Tools", name: "", version: "v1" }));
    expect(bad.manifest).toBeUndefined();
    expect(bad.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "plugin.json.id",
      "plugin.json.name",
      "plugin.json.version",
    ]);
  });

  it("rejects unknown capabilities instead of ignoring them", () => {
    const parsed = parsePluginManifest(JSON.stringify({
      id: "acme-tools",
      name: "Acme",
      version: "1.0.0",
      capabilities: ["read_tools", "root_access"],
    }));
    expect(parsed.manifest).toBeUndefined();
    expect(parsed.diagnostics[0].message).toContain('unknown capability "root_access"');
  });

  it("reports invalid JSON and non-object manifests", () => {
    expect(parsePluginManifest("{oops").diagnostics[0].severity).toBe("error");
    expect(parsePluginManifest("[]").diagnostics[0].message).toContain("must contain a JSON object");
  });

  it("recognizes only declared capabilities", () => {
    expect(isPluginCapability("read_tools")).toBe(true);
    expect(isPluginCapability("root_access")).toBe(false);
    expect(isPluginCapability(7)).toBe(false);
  });
});

describe("planPluginInstall", () => {
  it("grants ordinary capabilities", () => {
    const plan = planPluginInstall(manifest({ requestedCapabilities: ["read_tools", "preview_tools", "network_access"] }));
    expect(plan.granted).toEqual(["read_tools", "preview_tools", "network_access"]);
    expect(plan.refused).toEqual([]);
    expect(plan.requiresApproval).toBe(true);
  });

  it("refuses process spawn and direct filesystem writes with a reason", () => {
    const plan = planPluginInstall(manifest({
      requestedCapabilities: ["read_tools", "process_spawn", "filesystem_write"],
    }));
    expect(plan.granted).toEqual(["read_tools"]);
    expect(plan.refused.map((entry) => entry.capability)).toEqual(["process_spawn", "filesystem_write"]);
    expect(plan.refused[0].reason).toContain("may not spawn processes");
  });

  it("grants confirmed_write only with a warning that approval still applies", () => {
    const plan = planPluginInstall(manifest({ requestedCapabilities: ["confirmed_write_tools"] }));
    expect(plan.granted).toEqual(["confirmed_write_tools"]);
    expect(plan.diagnostics[0]).toMatchObject({ severity: "warning" });
    expect(plan.diagnostics[0].message).toContain("native user approval");
  });

  it("refuses to let a plugin shadow a builtin tool or agent kind", () => {
    const plan = planPluginInstall(
      manifest({
        agents: [{ kind: "commander" }, { kind: "acme-reviewer" }],
        tools: [{ name: "file.writeText" }, { name: "acme.runReport", permissionLevel: "read" }],
      }),
      { builtinAgentKinds: ["commander", "code"], builtinToolNames: ["file.writeText"] },
    );
    expect(plan.contributions.agents.map((agent) => agent.kind)).toEqual(["acme-reviewer"]);
    expect(plan.contributions.tools.map((tool) => tool.name)).toEqual(["acme.runReport"]);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["error", "error"]);
    expect(plan.diagnostics[0].message).toContain("redefine builtin agent kind");
    expect(plan.diagnostics[1].message).toContain("shadow builtin tool");
  });

  it("refuses a plugin tool that asks for dangerous permission", () => {
    const plan = planPluginInstall(manifest({
      tools: [{ name: "acme.wipe", permissionLevel: "dangerous" }],
    }));
    expect(plan.contributions.tools).toEqual([]);
    expect(plan.diagnostics[0].message).toContain('refusing "dangerous" permission');
  });

  it("keeps declarative hooks and refuses code-shaped ones", () => {
    const plan = planPluginInstall(manifest({
      hooks: [
        { id: "ok", phase: "beforeToolCall", action: { kind: "deny", reason: "policy" } },
        { id: "code", phase: "onTaskFail", action: { kind: "exec" } as never },
      ],
    }));
    expect(plan.contributions.hooks.map((hook) => hook.id)).toEqual(["ok"]);
    expect(plan.diagnostics[0].message).toContain("unsupported hook action");
  });

  it("always requires approval, whatever was granted", () => {
    for (const capabilities of [[], ["read_tools"], ["process_spawn"]] as const) {
      const plan = planPluginInstall(manifest({ requestedCapabilities: [...capabilities] }));
      expect(plan.requiresApproval).toBe(true);
    }
  });
});
