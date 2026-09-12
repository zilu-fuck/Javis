import { describe, expect, it } from "vitest";
import { demoAgents, createDefaultAgentRegistry } from "../agents";
import type { Agent } from "../index";
import type { JavisAgentDeclaration } from "./javis-config";
import { applyAgentDeclarations, mergeAgentRuntimeOverrides } from "./agent-declarations";

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-code",
    kind: "code",
    displayName: "Code Agent",
    description: "Code reading and proposals",
    allowedToolNames: ["code.searchRepository", "code.inspectRepository"],
    systemPrompt: { en: "You are the Code Agent.", zhCN: "你是代码代理。" },
    ...overrides,
  };
}

const declaration = (overrides: Partial<JavisAgentDeclaration> & { kind: string }): JavisAgentDeclaration => overrides;

describe("applyAgentDeclarations", () => {
  it("returns the builtin cast untouched with no declarations", () => {
    const result = applyAgentDeclarations([baseAgent()], []);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].allowedToolNames).toEqual(["code.searchRepository", "code.inspectRepository"]);
    expect(result.overriddenKinds).toEqual([]);
    expect(result.createdKinds).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not mutate the base agents", () => {
    const base = [baseAgent()];
    applyAgentDeclarations(base, [declaration({ kind: "code", additionalToolNames: ["git.createCommit"] })]);
    expect(base[0].allowedToolNames).toEqual(["code.searchRepository", "code.inspectRepository"]);
  });

  it("replaces the allowlist when allowedToolNames is given", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({ kind: "code", allowedToolNames: ["code.searchRepository"] }),
    ]);
    expect(result.agents[0].allowedToolNames).toEqual(["code.searchRepository"]);
  });

  it("narrowing does not silently re-add builtins through additionalToolNames", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({
        kind: "code",
        allowedToolNames: ["code.searchRepository"],
        additionalToolNames: ["code.traceCallChain"],
      }),
    ]);
    expect(result.agents[0].allowedToolNames).toEqual(["code.searchRepository", "code.traceCallChain"]);
  });

  it("appends additional tools without duplicating existing ones", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({
        kind: "code",
        additionalToolNames: ["code.inspectRepository", "git.stageFiles", "  git.stageFiles  "],
      }),
    ]);
    expect(result.agents[0].allowedToolNames).toEqual([
      "code.searchRepository",
      "code.inspectRepository",
      "git.stageFiles",
    ]);
  });

  it("overlays prompts per language and keeps the other language", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({ kind: "code", systemPrompt: { zhCN: "你是安全评审员。" } }),
    ]);
    expect(result.agents[0].systemPrompt).toEqual({
      en: "You are the Code Agent.",
      zhCN: "你是安全评审员。",
    });
  });

  it("overrides display metadata", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({ kind: "code", displayName: "代码官", description: "只看代码" }),
    ]);
    expect(result.agents[0].displayName).toBe("代码官");
    expect(result.agents[0].description).toBe("只看代码");
    expect(result.overriddenKinds).toEqual(["code"]);
  });

  it("matches kinds case-insensitively and trims them", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({ kind: "  CODE  ", displayName: "Coder" }),
    ]);
    expect(result.overriddenKinds).toEqual(["  CODE  "]);
    expect(result.agents[0].displayName).toBe("Coder");
  });

  it("creates a new agent kind when it supplies a persona", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({
        kind: "db-reviewer",
        displayName: "DB Reviewer",
        allowedToolNames: ["code.searchRepository"],
        systemPrompt: { en: "You review migrations.", zhCN: "你审查迁移。" },
      }),
    ]);
    expect(result.createdKinds).toEqual(["db-reviewer"]);
    const created = result.agents.find((agent) => (agent.kind as string) === "db-reviewer");
    expect(created).toMatchObject({
      id: "agent-db-reviewer",
      displayName: "DB Reviewer",
      allowedToolNames: ["code.searchRepository"],
    });
    expect(created?.systemPrompt.zhCN).toBe("你审查迁移。");
  });

  it("refuses to create an agent kind without a persona", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({ kind: "mystery", allowedToolNames: ["code.searchRepository"] }),
    ]);
    expect(result.createdKinds).toEqual([]);
    expect(result.agents.map((agent) => agent.kind)).toEqual(["code"]);
    expect(result.diagnostics[0]).toMatchObject({ severity: "error", path: "agents[0].systemPrompt" });
  });

  it("rejects an empty kind and keeps processing the rest", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({ kind: "   " }),
      declaration({ kind: "code", displayName: "Still Applied" }),
    ]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.agents[0].displayName).toBe("Still Applied");
  });

  it("collects runtime-only knobs separately from the agent contract", () => {
    const result = applyAgentDeclarations([baseAgent()], [
      declaration({ kind: "code", modelSlot: "secondary", maxIterations: 3 }),
    ]);
    expect(result.runtimeOverrides).toEqual({ code: { modelSlot: "secondary", maxIterations: 3 } });
    // The Agent contract itself has no such fields.
    expect(Object.keys(result.agents[0])).not.toContain("modelSlot");
  });

  it("reports the agents a caller must register", () => {
    const result = applyAgentDeclarations(demoAgents, [
      declaration({ kind: "commander", displayName: "指挥官" }),
      declaration({ kind: "db-reviewer", systemPrompt: { en: "You review migrations." } }),
    ]);
    // Only the touched agents, so a caller never re-registers the whole cast.
    expect(result.changedAgents.map((agent) => agent.kind).sort()).toEqual(["commander", "db-reviewer"]);
    expect(result.changedAgents).toHaveLength(
      result.overriddenKinds.length + result.createdKinds.length,
    );
  });

  it("applies to the real builtin cast", () => {
    const result = applyAgentDeclarations(demoAgents, [
      declaration({ kind: "commander", additionalToolNames: ["memory.search", "custom.tool"] }),
    ]);
    expect(result.diagnostics).toEqual([]);
    const commander = result.agents.find((agent) => agent.kind === "commander");
    expect(commander?.allowedToolNames).toContain("custom.tool");
    expect(commander?.allowedToolNames.filter((name) => name === "memory.search")).toHaveLength(1);
    // Every builtin agent survives an unrelated declaration.
    expect(result.agents).toHaveLength(demoAgents.length);
  });
});

