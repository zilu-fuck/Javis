import { describe, expect, it } from "vitest";
import {
  TOOL_CALL_AUDIT_MIGRATIONS,
  appendToolCallAuditJsonLine,
  appendTaskSnapshotAuditJsonLines,
  createFileBackedTaskAuditJsonLineWriter,
  createLocalStorageTaskAuditJsonLineWriter,
  createTaskSnapshotAuditJsonLines,
  ensureToolCallAuditSchema,
  listToolCallAuditRecordsForTask,
  parseTaskAuditJsonLines,
  parseToolCallAuditJsonLines,
  sanitizeToolCallAuditRecord,
  serializeToolCallAuditJsonLine,
  upsertToolCallAuditRecord,
  type ToolCallAuditRecord,
} from "./tool-call-audit";
import type { TaskSnapshot } from "@javis/core";
import type {
  DatabaseValue,
  DesktopDatabase,
} from "./desktop-database";

describe("tool call audit persistence", () => {
  it("defines schema migrations for tool call audit records", async () => {
    const database = createToolCallAuditDatabase();

    await ensureToolCallAuditSchema(database);

    expect(TOOL_CALL_AUDIT_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "tool-call-audit-v1-table",
      "tool-call-audit-v1-task-index",
    ]);
    expect(database.executed.map((entry) => entry.sql)).toEqual(
      TOOL_CALL_AUDIT_MIGRATIONS.map((migration) => migration.sql),
    );
  });

  it("upserts valid audit records and rejects malformed records", async () => {
    const database = createToolCallAuditDatabase();
    const record = createToolCallRecord();

    expect(await upsertToolCallAuditRecord(database, record)).toEqual(record);
    expect(
      await upsertToolCallAuditRecord(database, {
        ...record,
        status: "unknown",
      } as unknown as ToolCallAuditRecord),
    ).toBeNull();

    const values = database.executed[0]?.values;
    expect(values?.slice(0, 13)).toEqual([
      "tool-1",
      "task-1",
      "run-1",
      "file.scanMarkdownDocuments",
      "read",
      "succeeded",
      "Scan Markdown documents",
      "2 documents",
      null,
      null,
      "2026-05-24T00:00:00.000Z",
      "2026-05-24T00:00:01.000Z",
      null,
    ]);
    expect(JSON.parse(String(values?.[13]))).toEqual(record);
  });

  it("loads sanitized records for a task", async () => {
    const record = createToolCallRecord();
    const database = createToolCallAuditDatabase([
      { record_json: JSON.stringify(record) },
      { record_json: "{\"bad\":" },
      { record_json: JSON.stringify({ id: "missing-fields" }) },
    ]);

    await expect(listToolCallAuditRecordsForTask(database, "task-1")).resolves.toEqual([
      record,
    ]);
  });

  it("sanitizes optional fields", () => {
    expect(
      sanitizeToolCallAuditRecord({
        id: "tool-2",
        taskId: "task-1",
        toolName: "code.applyProposedEdit",
        permissionLevel: "confirmed_write",
        status: "waiting_permission",
        inputSummary: "Apply approved patch",
        dryRunJson: "{}",
        permissionRequestId: "permission-1",
      }),
    ).toEqual({
      id: "tool-2",
      taskId: "task-1",
      toolName: "code.applyProposedEdit",
      permissionLevel: "confirmed_write",
      status: "waiting_permission",
      inputSummary: "Apply approved patch",
      dryRunJson: "{}",
      permissionRequestId: "permission-1",
    });
  });

  it("serializes and parses JSONL audit event lines", () => {
    const record = createToolCallRecord();
    const line = serializeToolCallAuditJsonLine(record, "2026-05-25T00:00:00.000Z");

    expect(line?.endsWith("\n")).toBe(true);
    expect(parseToolCallAuditJsonLines(`${line}not-json\n${JSON.stringify({ kind: "bad" })}\n`))
      .toEqual([
        {
          kind: "tool_call_audit",
          recordedAt: "2026-05-25T00:00:00.000Z",
          record,
        },
      ]);
  });

  it("appends JSONL audit event lines through an injected writer", async () => {
    const lines: string[] = [];
    const appended = await appendToolCallAuditJsonLine(
      {
        appendLine: async (line) => {
          lines.push(line);
        },
      },
      createToolCallRecord(),
      "2026-05-25T00:00:00.000Z",
    );

    expect(lines).toHaveLength(1);
    expect(appended?.record.id).toBe("tool-1");
  });

  it("derives agent and tool audit JSONL lines from task snapshots", () => {
    const snapshot = createTaskSnapshot();
    const lines = createTaskSnapshotAuditJsonLines(snapshot, "2026-05-25T00:00:00.000Z");

    expect(lines.map((line) => line.kind)).toEqual([
      "agent_run_audit",
      "tool_call_audit",
      "tool_call_audit",
    ]);
    expect(lines[0]?.record.id).toBe("task-1:agent:agent-file:completed");
    expect(lines[1]).toEqual(expect.objectContaining({
      kind: "tool_call_audit",
      record: expect.objectContaining({
        toolName: "file.scanMarkdownDocuments",
        permissionLevel: "read",
        status: "succeeded",
      }),
    }));
    expect(lines[2]).toEqual(expect.objectContaining({
      kind: "tool_call_audit",
      record: expect.objectContaining({
        toolName: "code.applyProposedEdit",
        permissionLevel: "confirmed_write",
        status: "waiting_permission",
        permissionRequestId: "permission-1",
      }),
    }));
  });

  it("appends task snapshot audit lines to localStorage without duplicating seen records", async () => {
    const storage = createMemoryStorage();
    const writer = createLocalStorageTaskAuditJsonLineWriter(storage);
    const seen = new Set<string>();
    const snapshot = createTaskSnapshot();

    await appendTaskSnapshotAuditJsonLines(writer, snapshot, seen, "2026-05-25T00:00:00.000Z");
    await appendTaskSnapshotAuditJsonLines(writer, snapshot, seen, "2026-05-25T00:00:01.000Z");

    const parsed = parseTaskAuditJsonLines(storage.getItem("javis.taskAuditJsonl.v1") ?? "");
    expect(parsed).toHaveLength(3);
    expect(parsed.map((line) => line.kind)).toEqual([
      "agent_run_audit",
      "tool_call_audit",
      "tool_call_audit",
    ]);
  });

  it("uses file-backed JSONL writes before falling back to localStorage", async () => {
    const storage = createMemoryStorage();
    const fileLines: string[] = [];
    const writer = createFileBackedTaskAuditJsonLineWriter(
      async (line) => {
        fileLines.push(line);
      },
      storage,
    );

    await writer.appendLine("{\"ok\":true}\n");

    expect(fileLines).toEqual(["{\"ok\":true}\n"]);
    expect(storage.getItem("javis.taskAuditJsonl.v1")).toBeNull();
  });

  it("falls back to localStorage when file-backed JSONL writes fail", async () => {
    const storage = createMemoryStorage();
    const writer = createFileBackedTaskAuditJsonLineWriter(
      async () => {
        throw new Error("file unavailable");
      },
      storage,
    );

    await writer.appendLine("{\"ok\":true}\n");

    expect(storage.getItem("javis.taskAuditJsonl.v1")).toBe("{\"ok\":true}\n");
  });
});

