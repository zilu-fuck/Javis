import { describe, expect, it } from "vitest";
import { createDryRunBindingHash } from "@javis/core";
import type { DryRunSummary } from "@javis/tools";
import {
  APPROVAL_RECORDS_LIMIT,
  APPROVAL_RECORDS_STORAGE_KEY,
  APPROVAL_RECORDS_STORAGE_VERSION,
  expireApprovalRecord,
  isTerminalApprovalRecord,
  markApprovalExecutionStarted,
  markApprovalExecutionSucceeded,
  resolveApprovalRecord,
  sanitizeApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";
import {
  APPROVAL_RECORDS_ADD_RUN_ID_SQL,
  APPROVAL_RECORDS_CREATE_EXPIRATION_INDEX_SQL,
  APPROVAL_RECORDS_CREATE_STATUS_INDEX_SQL,
  APPROVAL_RECORDS_CREATE_TABLE_SQL,
  APPROVAL_RECORDS_MIGRATIONS,
  createApprovalRecordsRepository,
  ensureApprovalRecordsSchema,
  importApprovalRecordsFromLocalStorage,
  loadApprovalRecordsFromDatabase,
  loadApprovalRecordsWithStorageFallback,
  saveApprovalRecordsToDatabase,
  upsertApprovalRecordInDatabase,
  type ApprovalRecordsDatabase,
} from "./approval-records-persistence";
import type { DatabaseValue } from "./desktop-database";

describe("approval records persistence", () => {
  it("exports SQLite-ready schema and migration constants", async () => {
    const database = createMemoryApprovalDatabase();

    await ensureApprovalRecordsSchema(database);

    expect(APPROVAL_RECORDS_CREATE_TABLE_SQL).toContain("CREATE TABLE IF NOT EXISTS approval_records");
    expect(APPROVAL_RECORDS_CREATE_TABLE_SQL).toContain("approval_id TEXT PRIMARY KEY");
    expect(APPROVAL_RECORDS_CREATE_TABLE_SQL).toContain("run_id TEXT");
    expect(APPROVAL_RECORDS_ADD_RUN_ID_SQL).toBe("ALTER TABLE approval_records ADD COLUMN run_id TEXT");
    expect(APPROVAL_RECORDS_CREATE_STATUS_INDEX_SQL).toContain("status, tool_name");
    expect(APPROVAL_RECORDS_CREATE_EXPIRATION_INDEX_SQL).toContain("expires_at");
    expect(APPROVAL_RECORDS_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "approval-records-v1-table",
      "approval-records-v2-run-id",
      "approval-records-v1-status-index",
      "approval-records-v1-expiration-index",
    ]);
    expect(database.executedSql).toEqual([
      APPROVAL_RECORDS_CREATE_TABLE_SQL,
      APPROVAL_RECORDS_ADD_RUN_ID_SQL,
      APPROVAL_RECORDS_CREATE_STATUS_INDEX_SQL,
      APPROVAL_RECORDS_CREATE_EXPIRATION_INDEX_SQL,
    ]);
  });

  it("upserts sanitized records and loads newest records first", async () => {
    const database = createMemoryApprovalDatabase();
    const older = createApprovalRecord("approval-older", "2026-05-24T00:00:00.000Z", "run-older");
    const newer = createApprovalRecord("approval-newer", "2026-05-24T00:01:00.000Z", "run-newer");

    await upsertApprovalRecordInDatabase(database, older, "2026-05-24T00:02:00.000Z");
    await upsertApprovalRecordInDatabase(database, newer, "2026-05-24T00:03:00.000Z");
    await upsertApprovalRecordInDatabase(
      database,
      { ...older, workspacePath: "E:/Updated" },
      "2026-05-24T00:04:00.000Z",
    );

    expect(await loadApprovalRecordsFromDatabase(database)).toEqual([
      { ...newer, permissionRequest: newer.permissionRequest },
      { ...older, workspacePath: "E:/Updated" },
    ]);
    expect(database.rows.get("approval-older")?.updated_at).toBe("2026-05-24T00:04:00.000Z");
  });

  it("skips malformed rows and limits only terminal approval history", async () => {
    const database = createMemoryApprovalDatabase();
    const records = Array.from({ length: APPROVAL_RECORDS_LIMIT + 2 }, (_, index) =>
      expireApprovalRecord(
        createApprovalRecord(
          `approval-${index}`,
          `2026-05-24T00:${String(index).padStart(2, "0")}:00.000Z`,
        ),
        "2026-05-24T00:59:00.000Z",
      ),
    );
    const approved = resolveApprovalRecord(
      createApprovalRecord("approval-active-approved", "2026-05-24T00:30:00.000Z"),
      "approved",
      "2026-05-24T00:31:00.000Z",
    );
    const started = markApprovalExecutionStarted(
      resolveApprovalRecord(
        createApprovalRecord("approval-active-started", "2026-05-24T00:32:00.000Z"),
        "approved",
        "2026-05-24T00:33:00.000Z",
      ),
      undefined,
    );
    const succeeded = markApprovalExecutionSucceeded(
      markApprovalExecutionStarted(
        resolveApprovalRecord(
          createApprovalRecord("approval-active-succeeded", "2026-05-24T00:34:00.000Z"),
          "approved",
          "2026-05-24T00:35:00.000Z",
        ),
        undefined,
      ),
      { status: "applied" },
    );
    const continuationSource = markApprovalExecutionSucceeded(
      markApprovalExecutionStarted(
        resolveApprovalRecord(
          createApprovalRecord("approval-active-continuation", "2026-05-24T00:36:00.000Z"),
          "approved",
          "2026-05-24T00:37:00.000Z",
        ),
        undefined,
      ),
      { status: "applied" },
    );
    const continuation: DurableApprovalRecord = {
      ...continuationSource,
      execution: {
        ...continuationSource.execution!,
        status: "continuation_pending",
      },
    };
    const active = [
      createApprovalRecord("approval-active-pending", "2026-05-24T00:29:00.000Z"),
      approved,
      started,
      succeeded,
      continuation,
    ];

    await saveApprovalRecordsToDatabase(database, [...records, ...active], "2026-05-24T01:00:00.000Z");
    database.rows.set("malformed", {
      approval_id: "malformed",
      created_at: "2026-05-23T23:00:00.000Z",
      record_json: "{\"approvalId\":",
      updated_at: "2026-05-24T02:00:00.000Z",
    });

    const loaded = await loadApprovalRecordsFromDatabase(database);

    expect(loaded.filter(isTerminalApprovalRecord)).toHaveLength(APPROVAL_RECORDS_LIMIT);
    expect(loaded).toHaveLength(APPROVAL_RECORDS_LIMIT + active.length);
    expect(loaded).toEqual(expect.arrayContaining(active));
    expect(loaded.some((record) => record.approvalId === "malformed")).toBe(false);
    expect(database.rows.has("approval-0")).toBe(false);
    expect(database.rows.has("approval-1")).toBe(false);
    expect(database.executedSql[database.executedSql.length - 1]).toContain("LIMIT -1 OFFSET ?");
  });

  it("provides an async repository wrapper for approval records", async () => {
    const repository = createApprovalRecordsRepository(createMemoryApprovalDatabase());
    const record = createApprovalRecord("approval-repository");

    await repository.upsert(record);

    expect(await repository.list()).toEqual([record]);
    expect(await repository.save([resolveApprovalRecord(record, "denied", "2026-05-24T00:05:00.000Z")]))
      .toEqual([
        resolveApprovalRecord(record, "denied", "2026-05-24T00:05:00.000Z"),
      ]);
  });

  it("imports existing localStorage approval records into the database", async () => {
    const database = createMemoryApprovalDatabase();
    const storage = createMemoryStorage();
    const pending = createApprovalRecord("approval-pending");
    const approved = resolveApprovalRecord(
      createApprovalRecord("approval-approved", "2026-05-24T00:01:00.000Z"),
      "approved",
      "2026-05-24T00:02:00.000Z",
    );
    storage.setItem(
      APPROVAL_RECORDS_STORAGE_KEY,
      JSON.stringify({
        version: APPROVAL_RECORDS_STORAGE_VERSION,
        records: [pending, approved],
      }),
    );

    const imported = await importApprovalRecordsFromLocalStorage(
      database,
      storage,
      "2026-05-24T00:03:00.000Z",
    );

    expect(imported).toEqual([pending, approved]);
    expect(await loadApprovalRecordsFromDatabase(database)).toEqual([approved, pending]);
    expect(storage.getItem(APPROVAL_RECORDS_STORAGE_KEY)).toBeNull();
  });

  it("falls back to localStorage when the database is unavailable", async () => {
    const storage = createMemoryStorage();
    const record = createApprovalRecord();
    storage.setItem(
      APPROVAL_RECORDS_STORAGE_KEY,
      JSON.stringify({
        version: APPROVAL_RECORDS_STORAGE_VERSION,
        records: [record],
      }),
    );
    const failingDatabase: ApprovalRecordsDatabase = {
      async execute() {
        throw new Error("unavailable");
      },
      async select() {
        throw new Error("unavailable");
      },
    };

    await expect(loadApprovalRecordsWithStorageFallback(null, storage)).resolves.toEqual([record]);
    await expect(loadApprovalRecordsWithStorageFallback(failingDatabase, storage)).resolves.toEqual([record]);
  });
});

