import { describe, expect, it, vi } from "vitest";
import {
  buildJavisConfigLayers,
  loadJavisConfig,
  type JavisConfigFilePayload,
} from "./javis-config-loader";

const userConfig = JSON.stringify({
  hooks: [{ id: "shared", phase: "beforeToolCall", action: { kind: "notify", message: "from user" } }],
});

const projectConfig = JSON.stringify({
  hooks: [{ id: "shared", phase: "beforeToolCall", action: { kind: "deny", reason: "from project" } }],
  agents: [{ kind: "code", displayName: "Project Code Agent" }],
});

describe("buildJavisConfigLayers", () => {
  it("returns nothing for an empty payload", () => {
    expect(buildJavisConfigLayers(null)).toEqual({ layers: [], diagnostics: [] });
    expect(buildJavisConfigLayers({}).layers).toEqual([]);
  });

  it("skips blank layers and keeps order lowest-precedence first", () => {
    const payload: JavisConfigFilePayload = {
      userPath: "C:/Users/x/AppData/Roaming/javis/config.json",
      userText: "   ",
      projectPath: "E:/proj/.javis/config.json",
      projectText: projectConfig,
    };
    const { layers } = buildJavisConfigLayers(payload);
    expect(layers.map((layer) => layer.scope)).toEqual(["project"]);
  });

  it("reports a broken layer as a diagnostic and ignores it", () => {
    const { layers, diagnostics } = buildJavisConfigLayers({
      userPath: "user.json",
      userText: "{ not json",
      projectText: projectConfig,
    });
    expect(layers.map((layer) => layer.scope)).toEqual(["project"]);
    expect(diagnostics[0]).toMatchObject({ severity: "error", path: "user.json" });
  });
});

describe("loadJavisConfig", () => {
  it("passes a null workspace when none is selected", async () => {
    const invoke = vi.fn(async () => ({}));
    await loadJavisConfig(invoke, "   ");
    expect(invoke).toHaveBeenCalledWith("load_javis_config_files", { workspacePath: null });
  });

  it("merges user and project layers with the project winning", async () => {
    const invoke = vi.fn(async () => ({
      userPath: "user.json",
      userText: userConfig,
      projectPath: "proj.json",
      projectText: projectConfig,
    }));
    const loaded = await loadJavisConfig(invoke, "E:/proj");
    const shared = loaded.config.hooks.find((hook) => hook.id === "shared");
    expect(shared?.action).toEqual({ kind: "deny", reason: "from project" });
    expect(loaded.config.origins["hook:shared"]).toBe("project");
    expect(loaded.config.agents.find((agent) => agent.kind === "code")?.displayName)
      .toBe("Project Code Agent");
    expect(loaded.loadedLayers.map((layer) => layer.scope)).toEqual(["user", "project"]);
  });

  it("starts cleanly when no config exists anywhere", async () => {
    const invoke = vi.fn(async () => ({}));
    const loaded = await loadJavisConfig(invoke, "E:/empty");
    expect(loaded.config.hooks).toEqual([]);
    expect(loaded.config.agents).toEqual([]);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.loadedLayers).toEqual([]);
  });

  it("turns a native failure into a warning instead of throwing", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("Config file resolves outside the workspace root.");
    });
    const loaded = await loadJavisConfig(invoke, "E:/proj");
    expect(loaded.config.hooks).toEqual([]);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0].severity).toBe("warning");
    expect(loaded.diagnostics[0].message).toContain("outside the workspace root");
  });

  it("surfaces parse diagnostics from the loaded layers", async () => {
    const invoke = vi.fn(async () => ({
      projectPath: "proj.json",
      projectText: JSON.stringify({ hooks: [{ id: "h", phase: "bogus", action: { kind: "notify", message: "x" } }] }),
    }));
    const loaded = await loadJavisConfig(invoke, "E:/proj");
    expect(loaded.diagnostics.length).toBeGreaterThan(0);
    expect(loaded.config.hooks).toEqual([]);
  });
});
