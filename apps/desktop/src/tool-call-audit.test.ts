import { describe, expect, it } from "vitest";
import {
  TOOL_CALL_AUDIT_MIGRATIONS,
  appendToolCallAuditJsonLine,
  appendTaskSnapshotAuditJsonLines,
  createFileBackedTaskAuditJsonLineWriter,
  createLocalStorageTaskAuditJsonLineWriter,
  createTaskSnapshotAuditJsonLines,
  ensureToolCallAuditSchema,
  listRecentToolCallAuditRecords,
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

  it("loads bounded recent audit records in chronological order", async () => {
    const newest = { ...createToolCallRecord(), id: "tool-newest" };
    const older = { ...createToolCallRecord(), id: "tool-older" };
    const database = createToolCallAuditDatabase([
      { record_json: JSON.stringify(newest) },
      { record_json: "{\"bad\":" },
      { record_json: JSON.stringify(older) },
    ]);

    await expect(listRecentToolCallAuditRecords(database, 2)).resolves.toEqual([
      older,
      newest,
    ]);
    expect(database.selected[0]?.values).toEqual([2]);
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

  it("redacts image data URLs from persisted audit record fields", async () => {
    const database = createToolCallAuditDatabase();
    const record: ToolCallAuditRecord = {
      ...createToolCallRecord(),
      id: "tool-image",
      inputSummary: "Saw data:image/png;base64,INPUT==",
      outputSummary: "Returned data:image/png;base64,OUTPUT==",
      dryRunJson: "{\"data:image\\/png;base64,KEY==\":\"safe\",\"preview\":\"data:image\\/png;base64,DRYRUN==\"}",
      errorJson: JSON.stringify({ message: "failed data:image/png;base64,ERROR==" }),
    };

    const sanitized = await upsertToolCallAuditRecord(database, record);
    const recordJson = String(database.executed[0]?.values[13] ?? "");
    const parsed = JSON.parse(recordJson) as ToolCallAuditRecord;
    const line = serializeToolCallAuditJsonLine(record, "2026-05-25T00:00:00.000Z") ?? "";

    expect(JSON.stringify(sanitized)).not.toContain("data:image");
    expect(recordJson).not.toContain("data:image");
    expect(line).not.toContain("data:image");
    expect(parsed.inputSummary).toContain("[redacted image data URL]");
    expect(parsed.outputSummary).toContain("[redacted image data URL]");
    expect(parsed.dryRunJson).toContain("[redacted image data URL]");
    expect(parsed.dryRunJson).not.toContain("data:image\\/");
    expect(parsed.errorJson).toContain("[redacted image data URL]");
  });

  it("redacts local vision model and adapter paths from audit records", async () => {
    const database = createToolCallAuditDatabase();
    const record: ToolCallAuditRecord = {
      ...createToolCallRecord(),
      id: "tool-local-vision",
      toolName: "computer.detectUiObjects",
      inputSummary: String.raw`modelPath=C:\Users\alice\Models\yolo26n-ui.onnx runtimeAdapterPath=models\adapters\yolo26-ui.mjs`,
      outputSummary: "adapter /home/alice/.cache/javis/runtime-adapter.mjs finished; source packages/core/src/index.js stayed visible",
      dryRunJson: JSON.stringify({
        modelPath: String.raw`C:\Users\alice\Models\yolo26n-ui.onnx`,
        runtimeAdapterPath: "models/adapters/yolo26-ui.mjs",
      }),
      errorJson: JSON.stringify({
        message: "failed at /home/alice/.cache/javis/runtime-adapter.mjs",
      }),
    };

    const sanitized = await upsertToolCallAuditRecord(database, record);
    const recordJson = String(database.executed[0]?.values[13] ?? "");
    const line = serializeToolCallAuditJsonLine(record, "2026-05-25T00:00:00.000Z") ?? "";
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain("[redacted local path:yolo26n-ui.onnx]");
    expect(serialized).toContain("[redacted local path:yolo26-ui.mjs]");
    expect(serialized).toContain("[redacted local path:runtime-adapter.mjs]");
    expect(serialized).toContain("packages/core/src/index.js");
    expect(recordJson).not.toContain("alice");
    expect(recordJson).not.toContain("C:\\Users");
    expect(recordJson).not.toContain("/home/alice");
    expect(recordJson).not.toContain("models\\adapters");
    expect(line).not.toContain("alice");
    expect(line).not.toContain("models/adapters");
  });

  it("bounds oversized audit record fields before persistence", async () => {
    const database = createToolCallAuditDatabase();
    const hugeText = "x".repeat(60_000);
    const record: ToolCallAuditRecord = {
      ...createToolCallRecord(),
      id: "tool-large",
      inputSummary: hugeText,
      outputSummary: hugeText,
      dryRunJson: JSON.stringify({ preview: hugeText }),
      errorJson: JSON.stringify({ message: hugeText }),
    };

    const sanitized = await upsertToolCallAuditRecord(database, record);
    const values = database.executed[0]?.values ?? [];
    const recordJson = String(values[13] ?? "");
    const line = serializeToolCallAuditJsonLine(record, "2026-05-25T00:00:00.000Z") ?? "";

    expect(sanitized?.inputSummary).toContain("[truncated:");
    expect(String(values[6])).toContain("[truncated:");
    expect(String(values[8])).toContain("[truncated:");
    expect(String(values[12])).toContain("[truncated:");
    expect(recordJson).toContain("[truncated:");
    expect(recordJson.length).toBeLessThan(80_000);
    expect(line).toContain("[truncated:");
    expect(line.length).toBeLessThan(90_000);
  });

  it("redacts image data URLs from snapshot-derived audit lines", () => {
    const snapshot = {
      ...createTaskSnapshot(),
      logs: [
        {
          id: "task-1-tool-computer-screenshot-completed",
          kind: "tool" as const,
          title: "tool_call.updated",
          detail: "computer.screenshot returned data:image/png;base64,LOG==",
        },
        {
          id: "task-1-permission-permission-1-requested",
          kind: "permission" as const,
          title: "permission.requested",
          detail: "Approve preview data:image/png;base64,PERMISSION==",
        },
      ],
      permissionRequest: {
        ...createTaskSnapshot().permissionRequest!,
        dryRun: {
          operation: "Apply Code Agent patch",
          affectedPaths: [],
          riskSummary: "Preview data:image/png;base64,DRYRUN==",
          reversible: true,
        },
      },
    };

    const lines = createTaskSnapshotAuditJsonLines(snapshot, "2026-05-25T00:00:00.000Z");
    const serialized = JSON.stringify(lines);

    expect(serialized).not.toContain("data:image");
    expect(serialized).toContain("[redacted image data URL]");
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

  it("audits memory.search without copying full query or fact text", () => {
    const snapshot = {
      ...createTaskSnapshot(),
      logs: [
        ...createTaskSnapshot().logs,
        {
          id: "task-1-tool-memory.search-completed",
          kind: "tool" as const,
          title: "tool_call.updated",
          detail: "Step search-memory: memory.search completed.",
          devDetail: JSON.stringify({
            query: "FULL_MEMORY_QUERY",
            results: [{ id: "mem-1", fact: "SECRET_MEMORY_FACT_BODY" }],
          }),
        },
      ],
    };

    const lines = createTaskSnapshotAuditJsonLines(snapshot, "2026-05-25T00:00:00.000Z");
    const memoryLine = lines.find((line) =>
      line.kind === "tool_call_audit" && line.record.toolName === "memory.search",
    );

    expect(memoryLine).toEqual(expect.objectContaining({
      kind: "tool_call_audit",
      record: expect.objectContaining({
        toolName: "memory.search",
        permissionLevel: "read",
        status: "succeeded",
        inputSummary: "Step search-memory: memory.search completed.",
        outputSummary: "tool_call.updated",
      }),
    }));
    expect(JSON.stringify(memoryLine)).not.toContain("FULL_MEMORY_QUERY");
    expect(JSON.stringify(memoryLine)).not.toContain("SECRET_MEMORY_FACT_BODY");
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
  const selected: Array<{ sql: string; values: DatabaseValue[] }> = [];
  const database: DesktopDatabase & {
    executed: Array<{ sql: string; values: DatabaseValue[] }>;
    selected: Array<{ sql: string; values: DatabaseValue[] }>;
  } = {
    executed,
    selected,
    async execute(sql, values = []) {
      executed.push({ sql, values });
    },
    async select<T extends Record<string, unknown>>(sql: string, values: DatabaseValue[] = []) {
      selected.push({ sql, values });
      return rows as unknown as T[];
    },
  };
  return database;
}
