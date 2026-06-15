// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  invokeDesktopDatabase,
  runDesktopDatabaseMigrations,
  type DatabaseValue,
  type DesktopDatabase,
} from "./desktop-database";

describe("desktop database migrations", () => {
  it("runs unapplied migrations once", async () => {
    const database = createMemoryDatabase(["existing"]);

    await runDesktopDatabaseMigrations(database, [
      { id: "existing", sql: "CREATE TABLE existing_table (id TEXT)" },
      { id: "next", sql: "CREATE TABLE next_table (id TEXT)" },
    ]);

    expect(database.executedSql).toEqual([
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      "CREATE TABLE next_table (id TEXT)",
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    ]);
    expect(database.bindValues[0]).toEqual(["next", expect.any(String)]);
  });

  it("uses the module invoke when Tauri internals are not ready", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    const invoke = vi.fn(async (command: string) => {
      if (command === "db_select") {
        return [{ id: "existing" }];
      }
      return undefined;
    });
    const database = invokeDesktopDatabase(invoke);

    const rows = await database.select("SELECT id FROM schema_migrations");
    await database.execute(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      ["next", "2026-06-14T00:00:00.000Z"],
    );

    expect(rows).toEqual([{ id: "existing" }]);
    expect(invoke).toHaveBeenNthCalledWith(1, "db_select", {
      sql: "SELECT id FROM schema_migrations",
      bindValues: [],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "db_execute", {
      sql: "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      bindValues: ["next", "2026-06-14T00:00:00.000Z"],
    });
  });

  it("routes approval record writes through dedicated native commands", async () => {
    const invoke = vi.fn(async () => undefined);
    (window as any).__TAURI_INTERNALS__ = { invoke };
    const database = invokeDesktopDatabase(vi.fn());
    const record = createApprovalRecordJson();

    await database.execute(
      `INSERT INTO approval_records
        (approval_id, task_id, tool_name, workspace_path, permission_level, preview_hash, expires_at, status, created_at, resolved_at, decision, permission_request_json, code_proposed_edit_json, record_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(approval_id) DO UPDATE SET record_json = excluded.record_json`,
      [
        "approval-1",
        "task-1",
        "file.writeText",
        "E:/Javis",
        "confirmed_write",
        "hash-1",
        "2026-06-08T00:10:00.000Z",
        "pending",
        "2026-06-08T00:00:00.000Z",
        null,
        null,
        JSON.stringify(record.permissionRequest),
        null,
        JSON.stringify(record),
        "2026-06-08T00:00:01.000Z",
      ],
    );
    await database.execute(
      `DELETE FROM approval_records
       WHERE approval_id NOT IN (
         SELECT approval_id
         FROM approval_records
         ORDER BY created_at DESC
         LIMIT ?
       )`,
      [20],
    );

    expect(invoke).toHaveBeenNthCalledWith(1, "approval_records_upsert", expect.objectContaining({
      request: expect.objectContaining({ approvalId: "approval-1", recordJson: JSON.stringify(record) }),
    }));
    expect(invoke).toHaveBeenNthCalledWith(2, "approval_records_prune", { limit: 20 });
    expect(invoke).not.toHaveBeenCalledWith("db_execute", expect.anything());
  });

  it("routes resource scan root access through dedicated native commands", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "resource_scan_roots_list") {
        return [{
          id: "custom-1",
          path: "C:/Users/me/Documents",
          label: null,
          kinds_json: "[\"documents\"]",
          enabled: true,
          source: "custom",
          created_at: "2026-06-08T00:00:00.000Z",
        }];
      }
      return undefined;
    });
    (window as any).__TAURI_INTERNALS__ = { invoke };
    const database = invokeDesktopDatabase(vi.fn());

    await database.execute(
      `INSERT OR REPLACE INTO resource_scan_roots
         (id, path, label, kinds_json, enabled, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "custom-1",
        "C:/Users/me/Documents",
        null,
        "[\"documents\"]",
        1,
        "custom",
        "2026-06-08T00:00:00.000Z",
      ],
    );
    await database.execute("UPDATE resource_scan_roots SET enabled = ? WHERE id = ?", [0, "custom-1"]);
    await database.execute("DELETE FROM resource_scan_roots WHERE id = ?", ["custom-1"]);
    const rows = await database.select("SELECT * FROM resource_scan_roots ORDER BY source DESC, created_at ASC");

    expect(invoke).toHaveBeenNthCalledWith(1, "resource_scan_roots_upsert", expect.objectContaining({
      request: expect.objectContaining({ id: "custom-1", kinds: ["documents"] }),
    }));
    expect(invoke).toHaveBeenNthCalledWith(2, "resource_scan_roots_set_enabled", {
      enabled: false,
      id: "custom-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "resource_scan_roots_delete", { id: "custom-1" });
    expect(invoke).toHaveBeenNthCalledWith(4, "resource_scan_roots_list", { enabledOnly: false });
    expect(rows).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("db_execute", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("db_select", expect.anything());
  });
});

function createApprovalRecordJson() {
  return {
    approvalId: "approval-1",
    taskId: "task-1",
    toolName: "file.writeText",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: "hash-1",
    expiresAt: "2026-06-08T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-08T00:00:00.000Z",
    permissionRequest: {
      id: "approval-1",
      level: "confirmed_write",
      title: "Write file",
      reason: "User requested a write.",
      dryRun: {
        operation: "Write text file",
        affectedPaths: [{ source: "", target: "notes.md", action: "create" }],
        riskSummary: "Creates a file.",
        reversible: true,
      },
      bindingHash: "hash-1",
      status: "pending",
      createdAt: "2026-06-08T00:00:00.000Z",
    },
  };
}

function createMemoryDatabase(appliedIds: string[]) {
  const executedSql: string[] = [];
  const bindValues: DatabaseValue[][] = [];
  const database: DesktopDatabase & {
    executedSql: string[];
    bindValues: DatabaseValue[][];
  } = {
    executedSql,
    bindValues,
    async execute(sql, values = []) {
      executedSql.push(sql);
      if (values.length > 0) {
        bindValues.push(values);
      }
    },
    async select<T extends Record<string, unknown>>() {
      return appliedIds.map((id) => ({ id }) as unknown as T);
    },
  };
  return database;
}
