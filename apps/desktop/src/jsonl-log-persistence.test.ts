import { describe, expect, it } from "vitest";
import type { DatabaseValue } from "./desktop-database";
import {
  JSONL_LOG_MIGRATIONS,
  createSqliteTaskSessionWriter,
  createSqliteToolCallAuditWriter,
  importTaskSessionJsonlFromLocalStorage,
  importToolCallAuditJsonlFromLocalStorage,
} from "./jsonl-log-persistence";
import { TASK_SESSION_JSONL_STORAGE_KEY } from "./task-session-log";
import { TASK_AUDIT_JSONL_STORAGE_KEY } from "./tool-call-audit";

// ---------------------------------------------------------------------------
// In-memory database mock
// ---------------------------------------------------------------------------

interface SessionLogRow {
  id: number;
  task_id: string;
  recorded_at: string;
  snapshot_json: string;
}

interface AuditLogRow {
  id: number;
  task_id: string;
  recorded_at: string;
  entry_json: string;
}

function createMemoryJsonlLogDatabase() {
  let nextSessionId = 1;
  let nextAuditId = 1;
  const sessionRows: SessionLogRow[] = [];
  const auditRows: AuditLogRow[] = [];
  const executedSql: string[] = [];

  const database = {
    sessionRows,
    auditRows,
    executedSql,

    async execute(sql: string, values: DatabaseValue[] = []) {
      executedSql.push(sql);

      if (sql.includes("INSERT INTO task_session_log")) {
        sessionRows.push({
          id: nextSessionId++,
          task_id: String(values[0]),
          recorded_at: String(values[1]),
          snapshot_json: String(values[2]),
        });
      }

      if (sql.includes("INSERT INTO tool_call_audit_log")) {
        auditRows.push({
          id: nextAuditId++,
          task_id: String(values[0]),
          recorded_at: String(values[1]),
          entry_json: String(values[2]),
        });
      }
    },

    async select<T extends Record<string, unknown>>(
      sql: string,
      _values: DatabaseValue[] = [],
    ): Promise<T[]> {
      if (sql.includes("FROM task_session_log")) {
        return sessionRows.map(
          (row) =>
            ({
              task_id: row.task_id,
              recorded_at: row.recorded_at,
              snapshot_json: row.snapshot_json,
            }) as unknown as T,
        );
      }

      if (sql.includes("FROM tool_call_audit_log")) {
        return auditRows.map(
          (row) =>
            ({
              task_id: row.task_id,
              recorded_at: row.recorded_at,
              entry_json: row.entry_json,
            }) as unknown as T,
        );
      }

      return [];
    },
  };

  return database;
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSessionSnapshotLine(taskId = "task-1", recordedAt = "2026-05-28T10:00:00.000Z") {
  return JSON.stringify({
    kind: "task_session_snapshot",
    recordedAt,
    taskId,
    snapshot: {
      id: taskId,
      title: `Title for ${taskId}`,
      userGoal: "Test goal",
      status: "running",
      commanderMessage: "Working on it",
      plan: [],
      agents: [],
      logs: [],
    },
  });
}

function makeAuditLine(
  taskId = "task-1",
  recordId = "audit-1",
  recordedAt = "2026-05-28T10:00:00.000Z",
) {
  return JSON.stringify({
    kind: "tool_call_audit",
    recordedAt,
    record: {
      id: recordId,
      taskId,
      toolName: "code.inspectRepository",
      permissionLevel: "preview",
      status: "succeeded",
      inputSummary: "Inspecting repository",
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("jsonl log persistence", () => {
  describe("JSONL_LOG_MIGRATIONS", () => {
    it("exports four migration entries with expected IDs", () => {
      expect(JSONL_LOG_MIGRATIONS.map((m) => m.id)).toEqual([
        "task-session-log-v1-table",
        "task-session-log-v1-task-index",
        "tool-call-audit-log-v1-table",
        "tool-call-audit-log-v1-task-index",
      ]);
    });

    it("includes CREATE TABLE and CREATE INDEX statements", () => {
      const sqls = JSONL_LOG_MIGRATIONS.map((m) => m.sql);
      expect(sqls[0]).toContain("CREATE TABLE IF NOT EXISTS task_session_log");
      expect(sqls[1]).toContain("CREATE INDEX IF NOT EXISTS idx_task_session_log_task_id");
      expect(sqls[2]).toContain("CREATE TABLE IF NOT EXISTS tool_call_audit_log");
      expect(sqls[3]).toContain("CREATE INDEX IF NOT EXISTS idx_tool_call_audit_log_task_id");
    });
  });

  describe("createSqliteTaskSessionWriter", () => {
    it("inserts a parsed JSON line into task_session_log", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteTaskSessionWriter(database);
      const line = makeSessionSnapshotLine("task-42", "2026-05-28T12:00:00.000Z");

      await writer.appendLine(`${line}\n`);

      expect(database.sessionRows).toHaveLength(1);
      expect(database.sessionRows[0].task_id).toBe("task-42");
      expect(database.sessionRows[0].recorded_at).toBe("2026-05-28T12:00:00.000Z");

      const parsed = JSON.parse(database.sessionRows[0].snapshot_json);
      expect(parsed.kind).toBe("task_session_snapshot");
      expect(parsed.taskId).toBe("task-42");
    });

    it("stores redacted task session snapshots", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteTaskSessionWriter(database);
      const line = JSON.stringify({
        kind: "task_session_snapshot",
        recordedAt: "2026-05-28T12:00:00.000Z",
        taskId: "task-image",
        snapshot: {
          id: "task-image",
          title: "Image task",
          userGoal: "Describe data:image/png;base64,AA==",
          status: "running",
          commanderMessage: "Saw data:image/png;base64,BB==",
          plan: [],
          agents: [],
          logs: [
            {
              id: "log-1",
              kind: "event",
              title: "image.received",
              detail: "detail data:image/png;base64,CC==",
            },
          ],
          conversationMessages: [
            {
              role: "user",
              content: "content data:image/png;base64,DD==",
              attachments: ["data:image/png;base64,EE=="],
            },
          ],
        },
      });

      await writer.appendLine(`${line}\n`);

      expect(database.sessionRows[0].snapshot_json).not.toContain("data:image");
      expect(database.sessionRows[0].snapshot_json).not.toContain("attachments");
      const parsed = JSON.parse(database.sessionRows[0].snapshot_json);
      expect(parsed.snapshot.userGoal).toContain("[redacted image data URL]");
    });

    it("stores task session snapshots with redacted local vision paths", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteTaskSessionWriter(database);
      const line = JSON.stringify({
        kind: "task_session_snapshot",
        recordedAt: "2026-05-28T12:00:00.000Z",
        taskId: "task-local-vision",
        snapshot: {
          id: "task-local-vision",
          title: "Local vision task",
          userGoal: String.raw`Use C:\Users\alice\Models\yolo26n-ui.onnx`,
          status: "running",
          commanderMessage: "Checked models/adapters/yolo26-ui.mjs and packages/core/src/index.js",
          plan: [],
          agents: [],
          logs: [
            {
              id: "log-1",
              kind: "tool",
              title: "computer.detectUiObjects",
              detail: "adapter /home/alice/.cache/javis/runtime-adapter.mjs failed",
            },
          ],
        },
      });

      await writer.appendLine(`${line}\n`);

      const persisted = database.sessionRows[0].snapshot_json;
      expect(persisted).toContain("[redacted local path:yolo26n-ui.onnx]");
      expect(persisted).toContain("[redacted local path:yolo26-ui.mjs]");
      expect(persisted).toContain("[redacted local path:runtime-adapter.mjs]");
      expect(persisted).toContain("packages/core/src/index.js");
      expect(persisted).not.toContain("alice");
      expect(persisted).not.toContain("C:\\Users");
      expect(persisted).not.toContain("/home/alice");
    });

    it("inserts multiple lines when the JSONL string contains multiple entries", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteTaskSessionWriter(database);
      const line1 = makeSessionSnapshotLine("task-a", "2026-05-28T10:00:00.000Z");
      const line2 = makeSessionSnapshotLine("task-b", "2026-05-28T11:00:00.000Z");

      await writer.appendLine(`${line1}\n${line2}\n`);

      expect(database.sessionRows).toHaveLength(2);
      expect(database.sessionRows[0].task_id).toBe("task-a");
      expect(database.sessionRows[1].task_id).toBe("task-b");
    });

    it("silently skips malformed lines", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteTaskSessionWriter(database);
      const valid = makeSessionSnapshotLine("task-valid");
      const malformed = JSON.stringify({ kind: "garbage" });

      await writer.appendLine(`${valid}\n${malformed}\n`);

      expect(database.sessionRows).toHaveLength(1);
      expect(database.sessionRows[0].task_id).toBe("task-valid");
    });
  });

  describe("createSqliteToolCallAuditWriter", () => {
    it("inserts a parsed JSON line into tool_call_audit_log", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteToolCallAuditWriter(database);
      const line = makeAuditLine("task-99", "audit-xyz", "2026-05-28T14:00:00.000Z");

      await writer.appendLine(`${line}\n`);

      expect(database.auditRows).toHaveLength(1);
      expect(database.auditRows[0].task_id).toBe("task-99");
      expect(database.auditRows[0].recorded_at).toBe("2026-05-28T14:00:00.000Z");

      const parsed = JSON.parse(database.auditRows[0].entry_json);
      expect(parsed.kind).toBe("tool_call_audit");
      expect(parsed.record.id).toBe("audit-xyz");
    });

    it("stores audit entries with redacted local vision paths", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteToolCallAuditWriter(database);
      const line = JSON.stringify({
        kind: "tool_call_audit",
        recordedAt: "2026-05-28T14:00:00.000Z",
        record: {
          id: "audit-local-vision",
          taskId: "task-local-vision",
          toolName: "computer.detectUiObjects",
          permissionLevel: "read",
          status: "succeeded",
          inputSummary: String.raw`modelPath=C:\Users\alice\Models\yolo26n-ui.onnx runtimeAdapterPath=models\adapters\yolo26-ui.mjs`,
          outputSummary: "adapter /home/alice/.cache/javis/runtime-adapter.mjs failed; source packages/core/src/index.js stayed visible",
        },
      });

      await writer.appendLine(`${line}\n`);

      const persisted = database.auditRows[0].entry_json;
      expect(persisted).toContain("[redacted local path:yolo26n-ui.onnx]");
      expect(persisted).toContain("[redacted local path:yolo26-ui.mjs]");
      expect(persisted).toContain("[redacted local path:runtime-adapter.mjs]");
      expect(persisted).toContain("packages/core/src/index.js");
      expect(persisted).not.toContain("alice");
      expect(persisted).not.toContain("C:\\Users");
      expect(persisted).not.toContain("/home/alice");
    });

    it("inserts multiple audit entries from a multi-line JSONL string", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteToolCallAuditWriter(database);
      const line1 = makeAuditLine("task-1", "audit-1", "2026-05-28T10:00:00.000Z");
      const line2 = makeAuditLine("task-1", "audit-2", "2026-05-28T10:01:00.000Z");

      await writer.appendLine(`${line1}\n${line2}\n`);

      expect(database.auditRows).toHaveLength(2);
      expect(database.auditRows[0].task_id).toBe("task-1");
      expect(database.auditRows[1].task_id).toBe("task-1");
    });

    it("silently skips malformed audit lines", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteToolCallAuditWriter(database);
      const valid = makeAuditLine("task-ok", "audit-ok");
      const malformed = JSON.stringify({ kind: "garbage", recordedAt: "now" });

      await writer.appendLine(`${valid}\n${malformed}\n`);

      expect(database.auditRows).toHaveLength(1);
    });
  });

  describe("importTaskSessionJsonlFromLocalStorage", () => {
    it("parses localStorage JSONL, inserts into SQLite, and removes the key", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      const line1 = makeSessionSnapshotLine("task-1", "2026-05-28T10:00:00.000Z");
      const line2 = makeSessionSnapshotLine("task-2", "2026-05-28T11:00:00.000Z");
      storage.setItem(TASK_SESSION_JSONL_STORAGE_KEY, `${line1}\n${line2}\n`);

      const count = await importTaskSessionJsonlFromLocalStorage(database, storage);

      expect(count).toBe(2);
      expect(database.sessionRows).toHaveLength(2);
      expect(database.sessionRows[0].task_id).toBe("task-1");
      expect(database.sessionRows[1].task_id).toBe("task-2");
      expect(storage.getItem(TASK_SESSION_JSONL_STORAGE_KEY)).toBeNull();
    });

    it("returns 0 and does nothing when localStorage has no legacy value", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();

      const count = await importTaskSessionJsonlFromLocalStorage(database, storage);

      expect(count).toBe(0);
      expect(database.sessionRows).toHaveLength(0);
    });

    it("filters out malformed lines during import", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      const valid = makeSessionSnapshotLine("task-good");
      const malformed = JSON.stringify({ kind: "garbage" });
      storage.setItem(
        TASK_SESSION_JSONL_STORAGE_KEY,
        `${valid}\n${malformed}\n`,
      );

      const count = await importTaskSessionJsonlFromLocalStorage(database, storage);

      expect(count).toBe(1);
      expect(database.sessionRows).toHaveLength(1);
      expect(database.sessionRows[0].task_id).toBe("task-good");
      expect(storage.getItem(TASK_SESSION_JSONL_STORAGE_KEY)).toBeNull();
    });

    it("removes legacy key even when no valid lines are found", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      storage.setItem(TASK_SESSION_JSONL_STORAGE_KEY, "not-valid-json\n");

      const count = await importTaskSessionJsonlFromLocalStorage(database, storage);

      expect(count).toBe(0);
      expect(database.sessionRows).toHaveLength(0);
      expect(storage.getItem(TASK_SESSION_JSONL_STORAGE_KEY)).toBeNull();
    });
  });

  describe("importToolCallAuditJsonlFromLocalStorage", () => {
    it("parses localStorage JSONL, inserts into SQLite, and removes the key", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      const line1 = makeAuditLine("task-1", "audit-1", "2026-05-28T10:00:00.000Z");
      const line2 = makeAuditLine("task-2", "audit-2", "2026-05-28T11:00:00.000Z");
      storage.setItem(TASK_AUDIT_JSONL_STORAGE_KEY, `${line1}\n${line2}\n`);

      const count = await importToolCallAuditJsonlFromLocalStorage(database, storage);

      expect(count).toBe(2);
      expect(database.auditRows).toHaveLength(2);
      expect(database.auditRows[0].task_id).toBe("task-1");
      expect(database.auditRows[1].task_id).toBe("task-2");
      expect(storage.getItem(TASK_AUDIT_JSONL_STORAGE_KEY)).toBeNull();
    });

    it("returns 0 and does nothing when localStorage has no legacy value", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();

      const count = await importToolCallAuditJsonlFromLocalStorage(database, storage);

      expect(count).toBe(0);
      expect(database.auditRows).toHaveLength(0);
    });

    it("filters out malformed lines during import", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      const valid = makeAuditLine("task-good", "audit-good");
      const malformed = JSON.stringify({ kind: "garbage" });
      storage.setItem(
        TASK_AUDIT_JSONL_STORAGE_KEY,
        `${valid}\n${malformed}\n`,
      );

      const count = await importToolCallAuditJsonlFromLocalStorage(database, storage);

      expect(count).toBe(1);
      expect(database.auditRows).toHaveLength(1);
      expect(database.auditRows[0].task_id).toBe("task-good");
      expect(storage.getItem(TASK_AUDIT_JSONL_STORAGE_KEY)).toBeNull();
    });

    it("removes legacy key even when no valid lines are found", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      storage.setItem(TASK_AUDIT_JSONL_STORAGE_KEY, "not-valid-json\n");

      const count = await importToolCallAuditJsonlFromLocalStorage(database, storage);

      expect(count).toBe(0);
      expect(database.auditRows).toHaveLength(0);
      expect(storage.getItem(TASK_AUDIT_JSONL_STORAGE_KEY)).toBeNull();
    });
  });

  describe("round-trip", () => {
    it("write then read back preserves task session data", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteTaskSessionWriter(database);
      const line = makeSessionSnapshotLine("task-rt", "2026-05-28T15:00:00.000Z");

      await writer.appendLine(`${line}\n`);

      const rows = await database.select<{
        task_id: string;
        recorded_at: string;
        snapshot_json: string;
      }>(`SELECT task_id, recorded_at, snapshot_json FROM task_session_log`);

      expect(rows).toHaveLength(1);
      expect(rows[0].task_id).toBe("task-rt");
      expect(rows[0].recorded_at).toBe("2026-05-28T15:00:00.000Z");

      const parsed = JSON.parse(rows[0].snapshot_json);
      expect(parsed.kind).toBe("task_session_snapshot");
      expect(parsed.snapshot.userGoal).toBe("Test goal");
    });

    it("write then read back preserves tool call audit data", async () => {
      const database = createMemoryJsonlLogDatabase();
      const writer = createSqliteToolCallAuditWriter(database);
      const line = makeAuditLine("task-rt", "audit-rt", "2026-05-28T15:00:00.000Z");

      await writer.appendLine(`${line}\n`);

      const rows = await database.select<{
        task_id: string;
        recorded_at: string;
        entry_json: string;
      }>(`SELECT task_id, recorded_at, entry_json FROM tool_call_audit_log`);

      expect(rows).toHaveLength(1);
      expect(rows[0].task_id).toBe("task-rt");
      expect(rows[0].recorded_at).toBe("2026-05-28T15:00:00.000Z");

      const parsed = JSON.parse(rows[0].entry_json);
      expect(parsed.kind).toBe("tool_call_audit");
      expect(parsed.record.id).toBe("audit-rt");
    });

    it("localStorage import then read back preserves all session entries", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      const lines = [
        makeSessionSnapshotLine("task-1", "2026-05-28T10:00:00.000Z"),
        makeSessionSnapshotLine("task-1", "2026-05-28T10:01:00.000Z"),
        makeSessionSnapshotLine("task-2", "2026-05-28T10:02:00.000Z"),
      ];
      storage.setItem(TASK_SESSION_JSONL_STORAGE_KEY, lines.join("\n") + "\n");

      await importTaskSessionJsonlFromLocalStorage(database, storage);

      const rows = await database.select<{
        task_id: string;
        recorded_at: string;
        snapshot_json: string;
      }>(`SELECT task_id, recorded_at, snapshot_json FROM task_session_log`);

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.task_id)).toEqual(["task-1", "task-1", "task-2"]);
      expect(rows.map((r) => r.recorded_at)).toEqual([
        "2026-05-28T10:00:00.000Z",
        "2026-05-28T10:01:00.000Z",
        "2026-05-28T10:02:00.000Z",
      ]);
    });

    it("localStorage import then read back preserves all audit entries", async () => {
      const database = createMemoryJsonlLogDatabase();
      const storage = createMemoryStorage();
      const lines = [
        makeAuditLine("task-1", "audit-a", "2026-05-28T10:00:00.000Z"),
        makeAuditLine("task-1", "audit-b", "2026-05-28T10:01:00.000Z"),
        makeAuditLine("task-2", "audit-c", "2026-05-28T10:02:00.000Z"),
      ];
      storage.setItem(TASK_AUDIT_JSONL_STORAGE_KEY, lines.join("\n") + "\n");

      await importToolCallAuditJsonlFromLocalStorage(database, storage);

      const rows = await database.select<{
        task_id: string;
        recorded_at: string;
        entry_json: string;
      }>(`SELECT task_id, recorded_at, entry_json FROM tool_call_audit_log`);

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.task_id)).toEqual(["task-1", "task-1", "task-2"]);
      expect(rows.map((r) => JSON.parse(r.entry_json).record.id)).toEqual([
        "audit-a",
        "audit-b",
        "audit-c",
      ]);
    });
  });
});
