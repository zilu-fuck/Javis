import { describe, expect, it } from "vitest";
import {
  TASK_HISTORY_LIMIT,
  TASK_HISTORY_SCHEMA_MIGRATIONS,
  TASK_HISTORY_SCHEMA_MIGRATION,
  TASK_HISTORY_SCHEMA_SQL,
  TASK_HISTORY_STORAGE_KEY,
  TASK_HISTORY_STORAGE_VERSION,
  TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION,
  TASK_HISTORY_UPDATED_AT_INDEX_SQL,
  createTaskHistoryRepository,
  getTaskWorkspacePath,
  getTaskUpdatedAt,
  loadTaskHistory,
  loadTaskHistoryWithStorageFallback,
  saveTaskHistory,
  sanitizeTaskSnapshot,
  upsertTaskHistory,
} from "./task-history";
import type { TaskSnapshot } from "@javis/core";
import type { DatabaseValue, DesktopDatabase } from "./desktop-database";

describe("task history persistence", () => {
  it("keeps resolved permission decisions in completed task history", () => {
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
        resolvedAt: "2026-05-23T00:00:01.000Z",
        bindingHash: "dryrun-fnv1a-test",
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
    expect(loaded[0]?.permissionRequest?.id).toBe("permission-1");
    expect(loaded[0]?.permissionRequest?.status).toBe("approved");
    expect(loaded[0]?.permissionRequest?.bindingHash).toBe("dryrun-fnv1a-test");
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).toContain("permission-1");
  });

  it("strips pending permission requests from task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      permissionRequest: {
        id: "permission-pending",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Write requires approval.",
        status: "pending",
        createdAt: "2026-05-23T00:00:00.000Z",
        dryRun: {
          operation: "Move files",
          affectedPaths: [],
          riskSummary: "Risk",
          reversible: true,
        },
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.permissionRequest).toBeUndefined();
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).not.toContain("permission-pending");
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

  it("loads versioned task history storage envelopes", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: TASK_HISTORY_STORAGE_VERSION,
        tasks: [createTask("task-1000")],
      }),
    );

    const loaded = loadTaskHistory(storage);

    expect(loaded.map((task) => task.id)).toEqual(["task-1000"]);
  });

  it("ignores task history storage envelopes from unknown versions", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: TASK_HISTORY_STORAGE_VERSION + 1,
        tasks: [createTask("task-1000")],
      }),
    );

    expect(loadTaskHistory(storage)).toEqual([]);
  });

  it("rejects snapshots with unknown persisted state values", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify([
        createTask("task-1000"),
        {
          ...createTask("task-2000"),
          plan: [
            {
              id: "step-1",
              title: "Inspect project",
              assignedAgentKind: "shell",
              status: "mystery",
            },
          ],
        },
        {
          ...createTask("task-3000"),
          agents: [
            {
              id: "agent-shell",
              name: "Shell Agent",
              role: "Read-only command execution",
              status: "paused",
              task: "Task finished",
            },
          ],
        },
        {
          ...createTask("task-4000"),
          logs: [
            {
              id: "task-4000-done",
              kind: "debug",
              title: "task.completed",
              detail: "Verified.",
            },
          ],
        },
        {
          ...createTask("task-5000"),
          permissionRequest: {
            id: "permission-1",
            level: "confirmed_write",
            title: "Approve write",
            reason: "Write requires approval.",
            status: "approved",
            createdAt: "2026-05-23T00:00:00.000Z",
            dryRun: {
              operation: "Move files",
              affectedPaths: [
                {
                  source: "a.pdf",
                  target: "b.pdf",
                  action: "archive",
                },
              ],
              riskSummary: "Risk",
              reversible: true,
            },
          },
        },
      ]),
    );

    const loaded = loadTaskHistory(storage);

    expect(loaded.map((task) => task.id)).toEqual(["task-1000", "task-5000"]);
    expect(loaded[1]?.permissionRequest).toBeUndefined();
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

  it("keeps scheduled task ids in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      scheduledTaskId: "st-1000",
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.scheduledTaskId).toBe("st-1000");
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).toContain("st-1000");
  });

  it("keeps Code Agent proposal and apply results in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      codeProposedEdit: {
        proposalId: "proposal-1",
        workspacePath: "E:/Javis",
        summary: "Tighten the code review completion message.",
        changedFiles: ["packages/core/src/index.ts"],
        patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        patchHash: "fnv1a-19fcfa54",
      },
      codeApplyResult: {
        applied: true,
        workspacePath: "E:/Javis",
        changedFiles: ["packages/core/src/index.ts"],
        message: "Applied patch in test.",
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.codeProposedEdit?.summary).toContain("Tighten");
    expect(loaded[0]?.codeProposedEdit?.patch).toBe("");
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).not.toContain("diff --git");
    expect(loaded[0]?.codeApplyResult?.applied).toBe(true);
  });

  it("keeps token usage summaries in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        modelCalls: 1,
        byAgentKind: [
          {
            agentKind: "code",
            inputTokens: 1200,
            outputTokens: 340,
            totalTokens: 1540,
            modelCalls: 1,
          },
        ],
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.tokenUsage?.totalTokens).toBe(1540);
    expect(loaded[0]?.tokenUsage?.byAgentKind[0]?.agentKind).toBe("code");
  });

  it("returns stable timestamps from task ids when available", () => {
    expect(getTaskUpdatedAt(createTask("task-1000"))).toBe("1970-01-01T00:00:01.000Z");
  });

  it("keeps project entry metadata in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      originMode: "project",
      workspacePath: "E:/Javis",
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.originMode).toBe("project");
    expect(loaded[0]?.workspacePath).toBe("E:/Javis");
  });

  it("derives workspace paths from older project history entries", () => {
    const task = {
      ...createTask("task-1000"),
      project: {
        workspacePath: "E:/Javis",
        packageManager: "pnpm",
        scripts: [],
      },
    } satisfies TaskSnapshot;

    expect(getTaskWorkspacePath(task)).toBe("E:/Javis");
  });

  it("ignores empty task workspace metadata when deriving workspace paths", () => {
    const task = {
      ...createTask("task-1000"),
      workspacePath: "",
      codeReviewPreview: {
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      },
    } satisfies TaskSnapshot;

    expect(getTaskWorkspacePath(task)).toBe("E:/Javis");
  });

  it("drops optional sections with invalid shapes during sanitization", () => {
    const sanitized = sanitizeTaskSnapshot({
      ...createTask("task-1000"),
      project: { workspacePath: "E:/Javis", scripts: [{ name: "test" }] },
      tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });

    expect(sanitized).not.toBeNull();
    expect(sanitized?.project).toBeUndefined();
    expect(sanitized?.tokenUsage).toBeUndefined();
  });

  it("exposes SQLite-ready task history schema migration SQL", () => {
    expect(TASK_HISTORY_SCHEMA_MIGRATION).toEqual({
      id: "001_task_history",
      sql: TASK_HISTORY_SCHEMA_SQL,
    });
    expect(TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION).toEqual({
      id: "002_task_history_updated_at_index",
      sql: TASK_HISTORY_UPDATED_AT_INDEX_SQL,
    });
    expect(TASK_HISTORY_SCHEMA_MIGRATIONS).toEqual([
      TASK_HISTORY_SCHEMA_MIGRATION,
      TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION,
    ]);
    expect(TASK_HISTORY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS task_history");
    expect(TASK_HISTORY_SCHEMA_SQL).toContain("snapshot_json TEXT NOT NULL");
    expect(TASK_HISTORY_UPDATED_AT_INDEX_SQL).toContain(
      "CREATE INDEX IF NOT EXISTS idx_task_history_updated_at",
    );
  });

  it("persists sanitized task history through the async repository", async () => {
    const database = createMemoryTaskHistoryDatabase();
    const repository = createTaskHistoryRepository(database);
    const task = {
      ...createTask("task-1000"),
      permissionRequest: {
        id: "permission-pending",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Write requires approval.",
        status: "pending",
        createdAt: "2026-05-23T00:00:00.000Z",
        dryRun: {
          operation: "Move files",
          affectedPaths: [],
          riskSummary: "Risk",
          reversible: true,
        },
      },
      codeProposedEdit: {
        proposalId: "proposal-1",
        workspacePath: "E:/Javis",
        summary: "Tighten the code review completion message.",
        changedFiles: ["packages/core/src/index.ts"],
        patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        patchHash: "fnv1a-19fcfa54",
      },
    } satisfies TaskSnapshot;

    const saved = await repository.save([task, createTask("task-running", "running")]);
    const loaded = await repository.list();

    expect(saved.map((entry) => entry.id)).toEqual(["task-1000"]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.permissionRequest).toBeUndefined();
    expect(loaded[0]?.codeProposedEdit?.patch).toBe("");
    expect(database.rows[0]?.snapshot_json).not.toContain("permission-pending");
    expect(database.rows[0]?.snapshot_json).not.toContain("diff --git");
  });

  it("upserts repository entries with newest snapshots first", async () => {
    const repository = createTaskHistoryRepository(createMemoryTaskHistoryDatabase());
    const first = createTask("task-1000");
    const second = createTask("task-2000");

    await repository.save([first]);
    const history = await repository.upsert(second);

    expect(history.map((task) => task.id)).toEqual(["task-2000", "task-1000"]);
  });

  it("imports sanitized legacy localStorage history into the repository", async () => {
    const storage = createMemoryStorage();
    const database = createMemoryTaskHistoryDatabase();
    const repository = createTaskHistoryRepository(database);
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: TASK_HISTORY_STORAGE_VERSION,
        tasks: [createTask("task-1000"), createTask("task-running", "running")],
      }),
    );

    const imported = await repository.importFromLocalStorage(storage);
    const loaded = await repository.list();

    expect(imported.map((task) => task.id)).toEqual(["task-1000"]);
    expect(loaded.map((task) => task.id)).toEqual(["task-1000"]);
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it("keeps existing repository history when localStorage import is empty", async () => {
    const repository = createTaskHistoryRepository(createMemoryTaskHistoryDatabase());
    await repository.save([createTask("task-1000")]);

    const imported = await repository.importFromLocalStorage(createMemoryStorage());

    expect(imported.map((task) => task.id)).toEqual(["task-1000"]);
  });

  it("falls back to localStorage when task history repository loading fails", async () => {
    const storage = createMemoryStorage();
    storage.setItem(TASK_HISTORY_STORAGE_KEY, JSON.stringify([createTask("task-1000")]));
    const failingRepository = {
      async list() {
        throw new Error("unavailable");
      },
    };
    const expectedTask = sanitizeTaskSnapshot(createTask("task-1000"));

    await expect(
      loadTaskHistoryWithStorageFallback(failingRepository, storage),
    ).resolves.toEqual(expectedTask ? [expectedTask] : []);
    await expect(
      loadTaskHistoryWithStorageFallback(null, storage),
    ).resolves.toEqual(expectedTask ? [expectedTask] : []);
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

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function createMemoryTaskHistoryDatabase(initialRows: TaskHistoryRow[] = []) {
  const rows = [...initialRows];
  const database: DesktopDatabase & {
    executedSql: string[];
    bindValues: DatabaseValue[][];
    rows: TaskHistoryRow[];
  } = {
    executedSql: [],
    bindValues: [],
    rows,
    async execute(sql, values = []) {
      this.executedSql.push(sql);
      if (values.length > 0) {
        this.bindValues.push(values);
      }
      if (sql.startsWith("DELETE FROM task_history")) {
        rows.splice(0, rows.length);
        return;
      }
      if (!sql.startsWith("INSERT INTO task_history")) {
        return;
      }

      const row = bindValuesToTaskHistoryRow(values);
      const existingIndex = rows.findIndex((entry) => entry.id === row.id);
      if (existingIndex >= 0) {
        rows[existingIndex] = row;
      } else {
        rows.push(row);
      }
    },
    async select<T extends Record<string, unknown>>(_sql: string, values = []) {
      const limit = typeof values[0] === "number" ? values[0] : TASK_HISTORY_LIMIT;
      return [...rows]
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, limit)
        .map((row) => ({ snapshot_json: row.snapshot_json }) as unknown as T);
    },
  };
  return database;
}

interface TaskHistoryRow {
  id: string;
  title: string;
  user_goal: string;
  status: string;
  updated_at: string;
  snapshot_json: string;
}

function bindValuesToTaskHistoryRow(values: DatabaseValue[]): TaskHistoryRow {
  const [id, title, userGoal, status, updatedAt, snapshotJson] = values;
  return {
    id: String(id),
    title: String(title),
    user_goal: String(userGoal),
    status: String(status),
    updated_at: String(updatedAt),
    snapshot_json: String(snapshotJson),
  };
}
