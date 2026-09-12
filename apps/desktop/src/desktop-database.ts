import type { RuntimeEventEnvelope } from "@javis/core";

export interface RuntimeHistoryMaintenanceRequest {
  keepLatestPerTask: number;
  keepLatestCheckpointsPerTask: number;
  cutoffIso: string;
  vacuum: boolean;
}

export interface RuntimeHistoryMaintenanceReport {
  deletedSessionRows: number;
  remainingSessionRows: number;
  deletedCheckpointRows: number;
  remainingCheckpointRows: number;
  reclaimedBytes: number;
  vacuumed: boolean;
  databaseBytes: number;
}

export interface DesktopDatabase {
  execute(sql: string, bindValues?: DatabaseValue[]): Promise<void>;
  select<T extends Record<string, unknown>>(
    sql: string,
    bindValues?: DatabaseValue[],
  ): Promise<T[]>;
  /**
   * Atomically replaces selected streaming events with compaction envelopes.
   * Native implementations perform the whole mutation in one SQLite transaction.
   */
  compactRuntimeEvents?(
    taskId: string,
    eventIds: string[],
    compactionEnvelopes: RuntimeEventEnvelope[],
  ): Promise<void>;
  /**
   * Bounds the append-heavy runtime history: keeps the newest task session rows
   * and workflow checkpoints per task, drops history older than the cutoff (never
   * a task's newest row or a checkpoint whose run still has an approval record),
   * and optionally VACUUMs the database file once enough pages are free.
   *
   * Native-only by design: the generic `db_execute` channel accepts a fixed list
   * of statement shapes and refuses VACUUM.
   */
  maintainRuntimeHistory?(
    request: RuntimeHistoryMaintenanceRequest,
  ): Promise<RuntimeHistoryMaintenanceReport>;
}

export type DatabaseValue = string | number | boolean | null;

export interface DesktopDatabaseMigration {
  id: string;
  sql: string;
  ignoreDuplicateColumn?: boolean;
}

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function directInvoke(
  command: string,
  args?: Record<string, unknown>,
  moduleInvoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const internals = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  if (internals.__TAURI_INTERNALS__?.invoke) {
    return internals.__TAURI_INTERNALS__.invoke(command, args ?? {});
  }
  if (moduleInvoke) {
    return moduleInvoke(command, args);
  }
  throw new Error("Tauri IPC not ready - __TAURI_INTERNALS__ missing");
}

async function retryInvoke(
  command: string,
  args?: Record<string, unknown>,
  moduleInvoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  maxRetries = 150,
  delayMs = 100,
): Promise<unknown> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await directInvoke(command, args, moduleInvoke);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

export function invokeDesktopDatabase(
  moduleInvoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): DesktopDatabase {
  return {
    async execute(sql, bindValues = []) {
      const approvalRecordCommand = approvalRecordWriteCommand(sql, bindValues);
      if (approvalRecordCommand) {
        await retryInvoke(approvalRecordCommand.command, approvalRecordCommand.args, moduleInvoke);
        return;
      }
      const resourceScanRootCommand = resourceScanRootWriteCommand(sql, bindValues);
      if (resourceScanRootCommand) {
        await retryInvoke(resourceScanRootCommand.command, resourceScanRootCommand.args, moduleInvoke);
        return;
      }
      await retryInvoke("db_execute", { sql, bindValues }, moduleInvoke);
    },
    async select<T extends Record<string, unknown>>(sql: string, bindValues: DatabaseValue[] = []) {
      const resourceScanRootCommand = resourceScanRootSelectCommand(sql, bindValues);
      if (resourceScanRootCommand) {
        const rows = await retryInvoke(resourceScanRootCommand.command, resourceScanRootCommand.args, moduleInvoke);
        return (rows as T[]) ?? [];
      }
      const rows = await retryInvoke("db_select", { sql, bindValues }, moduleInvoke);
      return (rows as T[]) ?? [];
    },
    async compactRuntimeEvents(taskId, eventIds, compactionEnvelopes) {
      await directInvoke("runtime_events_compact", {
        request: { taskId, eventIds, compactionEnvelopes },
      }, moduleInvoke);
    },
    async maintainRuntimeHistory(request) {
      const report = await directInvoke(
        "runtime_history_maintain",
        { request },
        moduleInvoke,
      );
      return parseRuntimeHistoryMaintenanceReport(report);
    },
  };
}

