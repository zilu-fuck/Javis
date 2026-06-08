export interface DesktopDatabase {
  execute(sql: string, bindValues?: DatabaseValue[]): Promise<void>;
  select<T extends Record<string, unknown>>(
    sql: string,
    bindValues?: DatabaseValue[],
  ): Promise<T[]>;
}

export type DatabaseValue = string | number | boolean | null;

export interface DesktopDatabaseMigration {
  id: string;
  sql: string;
}

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function directInvoke(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const internals = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  if (!internals.__TAURI_INTERNALS__?.invoke) {
    throw new Error("Tauri IPC not ready - __TAURI_INTERNALS__ missing");
  }
  return internals.__TAURI_INTERNALS__.invoke(command, args ?? {});
}

async function retryInvoke(
  command: string,
  args?: Record<string, unknown>,
  maxRetries = 150,
  delayMs = 100,
): Promise<unknown> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await directInvoke(command, args);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

export function invokeDesktopDatabase(
  _moduleInvoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): DesktopDatabase {
  return {
    async execute(sql, bindValues = []) {
      const approvalRecordCommand = approvalRecordWriteCommand(sql, bindValues);
      if (approvalRecordCommand) {
        await retryInvoke(approvalRecordCommand.command, approvalRecordCommand.args);
        return;
      }
      const resourceScanRootCommand = resourceScanRootWriteCommand(sql, bindValues);
      if (resourceScanRootCommand) {
        await retryInvoke(resourceScanRootCommand.command, resourceScanRootCommand.args);
        return;
      }
      await retryInvoke("db_execute", { sql, bindValues });
    },
    async select<T extends Record<string, unknown>>(sql: string, bindValues: DatabaseValue[] = []) {
      const resourceScanRootCommand = resourceScanRootSelectCommand(sql, bindValues);
      if (resourceScanRootCommand) {
        const rows = await retryInvoke(resourceScanRootCommand.command, resourceScanRootCommand.args);
        return (rows as T[]) ?? [];
      }
      const rows = await retryInvoke("db_select", { sql, bindValues });
      return (rows as T[]) ?? [];
    },
  };
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
    if (bindValues.length !== 15) {
      throw new Error("Approval record upsert expected 15 bind values.");
    }
    return {
      command: "approval_records_upsert",
      args: {
        request: {
          approvalId: String(bindValues[0] ?? ""),
          taskId: String(bindValues[1] ?? ""),
          toolName: String(bindValues[2] ?? ""),
          workspacePath: String(bindValues[3] ?? ""),
          permissionLevel: String(bindValues[4] ?? ""),
          previewHash: String(bindValues[5] ?? ""),
          expiresAt: String(bindValues[6] ?? ""),
          status: String(bindValues[7] ?? ""),
          createdAt: String(bindValues[8] ?? ""),
          resolvedAt: bindValues[9] === null ? null : String(bindValues[9] ?? ""),
          decision: bindValues[10] === null ? null : String(bindValues[10] ?? ""),
          permissionRequestJson: String(bindValues[11] ?? ""),
          codeProposedEditJson: bindValues[12] === null ? null : String(bindValues[12] ?? ""),
          recordJson: String(bindValues[13] ?? ""),
          updatedAt: String(bindValues[14] ?? ""),
        },
      },
    };
  }
  if (
    normalized.startsWith("delete from approval_records") &&
    normalized.includes("where approval_id not in") &&
    normalized.includes("order by created_at desc") &&
    normalized.includes("limit ?")
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
    await database.execute(migration.sql);
    await database.execute(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      [migration.id, new Date().toISOString()],
    );
  }
}