function createToolCallRecord(): ToolCallAuditRecord {
  return {
    id: "tool-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolName: "file.scanMarkdownDocuments",
    permissionLevel: "read",
    status: "succeeded",
    inputSummary: "Scan Markdown documents",
    outputSummary: "2 documents",
    startedAt: "2026-05-24T00:00:00.000Z",
    endedAt: "2026-05-24T00:00:01.000Z",
  };
}

function createTaskSnapshot(): TaskSnapshot {
  return {
    id: "task-1",
    title: "Audit task",
    userGoal: "scan project",
    status: "waiting_permission",
    commanderMessage: "Waiting for permission.",
    plan: [],
    agents: [
      {
        id: "agent-file",
        name: "File Agent",
        role: "Read-only local document scanning",
        status: "completed",
        task: "Scanned Markdown documents",
      },
      {
        id: "agent-code",
        name: "Code Agent",
        role: "Repository diff preview",
        status: "queued",
        task: "Waiting",
      },
    ],
    logs: [
      {
        id: "task-1-tool-file.scanMarkdownDocuments-completed",
        kind: "tool",
        title: "tool_call.updated",
        detail: "file.scanMarkdownDocuments returned 2 document record(s).",
      },
      {
        id: "task-1-permission-permission-1-requested",
        kind: "permission",
        title: "permission.requested",
        detail: "Applying a patch requires confirmed-write approval.",
      },
    ],
    permissionRequest: {
      id: "permission-1",
      level: "confirmed_write",
      title: "Approve Code Agent patch application",
      reason: "Applying a patch requires confirmed-write approval.",
      dryRun: {
        operation: "Apply Code Agent patch",
        affectedPaths: [
          {
            source: "packages/core/src/index.ts",
            target: "packages/core/src/index.ts",
            action: "modify",
          },
        ],
        riskSummary: "Modifies one source file.",
        reversible: true,
      },
      status: "pending",
      createdAt: "2026-05-25T00:00:00.000Z",
    },
  };
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function createToolCallAuditDatabase(
  rows: Array<{ record_json: string }> = [],
) {
  const executed: Array<{ sql: string; values: DatabaseValue[] }> = [];
  const database: DesktopDatabase & {
    executed: Array<{ sql: string; values: DatabaseValue[] }>;
  } = {
    executed,
    async execute(sql, values = []) {
      executed.push({ sql, values });
    },
    async select<T extends Record<string, unknown>>() {
      return rows as unknown as T[];
    },
  };
  return database;
}