function parseRuntimeHistoryMaintenanceReport(value: unknown): RuntimeHistoryMaintenanceReport {
  const record = isRecord(value) ? value : {};
  return {
    deletedSessionRows: toFiniteNumber(record.deletedSessionRows),
    remainingSessionRows: toFiniteNumber(record.remainingSessionRows),
    deletedCheckpointRows: toFiniteNumber(record.deletedCheckpointRows),
    remainingCheckpointRows: toFiniteNumber(record.remainingCheckpointRows),
    reclaimedBytes: toFiniteNumber(record.reclaimedBytes),
    vacuumed: record.vacuumed === true,
    databaseBytes: toFiniteNumber(record.databaseBytes),
  };
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvalRecordWriteCommand(
  sql: string,
  bindValues: DatabaseValue[],
): { command: string; args: Record<string, unknown> } | undefined {
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    normalized.startsWith("insert into approval_records") &&
    normalized.includes("on conflict(approval_id) do update set")
  ) {
    if (bindValues.length !== 16) {
      throw new Error("Approval record upsert expected 16 bind values.");
    }
    return {
      command: "approval_records_upsert",
      args: {
        request: {
          approvalId: String(bindValues[0] ?? ""),
          taskId: String(bindValues[1] ?? ""),
          runId: bindValues[2] === null ? null : String(bindValues[2] ?? ""),
          toolName: String(bindValues[3] ?? ""),
          workspacePath: String(bindValues[4] ?? ""),
          permissionLevel: String(bindValues[5] ?? ""),
          previewHash: String(bindValues[6] ?? ""),
          expiresAt: String(bindValues[7] ?? ""),
          status: String(bindValues[8] ?? ""),
          createdAt: String(bindValues[9] ?? ""),
          resolvedAt: bindValues[10] === null ? null : String(bindValues[10] ?? ""),
          decision: bindValues[11] === null ? null : String(bindValues[11] ?? ""),
          permissionRequestJson: String(bindValues[12] ?? ""),
          codeProposedEditJson: bindValues[13] === null ? null : String(bindValues[13] ?? ""),
          recordJson: String(bindValues[14] ?? ""),
          updatedAt: String(bindValues[15] ?? ""),
        },
      },
    };
  }
  if (
    normalized.startsWith("delete from approval_records") &&
    normalized.includes("where approval_id in") &&
    normalized.includes("json_extract(record_json, '$.execution.status')") &&
    normalized.includes("order by created_at desc, approval_id desc") &&
    normalized.includes("limit -1 offset ?")
  ) {
    if (bindValues.length !== 1 || typeof bindValues[0] !== "number") {
      throw new Error("Approval record prune expected a numeric limit.");
    }
    return {
      command: "approval_records_prune",
      args: { limit: bindValues[0] },
    };
  }
  return undefined;
}

function resourceScanRootSelectCommand(
  sql: string,
  bindValues: DatabaseValue[],
): { command: string; args: Record<string, unknown> } | undefined {
  if (bindValues.length !== 0) return undefined;
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized === "select * from resource_scan_roots order by source desc, created_at asc") {
    return { command: "resource_scan_roots_list", args: { enabledOnly: false } };
  }
  if (normalized === "select * from resource_scan_roots where enabled = 1 order by source desc, created_at asc") {
    return { command: "resource_scan_roots_list", args: { enabledOnly: true } };
  }
  return undefined;
}

function resourceScanRootWriteCommand(
  sql: string,
  bindValues: DatabaseValue[],
): { command: string; args: Record<string, unknown> } | undefined {
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    normalized.startsWith("insert or replace into resource_scan_roots") &&
    normalized.includes("(id, path, label, kinds_json, enabled, source, created_at)") &&
    normalized.includes("values (?, ?, ?, ?, ?, ?, ?)")
  ) {
    if (bindValues.length !== 7) {
      throw new Error("Resource scan root upsert expected 7 bind values.");
    }
    return {
      command: "resource_scan_roots_upsert",
      args: {
        request: {
          id: String(bindValues[0] ?? ""),
          path: String(bindValues[1] ?? ""),
          label: bindValues[2] === null ? null : String(bindValues[2] ?? ""),
          kinds: parseResourceKinds(bindValues[3]),
          enabled: bindValues[4] === true || bindValues[4] === 1,
          source: String(bindValues[5] ?? ""),
          createdAt: String(bindValues[6] ?? ""),
        },
      },
    };
  }
  if (normalized === "delete from resource_scan_roots where id = ?") {
    if (bindValues.length !== 1) {
      throw new Error("Resource scan root delete expected 1 bind value.");
    }
    return {
      command: "resource_scan_roots_delete",
      args: { id: String(bindValues[0] ?? "") },
    };
  }
  if (normalized === "update resource_scan_roots set enabled = ? where id = ?") {
    if (bindValues.length !== 2) {
      throw new Error("Resource scan root enabled update expected 2 bind values.");
    }
    return {
      command: "resource_scan_roots_set_enabled",
      args: {
        enabled: bindValues[0] === true || bindValues[0] === 1,
        id: String(bindValues[1] ?? ""),
      },
    };
  }
  return undefined;
}

function parseResourceKinds(value: DatabaseValue): string[] {
  if (typeof value !== "string") {
    throw new Error("Resource scan root kinds_json must be a string.");
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Resource scan root kinds_json must be a string array.");
  }
  return parsed;
}

export async function runDesktopDatabaseMigrations(
  database: DesktopDatabase,
  migrations: DesktopDatabaseMigration[],
): Promise<void> {
  await database.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  const appliedRows = await database.select<{ id: string }>(
    "SELECT id FROM schema_migrations",
  );
  const appliedIds = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }
    try {
      await database.execute(migration.sql);
    } catch (error) {
      if (!migration.ignoreDuplicateColumn || !isDuplicateColumnError(error)) {
        throw error;
      }
    }
    await database.execute(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      [migration.id, new Date().toISOString()],
    );
  }
}

function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}
