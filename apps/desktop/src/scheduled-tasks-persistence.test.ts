import { describe, expect, it } from "vitest";
import type { ScheduledTask } from "./scheduled-tasks";
import { SCHEDULED_TASKS_STORAGE_KEY } from "./scheduled-tasks-persistence";
import type { DatabaseValue } from "./desktop-database";
import {
  SCHEDULED_TASKS_MIGRATIONS,
  SCHEDULED_TASKS_NEXT_RUN_INDEX_SQL,
  SCHEDULED_TASKS_TABLE_SQL,
  createScheduledTasksRepository,
  importScheduledTasksFromLocalStorage,
  loadScheduledTasksFromDatabase,
  loadScheduledTasksWithStorageFallback,
  saveScheduledTasksToDatabase,
} from "./scheduled-tasks-persistence";

describe("scheduled tasks persistence", () => {
  it("exports SQLite-ready schema and migration constants", () => {
    expect(SCHEDULED_TASKS_TABLE_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS scheduled_tasks",
    );
    expect(SCHEDULED_TASKS_TABLE_SQL).toContain("id TEXT PRIMARY KEY");
    expect(SCHEDULED_TASKS_TABLE_SQL).toContain("next_run_at TEXT NOT NULL");
    expect(SCHEDULED_TASKS_NEXT_RUN_INDEX_SQL).toContain(
      "idx_scheduled_tasks_next_run",
    );
    expect(SCHEDULED_TASKS_MIGRATIONS.map((m) => m.id)).toEqual([
      "scheduled-tasks-v1-table",
      "scheduled-tasks-v1-next-run-index",
    ]);
  });

  describe("loadScheduledTasksFromDatabase", () => {
    it("maps database rows to ScheduledTask objects", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const task = makeTask("task-1");
      await saveScheduledTasksToDatabase(database, [task], now);

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded).toEqual([task]);
    });

    it("returns an empty array when the table is empty", async () => {
      const database = createMemoryScheduledTasksDatabase();

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded).toEqual([]);
    });

    it("orders rows by next_run_at ascending", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const later = makeTask("task-later", { nextRunAt: "2026-06-01T00:00:00.000Z" });
      const sooner = makeTask("task-sooner", { nextRunAt: "2026-05-29T00:00:00.000Z" });
      await saveScheduledTasksToDatabase(database, [later, sooner], now);

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded.map((t) => t.id)).toEqual(["task-sooner", "task-later"]);
    });

    it("converts enabled integer 1 to boolean true and 0 to false", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const enabled = makeTask("task-enabled", { enabled: true });
      const disabled = makeTask("task-disabled", { enabled: false });
      await saveScheduledTasksToDatabase(database, [enabled, disabled], now);

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded.find((t) => t.id === "task-enabled")?.enabled).toBe(true);
      expect(loaded.find((t) => t.id === "task-disabled")?.enabled).toBe(false);
    });

    it("maps null last_run_at and last_run_started_at to undefined", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const task = makeTask("task-nullable", {
        lastRunAt: undefined,
        lastRunStartedAt: undefined,
      });
      await saveScheduledTasksToDatabase(database, [task], now);

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded[0]?.lastRunAt).toBeUndefined();
      expect(loaded[0]?.lastRunStartedAt).toBeUndefined();
    });

    it("preserves last_run_at and last_run_started_at when set", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const task = makeTask("task-with-runs", {
        lastRunAt: "2026-05-28T08:00:00.000Z",
        lastRunStartedAt: "2026-05-28T07:55:00.000Z",
      });
      await saveScheduledTasksToDatabase(database, [task], now);

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded[0]?.lastRunAt).toBe("2026-05-28T08:00:00.000Z");
      expect(loaded[0]?.lastRunStartedAt).toBe("2026-05-28T07:55:00.000Z");
    });
  });

  describe("saveScheduledTasksToDatabase", () => {
    it("deletes all existing rows before inserting", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const first = makeTask("task-1");
      const second = makeTask("task-2");
      await saveScheduledTasksToDatabase(database, [first], now);
      await saveScheduledTasksToDatabase(database, [second], now);

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.id).toBe("task-2");
    });

    it("inserts each task as a separate row", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const tasks = [makeTask("task-a"), makeTask("task-b"), makeTask("task-c")];
      await saveScheduledTasksToDatabase(database, tasks, now);

      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded).toHaveLength(3);
      expect(loaded.map((t) => t.id)).toEqual(
        expect.arrayContaining(["task-a", "task-b", "task-c"]),
      );
    });

    it("returns the saved tasks", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const tasks = [makeTask("task-1")];

      const result = await saveScheduledTasksToDatabase(database, tasks, now);

      expect(result).toEqual(tasks);
    });

    it("uses the provided updatedAt timestamp for all rows", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const updatedAt = "2026-05-28T12:00:00.000Z";
      await saveScheduledTasksToDatabase(
        database,
        [makeTask("task-1")],
        updatedAt,
      );

      expect(database.rows.get("task-1")?.updated_at).toBe(updatedAt);
    });
  });

  describe("importScheduledTasksFromLocalStorage", () => {
    it("imports tasks from localStorage into the database and removes the legacy key", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const storage = createMemoryStorage();
      const tasks = [makeTask("imported-1"), makeTask("imported-2")];
      storage.setItem(
        SCHEDULED_TASKS_STORAGE_KEY,
        JSON.stringify({ version: 1, tasks }),
      );

      const updatedAt = "2026-05-28T10:00:00.000Z";
      const imported = await importScheduledTasksFromLocalStorage(
        database,
        storage,
        updatedAt,
      );

      expect(imported).toEqual(tasks);
      expect(await loadScheduledTasksFromDatabase(database)).toEqual(tasks);
      expect(storage.getItem(SCHEDULED_TASKS_STORAGE_KEY)).toBeNull();
    });

    it("removes legacy key even when localStorage has an empty task list and a legacy value exists", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const storage = createMemoryStorage();
      storage.setItem(
        SCHEDULED_TASKS_STORAGE_KEY,
        JSON.stringify({ version: 1, tasks: [] }),
      );

      const updatedAt = "2026-05-28T10:00:00.000Z";
      const imported = await importScheduledTasksFromLocalStorage(
        database,
        storage,
        updatedAt,
      );

      expect(imported).toEqual([]);
      expect(storage.getItem(SCHEDULED_TASKS_STORAGE_KEY)).toBeNull();
    });

    it("returns current database tasks when localStorage has no legacy value", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const storage = createMemoryStorage();
      const existing = makeTask("existing");
      await saveScheduledTasksToDatabase(database, [existing], "2026-05-28T10:00:00.000Z");

      const updatedAt = "2026-05-28T11:00:00.000Z";
      const imported = await importScheduledTasksFromLocalStorage(
        database,
        storage,
        updatedAt,
      );

      expect(imported).toEqual([existing]);
    });
  });

  describe("loadScheduledTasksWithStorageFallback", () => {
    it("uses repository when available", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const storage = createMemoryStorage();
      const task = makeTask("repo-task");
      await saveScheduledTasksToDatabase(database, [task], "2026-05-28T10:00:00.000Z");
      const repository = createScheduledTasksRepository(database);

      const loaded = await loadScheduledTasksWithStorageFallback(
        repository,
        storage,
      );

      expect(loaded).toEqual([task]);
    });

    it("falls back to localStorage when repository is null", async () => {
      const storage = createMemoryStorage();
      const task = makeTask("storage-task");
      storage.setItem(
        SCHEDULED_TASKS_STORAGE_KEY,
        JSON.stringify({ version: 1, tasks: [task] }),
      );

      const loaded = await loadScheduledTasksWithStorageFallback(null, storage);

      expect(loaded).toEqual([task]);
    });

    it("falls back to localStorage when repository is undefined", async () => {
      const storage = createMemoryStorage();
      const task = makeTask("storage-task");
      storage.setItem(
        SCHEDULED_TASKS_STORAGE_KEY,
        JSON.stringify({ version: 1, tasks: [task] }),
      );

      const loaded = await loadScheduledTasksWithStorageFallback(
        undefined,
        storage,
      );

      expect(loaded).toEqual([task]);
    });

    it("falls back to localStorage when repository.list throws", async () => {
      const storage = createMemoryStorage();
      const task = makeTask("fallback-task");
      storage.setItem(
        SCHEDULED_TASKS_STORAGE_KEY,
        JSON.stringify({ version: 1, tasks: [task] }),
      );
      const failingRepository = {
        async list(): Promise<ScheduledTask[]> {
          throw new Error("database unavailable");
        },
      };

      const loaded = await loadScheduledTasksWithStorageFallback(
        failingRepository,
        storage,
      );

      expect(loaded).toEqual([task]);
    });
  });

  describe("createScheduledTasksRepository", () => {
    it("list returns all tasks from the database", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const tasks = [makeTask("task-1"), makeTask("task-2")];
      await saveScheduledTasksToDatabase(
        database,
        tasks,
        "2026-05-28T10:00:00.000Z",
      );

      expect(await repository.list()).toEqual(tasks);
    });

    it("save replaces all tasks", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const first = makeTask("task-1");
      const second = makeTask("task-2");

      await repository.save([first]);
      expect(await repository.list()).toEqual([first]);

      await repository.save([second]);
      expect(await repository.list()).toEqual([second]);
    });

    it("upsert inserts a new task when it does not exist", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const task = makeTask("new-task");

      const result = await repository.upsert(task);

      expect(result).toEqual([task]);
      expect(await repository.list()).toEqual([task]);
    });

    it("upsert replaces an existing task with the same id", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const original = makeTask("task-1", { name: "Original" });
      const updated = makeTask("task-1", { name: "Updated" });

      await repository.save([original]);
      const result = await repository.upsert(updated);

      expect(result).toEqual([updated]);
      expect(await repository.list()).toEqual([updated]);
    });

    it("upsert preserves other tasks when replacing", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const taskA = makeTask("task-a");
      const taskB = makeTask("task-b");
      const updatedA = makeTask("task-a", { name: "Updated A" });

      await repository.save([taskA, taskB]);
      const result = await repository.upsert(updatedA);

      expect(result).toHaveLength(2);
      expect(result.find((t) => t.id === "task-a")?.name).toBe("Updated A");
      expect(result.find((t) => t.id === "task-b")).toEqual(taskB);
    });

    it("remove deletes the task with the given id", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const taskA = makeTask("task-a");
      const taskB = makeTask("task-b");

      await repository.save([taskA, taskB]);
      const result = await repository.remove("task-a");

      expect(result).toEqual([taskB]);
      expect(await repository.list()).toEqual([taskB]);
    });

    it("remove is a no-op when the id does not exist", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const task = makeTask("task-1");

      await repository.save([task]);
      const result = await repository.remove("nonexistent");

      expect(result).toEqual([task]);
    });

    it("importFromLocalStorage delegates to importScheduledTasksFromLocalStorage", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const repository = createScheduledTasksRepository(database);
      const storage = createMemoryStorage();
      const task = makeTask("imported");
      storage.setItem(
        SCHEDULED_TASKS_STORAGE_KEY,
        JSON.stringify({ version: 1, tasks: [task] }),
      );

      const imported = await repository.importFromLocalStorage(storage);

      expect(imported).toEqual([task]);
      expect(await repository.list()).toEqual([task]);
      expect(storage.getItem(SCHEDULED_TASKS_STORAGE_KEY)).toBeNull();
    });
  });

  describe("round-trip", () => {
    it("save then load preserves all ScheduledTask fields", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const task: ScheduledTask = {
        id: "round-trip-task",
        name: "Daily backup",
        goal: "Back up the project directory",
        workspacePath: "E:/Javis",
        schedule: { type: "daily", value: "09:30" },
        enabled: true,
        lastRunAt: "2026-05-27T09:30:00.000Z",
        lastRunStartedAt: "2026-05-27T09:30:00.000Z",
        nextRunAt: "2026-05-28T09:30:00.000Z",
        createdAt: "2026-05-20T00:00:00.000Z",
        source: "user",
      };

      await saveScheduledTasksToDatabase(database, [task], now);
      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(task);
    });

    it("save then load preserves disabled tasks", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const task: ScheduledTask = {
        id: "disabled-task",
        name: "Paused task",
        goal: "This task is paused",
        workspacePath: "E:/Javis",
        schedule: { type: "interval", value: "3600000" },
        enabled: false,
        nextRunAt: "2026-05-28T11:00:00.000Z",
        createdAt: "2026-05-20T00:00:00.000Z",
        source: "agent",
      };

      await saveScheduledTasksToDatabase(database, [task], now);
      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded[0]?.enabled).toBe(false);
      expect(loaded[0]?.source).toBe("agent");
    });

    it("save then load preserves all schedule types", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const tasks: ScheduledTask[] = [
        makeTask("interval", { schedule: { type: "interval", value: "60000" } }),
        makeTask("daily", { schedule: { type: "daily", value: "14:00" } }),
        makeTask("weekly", { schedule: { type: "weekly", value: "Mon 09:00" } }),
        makeTask("once", { schedule: { type: "once", value: "2026-06-01T00:00:00.000Z" } }),
      ];

      await saveScheduledTasksToDatabase(database, tasks, now);
      const loaded = await loadScheduledTasksFromDatabase(database);

      expect(loaded.find((t) => t.id === "interval")?.schedule).toEqual({
        type: "interval",
        value: "60000",
      });
      expect(loaded.find((t) => t.id === "daily")?.schedule).toEqual({
        type: "daily",
        value: "14:00",
      });
      expect(loaded.find((t) => t.id === "weekly")?.schedule).toEqual({
        type: "weekly",
        value: "Mon 09:00",
      });
      expect(loaded.find((t) => t.id === "once")?.schedule).toEqual({
        type: "once",
        value: "2026-06-01T00:00:00.000Z",
      });
    });

    it("multiple save-load cycles maintain data integrity", async () => {
      const database = createMemoryScheduledTasksDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const tasks = [
        makeTask("task-1", { name: "First" }),
        makeTask("task-2", { name: "Second" }),
      ];

      await saveScheduledTasksToDatabase(database, tasks, now);
      const loaded1 = await loadScheduledTasksFromDatabase(database);

      await saveScheduledTasksToDatabase(database, loaded1, now);
      const loaded2 = await loadScheduledTasksFromDatabase(database);

      expect(loaded2).toEqual(loaded1);
      expect(loaded2).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StoredScheduledTaskRow extends Record<string, unknown> {
  id: string;
  name: string;
  goal: string;
  workspace_path: string;
  schedule_type: string;
  schedule_value: string;
  enabled: number;
  last_run_at: string | null;
  last_run_started_at: string | null;
  next_run_at: string;
  created_at: string;
  source: string;
  updated_at: string;
}

function createMemoryScheduledTasksDatabase() {
  const rows = new Map<string, StoredScheduledTaskRow>();
  const database = {
    rows,
    async execute(sql: string, values: DatabaseValue[] = []) {
      if (sql.startsWith("DELETE FROM scheduled_tasks")) {
        rows.clear();
        return;
      }
      if (sql.startsWith("INSERT INTO scheduled_tasks")) {
        const row: StoredScheduledTaskRow = {
          id: String(values[0]),
          name: String(values[1]),
          goal: String(values[2]),
          workspace_path: String(values[3]),
          schedule_type: String(values[4]),
          schedule_value: String(values[5]),
          enabled: Number(values[6]),
          last_run_at: values[7] as string | null,
          last_run_started_at: values[8] as string | null,
          next_run_at: String(values[9]),
          created_at: String(values[10]),
          source: String(values[11]),
          updated_at: String(values[12]),
        };
        rows.set(row.id, row);
      }
    },
    async select<T extends Record<string, unknown>>(
      sql: string,
    ): Promise<T[]> {
      if (sql.includes("FROM scheduled_tasks")) {
        return [...rows.values()]
          .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))
          .map((row) => ({ ...row }) as unknown as T);
      }
      return [];
    },
  };
  return database;
}

function makeTask(
  id: string,
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask {
  return {
    id,
    name: `Task ${id}`,
    goal: `Goal for ${id}`,
    workspacePath: "E:/Javis",
    schedule: { type: "interval", value: "3600000" },
    enabled: true,
    nextRunAt: "2026-05-28T11:00:00.000Z",
    createdAt: "2026-05-28T00:00:00.000Z",
    source: "user",
    ...overrides,
  };
}

function createMemoryStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
