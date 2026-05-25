import {
  APPROVAL_RECORDS_LIMIT,
  loadApprovalRecords,
  sanitizeApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";
import type { DatabaseValue, DesktopDatabaseMigration } from "./desktop-database";

export interface ApprovalRecordsDatabase {
  execute(sql: string, bindValues?: DatabaseValue[]): Promise<void>;
  select<T extends Record<string, unknown>>(
    sql: string,
    bindValues?: DatabaseValue[],
  ): Promise<T[]>;
}

type ApprovalRecordStorage = Pick<Storage, "getItem" | "setItem">;

export interface ApprovalRecordsRepository {
  list(): Promise<DurableApprovalRecord[]>;
  save(records: DurableApprovalRecord[]): Promise<DurableApprovalRecord[]>;
  upsert(record: DurableApprovalRecord): Promise<DurableApprovalRecord | null>;
  importFromLocalStorage(storage: ApprovalRecordStorage): Promise<DurableApprovalRecord[]>;
}

export const APPROVAL_RECORDS_CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS approval_records (
  approval_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  permission_level TEXT NOT NULL CHECK (permission_level IN ('preview', 'confirmed_write')),
  preview_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approved', 'denied')),
  permission_request_json TEXT NOT NULL,
  code_proposed_edit_json TEXT,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`.trim();

export const APPROVAL_RECORDS_CREATE_STATUS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS approval_records_status_tool_idx
ON approval_records (status, tool_name, created_at DESC)`.trim();

export const APPROVAL_RECORDS_CREATE_EXPIRATION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS approval_records_expiration_idx
ON approval_records (expires_at)`.trim();

export const APPROVAL_RECORDS_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    id: "approval-records-v1-table",
    sql: APPROVAL_RECORDS_CREATE_TABLE_SQL,
  },
  {
    id: "approval-records-v1-status-index",
    sql: APPROVAL_RECORDS_CREATE_STATUS_INDEX_SQL,
  },
  {
    id: "approval-records-v1-expiration-index",
    sql: APPROVAL_RECORDS_CREATE_EXPIRATION_INDEX_SQL,
  },
];

const SELECT_APPROVAL_RECORDS_SQL = `
SELECT record_json
FROM approval_records
ORDER BY created_at DESC
LIMIT ?`.trim();

const UPSERT_APPROVAL_RECORD_SQL = `
INSERT INTO approval_records (
  approval_id,
  task_id,
  tool_name,
  workspace_path,
  permission_level,
  preview_hash,
  expires_at,
  status,
  created_at,
  resolved_at,
  decision,
  permission_request_json,
  code_proposed_edit_json,
  record_json,
  updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(approval_id) DO UPDATE SET
  task_id = excluded.task_id,
  tool_name = excluded.tool_name,
  workspace_path = excluded.workspace_path,
  permission_level = excluded.permission_level,
  preview_hash = excluded.preview_hash,
  expires_at = excluded.expires_at,
  status = excluded.status,
  created_at = excluded.created_at,
  resolved_at = excluded.resolved_at,
  decision = excluded.decision,
  permission_request_json = excluded.permission_request_json,
  code_proposed_edit_json = excluded.code_proposed_edit_json,
  record_json = excluded.record_json,
  updated_at = excluded.updated_at`.trim();

const DELETE_OVER_LIMIT_SQL = `
DELETE FROM approval_records
WHERE approval_id NOT IN (
  SELECT approval_id
  FROM approval_records
  ORDER BY created_at DESC
  LIMIT ?
)`.trim();

export async function ensureApprovalRecordsSchema(
  database: ApprovalRecordsDatabase,
): Promise<void> {
  for (const migration of APPROVAL_RECORDS_MIGRATIONS) {
    await database.execute(migration.sql);
  }
}

export function createApprovalRecordsRepository(
  database: ApprovalRecordsDatabase,
): ApprovalRecordsRepository {
  return {
    async list() {
      return loadApprovalRecordsFromDatabase(database);
    },

    async save(records) {
      return saveApprovalRecordsToDatabase(database, records);
    },

    async upsert(record) {
      return upsertApprovalRecordInDatabase(database, record);
    },

    async importFromLocalStorage(storage) {
      return importApprovalRecordsFromLocalStorage(database, storage);
    },
  };
}

export async function loadApprovalRecordsFromDatabase(
  database: ApprovalRecordsDatabase,
): Promise<DurableApprovalRecord[]> {
  const rows = await database.select<{ record_json: unknown }>(
    SELECT_APPROVAL_RECORDS_SQL,
    [APPROVAL_RECORDS_LIMIT],
  );
  return rows
    .map((row) => parsePersistedApprovalRecord(row.record_json))
    .filter((record): record is DurableApprovalRecord => Boolean(record))
    .slice(0, APPROVAL_RECORDS_LIMIT);
}

export async function upsertApprovalRecordInDatabase(
  database: ApprovalRecordsDatabase,
  record: DurableApprovalRecord,
  updatedAt = new Date().toISOString(),
): Promise<DurableApprovalRecord | null> {
  const sanitized = sanitizeApprovalRecord(record);
  if (!sanitized) {
    return null;
  }
  await database.execute(UPSERT_APPROVAL_RECORD_SQL, bindApprovalRecord(sanitized, updatedAt));
  await database.execute(DELETE_OVER_LIMIT_SQL, [APPROVAL_RECORDS_LIMIT]);
  return sanitized;
}

export async function saveApprovalRecordsToDatabase(
  database: ApprovalRecordsDatabase,
  records: DurableApprovalRecord[],
  updatedAt = new Date().toISOString(),
): Promise<DurableApprovalRecord[]> {
  const saved: DurableApprovalRecord[] = [];
  for (const record of records) {
    const sanitized = await upsertApprovalRecordInDatabase(database, record, updatedAt);
    if (sanitized) {
      saved.push(sanitized);
    }
  }
  return saved.slice(0, APPROVAL_RECORDS_LIMIT);
}

export async function importApprovalRecordsFromLocalStorage(
  database: ApprovalRecordsDatabase,
  storage: ApprovalRecordStorage,
  updatedAt = new Date().toISOString(),
): Promise<DurableApprovalRecord[]> {
  const records = loadApprovalRecords(storage);
  return saveApprovalRecordsToDatabase(database, records, updatedAt);
}

export async function loadApprovalRecordsWithStorageFallback(
  database: ApprovalRecordsDatabase | null | undefined,
  storage: ApprovalRecordStorage,
): Promise<DurableApprovalRecord[]> {
  if (!database) {
    return loadApprovalRecords(storage);
  }
  try {
    return await loadApprovalRecordsFromDatabase(database);
  } catch {
    return loadApprovalRecords(storage);
  }
}

function bindApprovalRecord(
  record: DurableApprovalRecord,
  updatedAt: string,
): DatabaseValue[] {
  return [
    record.approvalId,
    record.taskId,
    record.toolName,
    record.workspacePath,
    record.permissionLevel,
    record.previewHash,
    record.expiresAt,
    record.status,
    record.createdAt,
    record.resolvedAt ?? null,
    record.decision ?? null,
    JSON.stringify(record.permissionRequest),
    record.codeProposedEdit ? JSON.stringify(record.codeProposedEdit) : null,
    JSON.stringify(record),
    updatedAt,
  ];
}

function parsePersistedApprovalRecord(value: unknown): DurableApprovalRecord | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return sanitizeApprovalRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
