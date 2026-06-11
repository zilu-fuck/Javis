import { describe, expect, it } from "vitest";
import type { AgentSessionSummary } from "./agent-memory";
import { extractAgentMemoryFactsFromSummary } from "./agent-memory-pipeline";

describe("agent memory pipeline", () => {
  it("extracts scoped long-term facts from session summaries", () => {
    const facts = extractAgentMemoryFactsFromSummary(createSummary({
      importantPoints: [
        "User goal: 用户要求 Javis 记忆第一版本地优先，不使用向量模型",
        "Verification: memory.search 通过统一 executor 调用",
      ],
    }));

    expect(facts).toEqual([
      expect.objectContaining({
        fact: "用户要求 Javis 记忆第一版本地优先，不使用向量模型",
        kind: "technical_constraint",
        scopeType: "workspace",
        scopeId: "workspace:abc",
        sourceSessionId: "task-1",
        sourceMessageIds: [],
        status: "active",
      }),
      expect.objectContaining({
        fact: "memory.search 通过统一 executor 调用",
        kind: "workflow",
      }),
    ]);
    expect(facts[0]?.tags).toEqual(expect.arrayContaining(["memory", "local-first", "no-vector"]));
    expect(facts[0]?.importance).toBe(5);
  });

  it("dedupes facts with stable ids", () => {
    const summary = createSummary({
      importantPoints: [
        "User goal: Javis memory uses SQLite",
        "Javis memory uses SQLite",
      ],
      summary: "User asked: Javis memory uses SQLite\nFinal response: Done.",
    });

    const first = extractAgentMemoryFactsFromSummary(summary);
    const second = extractAgentMemoryFactsFromSummary(summary);

    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("does not turn open threads or leaked tool output into facts", () => {
    const facts = extractAgentMemoryFactsFromSummary(createSummary({
      importantPoints: [
        "User goal: SECRET_TOOL_OUTPUT",
        "Verification: verified: tests passed",
      ],
      openThreads: ["Error to revisit: FULL_MIGRATION_LOG"],
      summary: "User asked: SECRET_COMMAND_STDOUT\nFinal response: Done.",
    }));

    expect(JSON.stringify(facts)).not.toContain("SECRET_TOOL_OUTPUT");
    expect(JSON.stringify(facts)).not.toContain("SECRET_COMMAND_STDOUT");
    expect(JSON.stringify(facts)).not.toContain("FULL_MIGRATION_LOG");
  });

  it("uses global scope when the summary has no workspace", () => {
    const facts = extractAgentMemoryFactsFromSummary(createSummary({
      workspaceId: undefined,
      importantPoints: ["User goal: User prefers local Agent memory"],
    }));

    expect(facts[0]).toEqual(expect.objectContaining({
      scopeType: "global",
      scopeId: undefined,
    }));
  });
});

function createSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: "summary:task-1",
    sessionId: "task-1",
    workspaceId: "workspace:abc",
    summary: "User asked: 用户要求 Javis 记忆第一版本地优先\nFinal response: Done.",
    importantPoints: [],
    openThreads: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}
