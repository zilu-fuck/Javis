import { describe, expect, it, vi } from "vitest";
import type { TaskSnapshot } from "@javis/core";
import type { AgentMemoryFact, AgentSessionSummary, SearchMemoryInput, SearchMemoryResult } from "./agent-memory";
import {
  buildAgentMemoryPromptContextFromRepository,
  restoreAgentMemoryFromTaskHistory,
} from "./agent-memory-runtime";

describe("agent memory runtime", () => {
  it("retrieves workspace facts and recent summaries for prompt context with audit metadata", async () => {
    const repository = createPromptRepository({
      facts: [
        createSearchResult("mem-workspace", "Javis Agent memory stays local-first", "workspace"),
        createSearchResult("mem-global", "Global fact should not leak in workspace-only mode", "global"),
      ],
      summaries: [
        createSummary("summary-1", "User asked: keep memory local\nFinal response: Done."),
      ],
    });
    const recordInjection = vi.fn(async () => undefined);

    const context = await buildAgentMemoryPromptContextFromRepository({
      repository,
      userGoal: "What did we decide about memory?",
      taskId: "task-2",
      memoryScope: "workspace",
      workspaceId: "workspace:abc",
      userProfileFacts: ["User prefers concise Javis answers."],
      recordInjection,
    });

    expect(repository.searches).toEqual([
      expect.objectContaining({
        query: "What did we decide about memory?",
        scopeType: "workspace",
        scopeId: "workspace:abc",
      }),
    ]);
    expect(context).toContain("[User Profile]");
    expect(context).toContain("User prefers concise Javis answers.");
    expect(context).toContain("[Workspace Memory]");
    expect(context).toContain("Javis Agent memory stays local-first");
    expect(context).not.toContain("Global fact should not leak");
    expect(context).toContain("[Recent Session Summary]");
    expect(recordInjection).toHaveBeenCalledWith(expect.objectContaining({
      injectionType: "workspace_memory",
      memoryFactIds: ["mem-workspace"],
      query: "What did we decide about memory?",
      scopeType: "workspace",
      scopeId: "workspace:abc",
      promptSection: "Workspace Memory",
    }));
  });

  it("uses global memory when global plus workspace mode has no active workspace", async () => {
    const repository = createPromptRepository({
      facts: [createSearchResult("mem-global", "Javis memory can include global preferences", "global")],
      summaries: [createSummary("summary-global", "User asked: remember global preference")],
    });

    const context = await buildAgentMemoryPromptContextFromRepository({
      repository,
      userGoal: "previous global preference",
      taskId: "task-global",
      memoryScope: "global_workspace",
    });

    expect(repository.searches).toEqual([
      expect.objectContaining({
        scopeType: "global",
      }),
    ]);
    expect(repository.summaryRequests).toEqual([{ workspaceId: undefined, limit: 2 }]);
    expect(context).toContain("Javis memory can include global preferences");
  });

  it("injects global facts returned by workspace search in global plus workspace mode", async () => {
    const repository = createPromptRepository({
      facts: [
        createSearchResult("mem-workspace", "Workspace fact remains scoped to this project", "workspace"),
        createSearchResult("mem-global", "Global preference is still useful in this project", "global"),
      ],
      summaries: [],
    });
    const recordInjection = vi.fn(async () => undefined);

    const context = await buildAgentMemoryPromptContextFromRepository({
      repository,
      userGoal: "Use remembered project and global preferences",
      taskId: "task-global-workspace",
      memoryScope: "global_workspace",
      workspaceId: "workspace:abc",
      recordInjection,
    });

    expect(repository.searches).toEqual([
      expect.objectContaining({
        scopeType: "workspace",
        scopeId: "workspace:abc",
      }),
    ]);
    expect(context).toContain("Workspace fact remains scoped to this project");
    expect(context).toContain("Global preference is still useful in this project");
    expect(recordInjection).toHaveBeenCalledWith(expect.objectContaining({
      injectionType: "workspace_memory",
      memoryFactIds: ["mem-workspace", "mem-global"],
      scopeType: "workspace",
      scopeId: "workspace:abc",
      scoreSummary: expect.objectContaining({
        resultCount: 2,
        scopeCounts: { workspace: 1, global: 1 },
      }),
    }));
  });

  it("restores session summaries and long-term facts from restored task history", async () => {
    const savedSummaries: AgentSessionSummary[] = [];
    const savedFacts: AgentMemoryFact[] = [];
    const repository = {
      async saveSessionSummary(summary: AgentSessionSummary) {
        savedSummaries.push(summary);
        return summary;
      },
      async saveFact(fact: AgentMemoryFact) {
        savedFacts.push(fact);
        return fact;
      },
    };

    const result = await restoreAgentMemoryFromTaskHistory({
      repository,
      history: [
        createTask("task-complete", "completed", "User prefers local Agent memory"),
        createTask("task-failed", "failed", "Debug failed workflow"),
        createTask("task-running", "running", "Ignore running task"),
      ],
      workspacePath: "E:/Javis",
      enabled: true,
    });

    expect(result.summaryCount).toBe(2);
    expect(result.factCount).toBeGreaterThan(0);
    expect(savedSummaries.map((summary) => summary.id)).toEqual([
      "summary:task-complete",
      "summary:task-failed",
    ]);
    expect(savedFacts).toEqual([
      expect.objectContaining({
        fact: "User prefers local Agent memory",
        sourceSessionId: "task-complete",
        scopeType: "workspace",
      }),
    ]);
  });
});

function createPromptRepository(input: {
  facts: SearchMemoryResult[];
  summaries: AgentSessionSummary[];
}) {
  const searches: SearchMemoryInput[] = [];
  const summaryRequests: Array<{ workspaceId?: string; limit?: number }> = [];
  return {
    searches,
    summaryRequests,
    async searchMemory(request: SearchMemoryInput) {
      searches.push(request);
      return input.facts;
    },
    async listRecentSessionSummaries(workspaceId?: string, limit?: number) {
      summaryRequests.push({ workspaceId, limit });
      return input.summaries;
    },
  };
}

function createSearchResult(id: string, fact: string, scopeType: SearchMemoryResult["scopeType"]): SearchMemoryResult {
  return {
    id,
    fact,
    kind: "technical_constraint",
    tags: ["memory"],
    scopeType,
    scopeId: scopeType === "workspace" ? "workspace:abc" : undefined,
    confidence: 0.9,
    importance: 5,
    updatedAt: 1_700_000_000_000,
    score: 4,
  };
}

function createSummary(id: string, summary: string): AgentSessionSummary {
  return {
    id,
    sessionId: id.replace("summary:", ""),
    workspaceId: "workspace:abc",
    summary,
    importantPoints: [],
    openThreads: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function createTask(
  id: string,
  status: TaskSnapshot["status"],
  userGoal: string,
): TaskSnapshot {
  return {
    id,
    title: "Task",
    userGoal,
    status,
    commanderMessage: "Done.",
    plan: [],
    agents: [],
    logs: [],
    workspacePath: "E:/Javis",
    conversationMessages: [
      { role: "user", content: userGoal },
      { role: "assistant", content: "Done." },
    ],
  };
}