interface StoredApprovalRecordRow extends Record<string, unknown> {
  approval_id: string;
  created_at: string;
  run_id?: unknown;
  record_json: string;
  updated_at: string;
}

function createMemoryApprovalDatabase() {
  const executedSql: string[] = [];
  const rows = new Map<string, StoredApprovalRecordRow>();
  const database: ApprovalRecordsDatabase & {
    executedSql: string[];
    rows: Map<string, StoredApprovalRecordRow>;
  } = {
    executedSql,
    rows,
    async execute(sql: string, values: DatabaseValue[] = []) {
      executedSql.push(sql);
      if (sql.startsWith("INSERT INTO approval_records")) {
        const row = createStoredRow(values);
        rows.set(row.approval_id, row);
      }
      if (sql.startsWith("DELETE FROM approval_records")) {
        const limit = Number(values[0]);
        const terminalRows = [...rows.values()]
          .filter((row) => {
            const record = sanitizeApprovalRecord(JSON.parse(row.record_json));
            return record ? isTerminalApprovalRecord(record) : false;
          })
            .sort((left, right) => right.created_at.localeCompare(left.created_at))
            .slice(limit);
        for (const row of terminalRows) {
          rows.delete(row.approval_id);
        }
      }
    },
    async select<T extends Record<string, unknown>>(
      sql: string,
      values: DatabaseValue[] = [],
    ): Promise<T[]> {
      if (!sql.startsWith("SELECT record_json")) {
        return [];
      }
      const limit = typeof values[0] === "number" ? values[0] : Number.POSITIVE_INFINITY;
      return [...rows.values()]
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map((row) => ({ record_json: row.record_json }) as unknown as T);
    },
  };
  return database;
}

