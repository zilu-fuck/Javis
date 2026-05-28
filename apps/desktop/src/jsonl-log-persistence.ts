import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import {
  type TaskSessionJsonLineWriter,
  parseTaskSessionJsonLines,
  TASK_SESSION_JSONL_STORAGE_KEY,
} from "./task-session-log";
import {
  type ToolCallAuditJsonLineWriter,
  parseTaskAuditJsonLines,
  TASK_AUDIT_JSONL_STORAGE_KEY,
} from "./tool-call-audit";

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const TASK_SESSION_LOG_TABLE_MIGRATION: DesktopDatabaseMigration = {
  id: "task-session-log-v1-table",
  sql: `
CREATE TABLE IF NOT EXISTS task_session_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
)`.trim(),
};

const TASK_SESSION_LOG_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "task-session-log-v1-task-index",
  sql: `
CREATE INDEX IF NOT EXISTS idx_task_session_log_task_id
ON task_session_log (task_id)`.trim(),
};

const TOOL_CALL_AUDIT_LOG_TABLE_MIGRATION: DesktopDatabaseMigration = {
  id: "tool-call-audit-log-v1-table",
  sql: `
CREATE TABLE IF NOT EXISTS tool_call_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  entry_json TEXT NOT NULL
)`.trim(),
};

const TOOL_CALL_AUDIT_LOG_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "tool-call-audit-log-v1-task-index",
  sql: `
CREATE INDEX IF NOT EXISTS idx_tool_call_audit_log_task_id
ON tool_call_audit_log (task_id)`.trim(),
};

export const JSONL_LOG_MIGRATIONS: DesktopDatabaseMigration[] = [
  TASK_SESSION_LOG_TABLE_MIGRATION,
  TASK_SESSION_LOG_INDEX_MIGRATION,
  TOOL_CALL_AUDIT_LOG_TABLE_MIGRATION,
  TOOL_CALL_AUDIT_LOG_INDEX_MIGRATION,
];

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

const INSERT_TASK_SESSION_LOG_SQL = `
INSERT INTO task_session_log (task_id, recorded_at, snapshot_json)
VALUES (?, ?, ?)`.trim();

const INSERT_TOOL_CALL_AUDIT_LOG_SQL = `
INSERT INTO tool_call_audit_log (task_id, recorded_at, entry_json)
VALUES (?, ?, ?)`.trim();

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export function createSqliteTaskSessionWriter(
  database: Pick<DesktopDatabase, "execute">,
): TaskSessionJsonLineWriter {
  return {
    async appendLine(line: string): Promise<void> {
      const parsed = parseTaskSessionJsonLines(line);
      for (const entry of parsed) {
        await database.execute(INSERT_TASK_SESSION_LOG_SQL, [
          entry.taskId,
          entry.recordedAt,
          JSON.stringify(entry),
        ]);
      }
    },
  };
}

export function createSqliteToolCallAuditWriter(
  database: Pick<DesktopDatabase, "execute">,
): ToolCallAuditJsonLineWriter {
  return {
    async appendLine(line: string): Promise<void> {
      const parsed = parseTaskAuditJsonLines(line);
      for (const entry of parsed) {
        await database.execute(INSERT_TOOL_CALL_AUDIT_LOG_SQL, [
          entry.record.taskId,
          entry.recordedAt,
          JSON.stringify(entry),
        ]);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// localStorage migration
// ---------------------------------------------------------------------------

type MigrationStorage = Pick<Storage, "getItem" | "removeItem">;

export async function importTaskSessionJsonlFromLocalStorage(
  database: Pick<DesktopDatabase, "execute">,
  storage: MigrationStorage,
): Promise<number> {
  const raw = storage.getItem(TASK_SESSION_JSONL_STORAGE_KEY);
  if (!raw) {
    return 0;
  }

  const entries = parseTaskSessionJsonLines(raw);
  await database.execute("BEGIN TRANSACTION");
  try {
    for (const entry of entries) {
      await database.execute(INSERT_TASK_SESSION_LOG_SQL, [
        entry.taskId,
        entry.recordedAt,
        JSON.stringify(entry),
      ]);
    }
    await database.execute("COMMIT");
  } catch (error) {
    await database.execute("ROLLBACK");
    throw error;
  }

  try {
    storage.removeItem(TASK_SESSION_JSONL_STORAGE_KEY);
  } catch {
    // Legacy cleanup should not block startup.
  }

  return entries.length;
}

export async function importToolCallAuditJsonlFromLocalStorage(
  database: Pick<DesktopDatabase, "execute">,
  storage: MigrationStorage,
): Promise<number> {
  const raw = storage.getItem(TASK_AUDIT_JSONL_STORAGE_KEY);
  if (!raw) {
    return 0;
  }

  const entries = parseTaskAuditJsonLines(raw);
  await database.execute("BEGIN TRANSACTION");
  try {
    for (const entry of entries) {
      await database.execute(INSERT_TOOL_CALL_AUDIT_LOG_SQL, [
        entry.record.taskId,
        entry.recordedAt,
        JSON.stringify(entry),
      ]);
    }
    await database.execute("COMMIT");
  } catch (error) {
    await database.execute("ROLLBACK");
    throw error;
  }

  try {
    storage.removeItem(TASK_AUDIT_JSONL_STORAGE_KEY);
  } catch {
    // Legacy cleanup should not block startup.
  }

  return entries.length;
}
