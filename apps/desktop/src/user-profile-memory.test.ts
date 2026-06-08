import { describe, expect, it } from "vitest";
import type { TaskSnapshot } from "@javis/core";
import {
  USER_PROFILE_MEMORY_MIGRATIONS,
  USER_PROFILE_MEMORY_STORAGE_KEY,
  createNewChatRecommendations,
  createUserProfileMemory,
  createUserProfileMemoryRepository,
  loadUserProfileMemory,
  saveUserProfileMemory,
  updateUserProfileMemory,
} from "./user-profile-memory";

describe("user profile memory", () => {
  it("extracts profile facts with evidence from recent user history", () => {
    const memory = createUserProfileMemory({
      history: [
        createTask("task-1", "检查 user-profile-memory 和 user-profile-rules 的提取逻辑，减少推荐栏泛化 fallback"),
        createTask("task-2", "继续优化 Javis workbench 的新聊天推荐栏和工作区面板"),
        createTask("task-3", "美化 UI，调整侧边栏、日志栏、图标尺寸和按钮布局"),
        createTask("task-4", "完善 computer use 改造，补浏览器和屏幕工具的审批测试"),
      ],
      currentWorkspacePath: "E:\\Javis",
      recentWorkspacePaths: ["E:\\Javis"],
      now: "2026-06-05T10:00:00.000Z",
    });

    const memoryFact = memory.facts.find((fact) => fact.tags.includes("memory"));
    const workbenchFact = memory.facts.find((fact) => fact.tags.includes("workbench"));
    const uiFact = memory.facts.find((fact) => fact.tags.includes("ui"));
    const computerUseFact = memory.facts.find((fact) => fact.tags.includes("computer-use"));

    expect(memory.version).toBe(2);
    expect(memory.summary.topTags).toContain("workbench");
    expect(memoryFact?.evidence[0]?.matchedKeywords).toContain("user-profile-memory");
    expect(workbenchFact?.evidence[0]?.snippet).toContain("workbench");
    expect(uiFact?.evidence[0]?.snippet).toContain("UI");
    expect(computerUseFact?.evidence[0]?.matchedKeywords).toContain("computer use");
    expect(memory.facts.some((fact) => fact.tags.includes("workspace"))).toBe(true);
  });

  it("creates specific recommendations for recent workbench, UI, and computer-use work", () => {
    const memory = createUserProfileMemory({
      history: [
        createTask("task-1", "继续优化新聊天推荐栏，检查 user-profile-memory 和 user-profile-rules"),
        createTask("task-2", "美化 Javis workbench UI，调整侧边栏、日志栏和图标尺寸"),
        createTask("task-3", "改造 computer use 执行循环，补浏览器和屏幕工具测试"),
      ],
      currentWorkspacePath: "E:\\Javis",
      recentWorkspacePaths: ["E:\\Javis"],
      now: "2026-06-05T10:00:00.000Z",
    });

    const recommendations = createNewChatRecommendations(memory, "zh");
    const primaryIds = recommendations.primary.map((item) => item.id);

    expect(primaryIds).toEqual(expect.arrayContaining([
      "workbench-recommendation",
      "ui-recommendation",
      "computer-use-recommendation",
      "memory-recommendation",
    ]));
    expect(recommendations.primary.find((item) => item.id === "workbench-recommendation")?.reason).toContain("新聊天入口");
    expect(recommendations.primary.find((item) => item.id === "computer-use-recommendation")?.evidence?.[0]?.snippet).toContain("computer use");
  });

  it("does not pad thin profile evidence with generic Javis fallback", () => {
    const memory = createUserProfileMemory({
      history: [createTask("task-1", "继续优化 workbench")],
      currentWorkspacePath: "E:\\Javis",
      now: "2026-06-05T10:00:00.000Z",
    });

    const recommendations = createNewChatRecommendations(memory, "zh");
    const primaryIds = recommendations.primary.map((item) => item.id);

    expect(primaryIds).toContain("workbench-recommendation");
    expect(primaryIds).toContain("local-knowledge-recommendation");
    expect(primaryIds).not.toContain("fallback-workbench");
    expect(primaryIds).not.toContain("fallback-ui");
    expect(primaryIds).not.toContain("fallback-computer-use");
    expect(recommendations.primary.every((item) => item.source !== "default")).toBe(true);
    expect(recommendations.primary).toHaveLength(2);
  });

  it("uses recent changed Javis files as recommendation evidence", () => {
    const task = createTask("task-1", "Continue the latest Javis changes");
    task.codeApplyResult = {
      applied: true,
      workspacePath: "E:\\Javis",
      changedFiles: [
        "apps/desktop/src/user-profile-recommendation-engine.ts",
        "packages/ui/src/components/NewChat.tsx",
      ],
      message: "Applied recommendation bar changes.",
    };

    const memory = createUserProfileMemory({
      history: [task],
      currentWorkspacePath: "E:\\Javis",
      recentWorkspacePaths: ["E:\\Javis"],
      now: "2026-06-05T10:00:00.000Z",
    });
    const recommendations = createNewChatRecommendations(memory, "en");
    const memoryRecommendation = recommendations.primary.find((item) => item.id === "memory-recommendation");
    const workbenchRecommendation = recommendations.primary.find((item) => item.id === "workbench-recommendation");

    expect(memory.facts.find((fact) => fact.tags.includes("memory"))?.evidence[0]?.snippet).toContain("user-profile-recommendation-engine");
    expect(memoryRecommendation?.evidence?.[0]?.snippet).toContain("user-profile-recommendation-engine");
    expect(workbenchRecommendation?.evidence?.[0]?.snippet).toContain("NewChat");
    expect(recommendations.primary.every((item) => item.source !== "default")).toBe(true);
  });

  it("keeps secondary recommendations evidence-backed instead of generic", () => {
    const memory = createUserProfileMemory({
      history: [createTask("task-1", "Refine user-profile-recommendation-engine recommendations and run vitest verification")],
      currentWorkspacePath: "E:\\Javis",
      recentWorkspacePaths: ["E:\\Javis"],
      now: "2026-06-05T10:00:00.000Z",
    });

    const recommendations = createNewChatRecommendations(memory, "en");

    expect(recommendations.secondary.length).toBeGreaterThan(0);
    expect(recommendations.secondary.every((item) => item.reason && item.evidence?.length)).toBe(true);
    expect(recommendations.secondary.every((item) => item.source !== "default")).toBe(true);
  });

  it("skips unchanged profile inputs and incrementally processes changed tasks", () => {
    const history = [
      createTask("task-1", "完善 UserProfileMemory 和 RecommendationEngine"),
    ];
    const previous = createUserProfileMemory({
      history,
      currentWorkspacePath: "E:\\Javis",
      now: "2026-06-05T10:00:00.000Z",
    });

    const skipped = updateUserProfileMemory({
      history,
      currentWorkspacePath: "E:\\Javis",
      previous,
      now: "2026-06-05T10:05:00.000Z",
    });

    expect(skipped.changed).toBe(false);
    expect(skipped.mode).toBe("skipped");
    expect(skipped.memory).toBe(previous);

    const next = updateUserProfileMemory({
      history: [
        createTask("task-2", "运行 vitest 和 typecheck 验证"),
        ...history,
      ],
      currentWorkspacePath: "E:\\Javis",
      previous,
      now: "2026-06-05T10:10:00.000Z",
    });

    expect(next.changed).toBe(true);
    expect(next.mode).toBe("incremental");
    expect(next.processedTaskIds).toEqual(["task-2"]);
    expect(next.memory.summary.historyItemCount).toBe(2);
    expect(next.memory.facts.some((fact) => fact.tags.includes("verification"))).toBe(true);
  });

  it("decays stale facts that are not observed again", () => {
    const previous = createUserProfileMemory({
      history: [createTask("task-old", "继续优化 UI 界面和概念图里的侧边栏布局", "2026-05-01T10:00:00.000Z")],
      now: "2026-05-01T10:00:00.000Z",
    });
    const oldUiScore = previous.facts.find((fact) => fact.tags.includes("ui"))?.score ?? 0;

    const next = createUserProfileMemory({
      history: [createTask("task-new", "实现代码并补充测试验证", "2026-06-05T10:00:00.000Z")],
      previous,
      now: "2026-06-05T10:00:00.000Z",
    });
    const newUiScore = next.facts.find((fact) => fact.tags.includes("ui"))?.score ?? 0;

    expect(newUiScore).toBeLessThan(oldUiScore);
    expect(next.facts.some((fact) => fact.tags.includes("implementation"))).toBe(true);
  });

  it("round-trips persisted memory and migrates legacy v1 records", () => {
    const storage = createMemoryStorage();
    const memory = createUserProfileMemory({
      history: [createTask("task-1", "检查当前项目代码并补充测试验证")],
      currentWorkspacePath: "E:\\Javis",
      now: "2026-06-05T10:00:00.000Z",
    });

    saveUserProfileMemory(storage, memory);

    expect(loadUserProfileMemory(storage)).toEqual(memory);

    storage.setItem(USER_PROFILE_MEMORY_STORAGE_KEY, JSON.stringify({
      version: 1,
      updatedAt: "2026-06-05T10:00:00.000Z",
      facts: [{
        id: "history-code",
        kind: "work_pattern",
        text: "用户偏好可验证代码改动",
        tags: ["implementation"],
        score: 0.7,
        source: "history",
        updatedAt: "2026-06-05T10:00:00.000Z",
      }],
    }));

    const migrated = loadUserProfileMemory(storage);

    expect(migrated?.version).toBe(2);
    expect(migrated?.facts[0]?.confidence).toBeGreaterThan(0);
    expect(migrated?.summary.topTags).toContain("implementation");
  });

  it("does not throw when storage is unavailable", () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    const memory = createUserProfileMemory({
      history: [createTask("task-1", "实现代码并补充测试验证")],
      now: "2026-06-05T10:00:00.000Z",
    });

    expect(loadUserProfileMemory(throwingStorage)).toBeNull();
    expect(saveUserProfileMemory(throwingStorage, memory)).toBe(false);
  });

  it("keeps only the current workspace fact when the project changes", () => {
    const previous = createUserProfileMemory({
      history: [],
      currentWorkspacePath: "E:\\OldProject",
      recentWorkspacePaths: ["E:\\OldProject"],
      now: "2026-06-05T09:00:00.000Z",
    });

    const next = createUserProfileMemory({
      history: [],
      currentWorkspacePath: "E:\\Javis",
      recentWorkspacePaths: ["E:\\Javis"],
      previous,
      now: "2026-06-05T10:00:00.000Z",
    });
    const workspaceFacts = next.facts.filter((fact) => fact.source === "workspace");

    expect(workspaceFacts).toHaveLength(1);
    expect(workspaceFacts[0]?.text).toContain("E:\\Javis");
    expect(workspaceFacts[0]?.text).not.toContain("OldProject");
  });

  it("accumulates repeated observations for the same fact", () => {
    const previous = createUserProfileMemory({
      history: [createTask("task-1", "实现代码并补充测试验证")],
      now: "2026-06-05T09:00:00.000Z",
    });
    const oldFact = previous.facts.find((fact) => fact.tags.includes("implementation"));

    const next = createUserProfileMemory({
      history: [createTask("task-2", "继续实现代码并补充测试验证")],
      previous,
      now: "2026-06-05T10:00:00.000Z",
    });
    const newFact = next.facts.find((fact) => fact.tags.includes("implementation"));

    expect(newFact?.hitCount).toBeGreaterThan(oldFact?.hitCount ?? 0);
  });

  it("uses topic-specific reasons for secondary recommendations", () => {
    const memory = createUserProfileMemory({
      history: [createTask("task-1", "运行测试验证当前项目状态")],
      currentWorkspacePath: "E:\\Javis",
      now: "2026-06-05T10:00:00.000Z",
    });

    const recommendations = createNewChatRecommendations(memory, "zh");
    const technicalPlan = recommendations.secondary.find((item) => item.id === "computer-use-test-plan");

    expect(technicalPlan?.reason).toContain("测试");
  });

  it("ignores corrupt persisted memory", () => {
    const storage = createMemoryStorage();
    storage.setItem(USER_PROFILE_MEMORY_STORAGE_KEY, "{not-json");

    expect(loadUserProfileMemory(storage)).toBeNull();
  });

  it("defines a sqlite schema migration", () => {
    expect(USER_PROFILE_MEMORY_MIGRATIONS).toEqual([
      {
        id: "001_user_profile_memory",
        sql: expect.stringContaining("CREATE TABLE IF NOT EXISTS user_profile_memory"),
      },
    ]);
  });

  it("persists profile memory in sqlite and can clear it", async () => {
    const repository = createUserProfileMemoryRepository(createMemoryProfileDatabase());
    const memory = createUserProfileMemory({
      history: [createTask("task-1", "实现代码并补充测试验证")],
      currentWorkspacePath: "E:\\Javis",
      now: "2026-06-05T10:00:00.000Z",
    });

    await repository.save(memory);

    expect(await repository.load()).toEqual(memory);

    await repository.clear();

    expect(await repository.load()).toBeNull();
  });

  it("imports legacy localStorage profile memory into sqlite", async () => {
    const storage = createMemoryStorage();
    const repository = createUserProfileMemoryRepository(createMemoryProfileDatabase());
    const memory = createUserProfileMemory({
      history: [createTask("task-1", "完善 UserProfileMemory 和 RecommendationEngine")],
      now: "2026-06-05T10:00:00.000Z",
    });
    saveUserProfileMemory(storage, memory);

    const imported = await repository.importFromLocalStorage(storage);

    expect(imported).toEqual(memory);
    expect(await repository.load()).toEqual(memory);
    expect(storage.getItem(USER_PROFILE_MEMORY_STORAGE_KEY)).toBeNull();
  });
});

function createTask(id: string, goal: string, updatedAt = "2026-06-05T10:00:00.000Z"): TaskSnapshot {
  return {
    id,
    title: goal,
    userGoal: goal,
    status: "completed",
    updatedAt,
    commanderMessage: "Done",
    plan: [],
    agents: [],
    logs: [],
    conversationMessages: [{ role: "user", content: goal }],
  };
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function createMemoryProfileDatabase() {
  let row: { updated_at: string; memory_json: string } | null = null;
  return {
    async execute(sql: string, bindValues: unknown[] = []) {
      if (sql.startsWith("INSERT INTO user_profile_memory")) {
        row = {
          updated_at: String(bindValues[1] ?? ""),
          memory_json: String(bindValues[2] ?? ""),
        };
        return;
      }
      if (sql.startsWith("DELETE FROM user_profile_memory")) {
        row = null;
      }
    },
    async select<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
      if (sql.startsWith("SELECT memory_json FROM user_profile_memory")) {
        return row ? ([{ memory_json: row.memory_json }] as unknown as T[]) : [];
      }
      return [];
    },
  };
}