describe("registering declared agents into a live registry", () => {
  it("updates an existing agent's allowlist in place", () => {
    const registry = createDefaultAgentRegistry();
    const applied = applyAgentDeclarations(demoAgents, [
      declaration({ kind: "code", additionalToolNames: ["custom.declaredTool"] }),
    ]);
    for (const agent of applied.changedAgents) {
      registry.register(agent, { allowKindReplacement: true });
    }
    expect(registry.findByKind("code")?.agent.allowedToolNames).toContain("custom.declaredTool");
    // Agents nobody declared are untouched.
    const commander = registry.findByKind("commander");
    expect(commander?.agent.allowedToolNames).not.toContain("custom.declaredTool");
  });

  it("adds a declared new kind and leaves undeclared kinds absent", () => {
    const registry = createDefaultAgentRegistry();
    expect(registry.findByKind("db-reviewer")).toBeUndefined();

    const applied = applyAgentDeclarations(demoAgents, [
      declaration({
        kind: "db-reviewer",
        allowedToolNames: ["code.searchRepository"],
        systemPrompt: { en: "You review migrations." },
      }),
    ]);
    for (const agent of applied.changedAgents) {
      registry.register(agent, { allowKindReplacement: true });
    }
    expect(registry.findByKind("db-reviewer")?.agent.displayName).toBe("db-reviewer");
  });

  it("does not disturb the cast when nothing is declared", () => {
    const registry = createDefaultAgentRegistry();
    const before = registry.list().map((entry) => entry.agent.kind).sort();
    const applied = applyAgentDeclarations(demoAgents, []);
    for (const agent of applied.changedAgents) {
      registry.register(agent, { allowKindReplacement: true });
    }
    expect(registry.list().map((entry) => entry.agent.kind).sort()).toEqual(before);
  });
});

describe("mergeAgentRuntimeOverrides", () => {
  it("merges sources with later ones winning per field", () => {
    const merged = mergeAgentRuntimeOverrides(
      { code: { maxIterations: 2, modelSlot: "primary" } },
      undefined,
      { CODE: { maxIterations: 5 } },
    );
    expect(merged).toEqual({ code: { maxIterations: 5, modelSlot: "primary" } });
  });

  it("returns an empty object with no sources", () => {
    expect(mergeAgentRuntimeOverrides()).toEqual({});
  });
});
