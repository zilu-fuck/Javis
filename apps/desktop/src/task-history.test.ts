import { describe, expect, it } from "vitest";
import {
  TASK_HISTORY_LIMIT,
  TASK_HISTORY_STORAGE_KEY,
  getTaskUpdatedAt,
  loadTaskHistory,
  saveTaskHistory,
  sanitizeTaskSnapshot,
  upsertTaskHistory,
} from "./task-history";
import type { TaskSnapshot } from "@javis/core";

describe("task history persistence", () => {
  it("saves archivable snapshots and strips permission requests", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      permissionRequest: {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Write requires approval.",
        status: "approved",
        createdAt: "2026-05-23T00:00:00.000Z",
        dryRun: {
          operation: "Move files",
          affectedPaths: [],
          riskSummary: "Risk",
          reversible: true,
        },
      },
    } satisfies TaskSnapshot;

    const saved = saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(saved).toHaveLength(1);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.permissionRequest).toBeUndefined();
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).not.toContain("permission-1");
  });

  it("rejects malformed localStorage snapshots", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify([
        createTask("task-1000"),
        {
          ...createTask("task-2000"),
          permissionRequest: { dryRun: null },
          sources: [{ url: "https://example.test", excerpt: 42 }],
        },
        { id: "task-bad", title: "Bad" },
      ]),
    );

    const loaded = loadTaskHistory(storage);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.permissionRequest).toBeUndefined();
    expect(loaded[1]?.sources).toBeUndefined();
  });

  it("keeps only archivable tasks and enforces the history limit", () => {
    const manyTasks = Array.from({ length: TASK_HISTORY_LIMIT + 3 }, (_, index) =>
      createTask(`task-${1000 + index}`),
    );
    const storage = createMemoryStorage();

    const saved = saveTaskHistory(storage, [
      createTask("task-running", "running"),
      ...manyTasks,
    ]);

    expect(saved).toHaveLength(TASK_HISTORY_LIMIT);
    expect(saved.every((task) => task.status === "completed")).toBe(true);
    expect(saved[0]?.id).toBe("task-1000");
  });

  it("upserts newest task snapshots at the front", () => {
    const first = createTask("task-1000");
    const updated = { ...first, title: "Updated task" };
    const second = createTask("task-2000");

    const history = upsertTaskHistory(upsertTaskHistory([first], second), updated);

    expect(history.map((task) => task.id)).toEqual(["task-1000", "task-2000"]);
    expect(history[0]?.title).toBe("Updated task");
  });

  it("keeps code review previews in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      codeReviewPreview: {
        workspacePath: "E:/Javis",
        changedFiles: ["packages/core/src/index.ts"],
        diffStat: "1 file changed",
        diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.codeReviewPreview?.changedFiles).toEqual(["packages/core/src/index.ts"]);
    expect(loaded[0]?.codeReviewPreview?.diff).toContain("diff --git");
  });

  it("returns stable timestamps from task ids when available", () => {
    expect(getTaskUpdatedAt(createTask("task-1000"))).toBe("1970-01-01T00:00:01.000Z");
  });

  it("drops optional sections with invalid shapes during sanitization", () => {
    const sanitized = sanitizeTaskSnapshot({
      ...createTask("task-1000"),
      project: { workspacePath: "E:/Javis", scripts: [{ name: "test" }] },
    });

    expect(sanitized).not.toBeNull();
    expect(sanitized?.project).toBeUndefined();
  });
});

function createTask(
  id: string,
  status: TaskSnapshot["status"] = "completed",
): TaskSnapshot {
  return {
    id,
    title: "Project environment inspected",
    userGoal: "Inspect project",
    status,
    commanderMessage: "Task finished.",
    plan: [
      {
        id: "step-1",
        title: "Inspect project",
        assignedAgentKind: "shell",
        status: "completed",
      },
    ],
    agents: [
      {
        id: "agent-shell",
        name: "Shell Agent",
        role: "Read-only command execution",
        status: "completed",
        task: "Task finished",
      },
    ],
    logs: [
      {
        id: `${id}-done`,
        kind: "verification",
        title: "task.completed",
        detail: "Verified.",
      },
    ],
  };
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
