import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import type { ScheduledTask, ScheduleSpec } from "./scheduled-tasks";
import { loadScheduledTasks } from "./scheduled-tasks";

export const SCHEDULED_TASKS_STORAGE_KEY = "javis.scheduledTasks.v1";

export const SCHEDULED_TASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_run_started_at TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`.trim();

export const SCHEDULED_TASKS_NEXT_RUN_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
ON scheduled_tasks (next_run_at ASC)
`.trim();

export const SCHEDULED_TASKS_TABLE_MIGRATION: DesktopDatabaseMigration = {
  id: "scheduled-tasks-v1-table",
  sql: SCHEDULED_TASKS_TABLE_SQL,
};

export const SCHEDULED_TASKS_NEXT_RUN_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "scheduled-tasks-v1-next-run-index",
  sql: SCHEDULED_TASKS_NEXT_RUN_INDEX_SQL,
};

export const SCHEDULED_TASKS_MIGRATIONS: DesktopDatabaseMigration[] = [
  SCHEDULED_TASKS_TABLE_MIGRATION,
  SCHEDULED_TASKS_NEXT_RUN_INDEX_MIGRATION,
];

type ScheduledTasksMigrationStorage = Pick<Storage, "getItem" | "removeItem">;

export interface ScheduledTasksRepository {
  list(): Promise<ScheduledTask[]>;
  save(tasks: ScheduledTask[]): Promise<ScheduledTask[]>;
  upsert(task: ScheduledTask): Promise<ScheduledTask[]>;
  remove(id: string): Promise<ScheduledTask[]>;
  importFromLocalStorage(storage: ScheduledTasksMigrationStorage): Promise<ScheduledTask[]>;
}

export function createScheduledTasksRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): ScheduledTasksRepository {
  return {
    async list() {
      return loadScheduledTasksFromDatabase(database);
    },

    async save(tasks) {
      return saveScheduledTasksToDatabase(database, tasks);
    },

    async upsert(task) {
      const current = await loadScheduledTasksFromDatabase(database);
      const index = current.findIndex((t) => t.id === task.id);
      const next = index >= 0
        ? [...current.slice(0, index), task, ...current.slice(index + 1)]
        : [...current, task];
      return saveScheduledTasksToDatabase(database, next);
    },

    async remove(id) {
      const current = await loadScheduledTasksFromDatabase(database);
      const next = current.filter((t) => t.id !== id);
      return saveScheduledTasksToDatabase(database, next);
    },

    async importFromLocalStorage(storage) {
      return importScheduledTasksFromLocalStorage(database, storage);
    },
  };
}

export async function loadScheduledTasksFromDatabase(
  database: Pick<DesktopDatabase, "select">,
): Promise<ScheduledTask[]> {
  const rows = await database.select<ScheduledTaskRow>(
    `SELECT id, name, goal, workspace_path, schedule_type, schedule_value,
            enabled, last_run_at, last_run_started_at, next_run_at,
            created_at, source, updated_at
     FROM scheduled_tasks
     ORDER BY next_run_at ASC`,
  );
  return rows.map(rowToScheduledTask);
}

export async function saveScheduledTasksToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  tasks: ScheduledTask[],
  updatedAt = new Date().toISOString(),
): Promise<ScheduledTask[]> {
  await database.execute(`DELETE FROM scheduled_tasks`);
  for (const task of tasks) {
    const row = scheduledTaskToRow(task, updatedAt);
    await database.execute(
      `INSERT INTO scheduled_tasks
       (id, name, goal, workspace_path, schedule_type, schedule_value,
        enabled, last_run_at, last_run_started_at, next_run_at,
        created_at, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row,
    );
  }
  return tasks;
}

export async function importScheduledTasksFromLocalStorage(
  database: Pick<DesktopDatabase, "execute" | "select">,
  storage: ScheduledTasksMigrationStorage,
  updatedAt = new Date().toISOString(),
): Promise<ScheduledTask[]> {
  const hasLegacyValue = storage.getItem(SCHEDULED_TASKS_STORAGE_KEY) !== null;
  const legacyTasks = loadScheduledTasks(storage as Storage);

  if (legacyTasks.length > 0) {
    const saved = await saveScheduledTasksToDatabase(database, legacyTasks, updatedAt);
    removeLegacyStorage(storage);
    return saved;
  }

  const currentTasks = await loadScheduledTasksFromDatabase(database);
  if (hasLegacyValue) {
    removeLegacyStorage(storage);
  }
  return currentTasks;
}

export async function loadScheduledTasksWithStorageFallback(
  repository: Pick<ScheduledTasksRepository, "list"> | null | undefined,
  storage: Pick<Storage, "getItem">,
): Promise<ScheduledTask[]> {
  if (!repository) {
    return loadScheduledTasks(storage as Storage);
  }
  try {
    return await repository.list();
  } catch {
    return loadScheduledTasks(storage as Storage);
  }
}

type ScheduledTaskRow = Record<string, unknown> & {
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
};

function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    workspacePath: row.workspace_path,
    schedule: {
      type: row.schedule_type as ScheduleSpec["type"],
      value: row.schedule_value,
    },
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunStartedAt: row.last_run_started_at ?? undefined,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    source: row.source as ScheduledTask["source"],
  };
}

function scheduledTaskToRow(
  task: ScheduledTask,
  updatedAt: string,
): DatabaseValue[] {
  return [
    task.id,
    task.name,
    task.goal,
    task.workspacePath,
    task.schedule.type,
    task.schedule.value,
    task.enabled ? 1 : 0,
    task.lastRunAt ?? null,
    task.lastRunStartedAt ?? null,
    task.nextRunAt,
    task.createdAt,
    task.source,
    updatedAt,
  ];
}

function removeLegacyStorage(storage: ScheduledTasksMigrationStorage): void {
  try {
    storage.removeItem(SCHEDULED_TASKS_STORAGE_KEY);
  } catch {
    // Legacy cleanup should not block startup.
  }
}
