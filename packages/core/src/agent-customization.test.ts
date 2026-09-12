import { describe, expect, it } from "vitest";
import {
  AGENT_PROMPT_LARGE_CHARS,
  DEFAULT_AGENT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_AGENT_MAX_TURNS,
  effectivePermissionCeiling,
  previewAgentView,
  validateAgentDraft,
  type AgentDraft,
  type PreviewToolSource,
} from "./agent-customization";

const TOOLS: PreviewToolSource[] = [
  { name: "code.searchRepository", permissionLevel: "read", ownerAgentKinds: ["code"] },
  { name: "file.writeText", permissionLevel: "confirmed_write", ownerAgentKinds: ["file"] },
  { name: "shell.runWorkspaceCommand", permissionLevel: "confirmed_write", ownerAgentKinds: ["shell"] },
  { name: "computer.openPath", permissionLevel: "dangerous", ownerAgentKinds: ["computer"] },
];

function draft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    kind: "release-checker",
    persona: { en: "You check releases.", zhCN: "你负责检查发布。" },
    ...overrides,
  };
}

describe("effectivePermissionCeiling", () => {
  it("clamps to the host ceiling", () => {
    // The invariant: an agent may lower its reach, never raise it past the host's.
    expect(effectivePermissionCeiling({ permissionCeiling: "preview" }, "confirmed_write")).toBe("preview");
    expect(effectivePermissionCeiling({ permissionCeiling: "dangerous" }, "confirmed_write")).toBe("confirmed_write");
    expect(effectivePermissionCeiling({}, "preview")).toBe("preview");
  });
});

describe("validateAgentDraft", () => {
  it("accepts a complete draft", () => {
    expect(validateAgentDraft(draft())).toEqual([]);
  });

  it("requires a kebab-case kind and at least one language", () => {
    expect(validateAgentDraft(draft({ kind: "Release Checker" }))[0].path).toBe("kind");
    expect(validateAgentDraft({ kind: "ok" })[0].message).toContain("at least one language");
  });

  it("warns when only one language is written", () => {
    const diagnostics = validateAgentDraft(draft({ persona: { en: "Only English." } }));
    expect(diagnostics[0]).toMatchObject({ severity: "warning", path: "persona" });
    expect(diagnostics[0].message).toContain("falls back");
  });

  it("warns when a tool is both allowed and denied, and duplicates", () => {
    const both = validateAgentDraft(draft({
      toolAllowlist: ["file.writeText"],
      toolDenylist: ["file.writeText"],
    }));
    expect(both[0].message).toContain("the denylist wins");

    const dupes = validateAgentDraft(draft({ toolAllowlist: ["a.b", "a.b"] }));
    expect(dupes[0].message).toContain("repeats a tool name");
  });

  it("rejects a non-positive budget or turn count", () => {
    expect(validateAgentDraft(draft({ contextBudgetTokens: 0 }))[0].path).toBe("contextBudgetTokens");
    expect(validateAgentDraft(draft({ maxTurns: -1 }))[0].path).toBe("maxTurns");
    expect(validateAgentDraft(draft({ maxTurns: 2.5 }))[0].path).toBe("maxTurns");
  });
});