function createStoredRow(values: DatabaseValue[]): StoredApprovalRecordRow {
  return {
    approval_id: String(values[0]),
    task_id: values[1],
    run_id: values[2],
    tool_name: values[3],
    workspace_path: values[4],
    permission_level: values[5],
    preview_hash: values[6],
    expires_at: values[7],
    status: values[8],
    created_at: String(values[9]),
    resolved_at: values[10],
    decision: values[11],
    permission_request_json: values[12],
    code_proposed_edit_json: values[13],
    record_json: String(values[14]),
    updated_at: String(values[15]),
  };
}

function createApprovalRecord(
  approvalId = "approval-1",
  createdAt = "2026-05-24T00:00:00.000Z",
  runId?: string,
): DurableApprovalRecord {
  const minute = createdAt.slice(14, 16);
  const dryRun: DryRunSummary = {
    operation: "Organize PDF files by filename topic",
    affectedPaths: [
      {
        source: "C:/Users/example/Downloads/a.pdf",
        target: "C:/Users/example/Downloads/Documents/a.pdf",
        action: "move",
      },
    ],
    riskSummary: "Preview only.",
    reversible: true,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId,
    taskId: "task-1",
    ...(runId ? { runId } : {}),
    toolName: "file.executePdfOrganization",
    workspacePath: "C:/Users/example/Downloads",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: `2026-05-24T00:${minute}:30.000Z`,
    status: "pending",
    createdAt,
    permissionRequest: {
      id: approvalId,
      level: "confirmed_write",
      title: "Approve PDF move plan",
      reason: "Moving files changes the local filesystem, so Javis needs explicit approval.",
      bindingHash,
      status: "pending",
      createdAt,
      dryRun,
    },
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
