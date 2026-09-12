import { describe, expect, it } from "vitest";
import type { AgentKind } from "./index";
import { demoAgents, normalizeAgentKind } from "./agents";

/**
 * Vocabulary contract (E8).
 *
 * Two renames leaked into call sites — `browser` → `page-agent` and
 * `chinese-reviewer` → `language-reviewer` — and an un-normalized kind silently
 * falls back to the primary model profile instead of the agent's configured one.
 * These tests pin the canonical set and the alias table so the next rename cannot
 * drift unnoticed.
 */
describe("agent kind vocabulary", () => {
  it("normalizes every legacy alias onto its canonical kind", () => {
    expect(normalizeAgentKind("browser")).toBe("page-agent");
    expect(normalizeAgentKind("chinese-reviewer")).toBe("language-reviewer");
    expect(normalizeAgentKind("  CHINESE-REVIEWER  ")).toBe("language-reviewer");
  });

  it("leaves a canonical kind alone, including unknown ones", () => {
    for (const kind of ["commander", "code", "language-reviewer", "page-agent"]) {
      expect(normalizeAgentKind(kind)).toBe(kind);
    }
    // An unknown kind is returned as-is: silently mapping it would hide the typo.
    expect(normalizeAgentKind("not-a-real-kind")).toBe("not-a-real-kind");
  });

  it("ships exactly the declared agent kinds, with no legacy names left", () => {
    const kinds = demoAgents.map((agent) => agent.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const legacy of ["browser", "chinese-reviewer"] as const) {
      expect(kinds, `${legacy} is a legacy alias and must not be a builtin kind`).not.toContain(legacy);
    }
    // Every shipped kind is already normalized, so normalization is idempotent.
    for (const kind of kinds) {
      expect(normalizeAgentKind(kind)).toBe(kind);
    }
  });

  it("keeps the reviewer vocabulary bilingual rather than region-specific", () => {
    // `language-reviewer` reviews language quality in either language; the old
    // name implied Chinese-only, which is why the UI and prompts disagreed.
    const reviewer = demoAgents.find((agent) => agent.kind === "language-reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.systemPrompt.en.length).toBeGreaterThan(0);
    expect(reviewer?.systemPrompt.zhCN.length).toBeGreaterThan(0);
  });

  it("declares every builtin kind in the AgentKind union", () => {
    // The union is the contract other layers compile against; a kind that exists
    // only at runtime cannot be planned or routed.
    const declared: AgentKind[] = [
      "commander", "file", "shell", "browser", "page-agent", "computer", "scheduler",
      "research", "code", "language-reviewer", "security-reviewer", "build-fix",
      "test-runner", "doc-updater", "explorer", "perf-analyzer", "refactor", "verifier",
      "vision", "workspace",
    ];
    for (const agent of demoAgents) {
      expect(declared, `agent kind ${agent.kind} must be in the AgentKind union`).toContain(agent.kind);
    }
  });
});