describe("previewAgentView", () => {
  it("shows every tool when no allowlist is declared", () => {
    const preview = previewAgentView(draft(), { tools: TOOLS, hostPermissionCeiling: "dangerous" });
    expect(preview.availableTools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(preview.withheldTools).toEqual([]);
  });

  it("treats an explicit empty allowlist as no tools, not as no restriction", () => {
    // The distinction matters: `[]` is a deliberate lockdown, `undefined` is "all".
    const preview = previewAgentView(draft({ toolAllowlist: [] }), {
      tools: TOOLS,
      hostPermissionCeiling: "dangerous",
    });
    expect(preview.availableTools).toEqual([]);
    expect(preview.withheldTools).toHaveLength(TOOLS.length);
    expect(preview.diagnostics.some((diagnostic) => diagnostic.message.includes("no usable tools"))).toBe(true);
  });

  it("lets the denylist win over the allowlist", () => {
    const preview = previewAgentView(
      draft({ toolAllowlist: ["file.writeText"], toolDenylist: ["file.writeText"] }),
      { tools: TOOLS, hostPermissionCeiling: "dangerous" },
    );
    expect(preview.availableTools).toEqual([]);
    // Look the tool up by name: `withheldTools` follows registry order, so index 0 is a
    // different tool that is merely absent from the allowlist.
    const denied = preview.withheldTools.find((tool) => tool.name === "file.writeText");
    expect(denied?.reason).toContain("denylist");
  });

  it("withholds a tool above the effective ceiling and names both levels", () => {
    const preview = previewAgentView(
      draft({ permissionCeiling: "preview" }),
      { tools: TOOLS, hostPermissionCeiling: "dangerous" },
    );
    expect(preview.availableTools.map((tool) => tool.name)).toEqual(["code.searchRepository"]);
    const write = preview.withheldTools.find((tool) => tool.name === "file.writeText");
    expect(write?.reason).toContain("confirmed_write");
    expect(write?.reason).toContain("ceiling of preview");
  });

  it("never previews more privilege than the host grants, and says so", () => {
    const preview = previewAgentView(
      draft({ permissionCeiling: "dangerous" }),
      { tools: TOOLS, hostPermissionCeiling: "confirmed_write" },
    );
    expect(preview.effectivePermissionCeiling).toBe("confirmed_write");
    expect(preview.availableTools.map((tool) => tool.name)).not.toContain("computer.openPath");
    expect(preview.diagnostics.some((diagnostic) => diagnostic.message.includes("host limit applies"))).toBe(true);
  });

  it("warns about an allowlist entry that does not exist in this build", () => {
    const preview = previewAgentView(
      draft({ toolAllowlist: ["code.searchRepository", "ghost.tool"] }),
      { tools: TOOLS, hostPermissionCeiling: "dangerous" },
    );
    const diagnostic = preview.diagnostics.find((entry) => entry.message.includes("ghost.tool"));
    expect(diagnostic?.message).toContain("not a tool in this build");
    // It is still not silently counted as available.
    expect(preview.availableTools.map((tool) => tool.name)).toEqual(["code.searchRepository"]);
  });

  it("assembles a prompt preview that states the effective limits", () => {
    const preview = previewAgentView(
      draft({ contextBudgetTokens: 32_000, maxTurns: 5 }),
      { tools: TOOLS, hostPermissionCeiling: "confirmed_write" },
    );
    expect(preview.promptPreview).toContain("You check releases.");
    // Two confirmed_write tools plus one read tool survive a confirmed_write ceiling;
    // only the dangerous one is withheld.
    expect(preview.availableTools).toHaveLength(3);
    expect(preview.promptPreview).toContain("Available tools (3)");
    expect(preview.promptPreview).toContain("context budget: 32,000 tokens");
    expect(preview.promptPreview).toContain("max turns: 5");
    expect(preview.promptChars).toBe(preview.promptPreview.length);
  });

  it("renders the preview in Chinese and prefers the Chinese persona", () => {
    const preview = previewAgentView(draft(), {
      tools: TOOLS,
      hostPermissionCeiling: "dangerous",
      locale: "zhCN",
    });
    expect(preview.promptPreview).toContain("你负责检查发布。");
    expect(preview.promptPreview).toContain("权限上限");
  });

  it("falls back to the other language rather than an empty prompt", () => {
    const preview = previewAgentView(draft({ persona: { en: "English only." } }), {
      tools: [],
      hostPermissionCeiling: "read",
      locale: "zhCN",
    });
    expect(preview.promptPreview).toContain("English only.");
  });

  it("flags a prompt that has grown too large to repeat every turn", () => {
    const preview = previewAgentView(
      draft({ persona: { en: "x".repeat(AGENT_PROMPT_LARGE_CHARS + 100), zhCN: "y" } }),
      { tools: TOOLS, hostPermissionCeiling: "read" },
    );
    expect(preview.diagnostics.some((diagnostic) => diagnostic.message.includes("large"))).toBe(true);
  });

  it("applies the documented defaults", () => {
    const preview = previewAgentView(draft(), { tools: [], hostPermissionCeiling: "read" });
    expect(preview.contextBudgetTokens).toBe(DEFAULT_AGENT_CONTEXT_BUDGET_TOKENS);
    expect(preview.maxTurns).toBe(DEFAULT_AGENT_MAX_TURNS);
  });

  it("accounts for every tool exactly once", () => {
    for (const overrides of [
      {},
      { toolAllowlist: ["code.searchRepository"] },
      { toolAllowlist: [] },
      { toolDenylist: ["file.writeText"] },
      { permissionCeiling: "read" as const },
    ]) {
      const preview = previewAgentView(draft(overrides), {
        tools: TOOLS,
        hostPermissionCeiling: "confirmed_write",
      });
      const accounted = [...preview.availableTools.map((tool) => tool.name), ...preview.withheldTools.map((tool) => tool.name)]
        .sort();
      expect(accounted).toEqual(TOOLS.map((tool) => tool.name).sort());
    }
  });
});
