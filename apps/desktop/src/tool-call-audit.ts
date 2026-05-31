import type {
  DatabaseValue,
  DesktopDatabase,
  DesktopDatabaseMigration,
} from "./desktop-database";
import type { TaskSnapshot } from "@javis/core";

export const TASK_AUDIT_JSONL_STORAGE_KEY = "javis.taskAuditJsonl.v1";

export type ToolCallAuditStatus =
  | "planned"
  | "waiting_permission"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

export interface ToolCallAuditRecord {
  id: string;
  taskId: string;
  agentRunId?: string;
  toolName: string;
  permissionLevel: "read" | "preview" | "confirmed_write" | "dangerous";
  status: ToolCallAuditStatus;
  inputSummary: string;
  outputSummary?: string;
  dryRunJson?: string;
  permissionRequestId?: string;
  startedAt?: string;
  endedAt?: string;
  errorJson?: string;
}

export interface ToolCallAuditJsonLine {
  kind: "tool_call_audit";
  recordedAt: string;
  record: ToolCallAuditRecord;
}

export interface AgentRunAuditRecord {
  id: string;
  taskId: string;
  agentId: string;
  agentName: string;
  status: TaskSnapshot["agents"][number]["status"];
  task: string;
  recordedAt?: string;
}

export interface AgentRunAuditJsonLine {
  kind: "agent_run_audit";
  recordedAt: string;
  record: AgentRunAuditRecord;
}

export type TaskAuditJsonLine = ToolCallAuditJsonLine | AgentRunAuditJsonLine;

export interface ToolCallAuditJsonLineWriter {
  appendLine(line: string): Promise<void>;
}

export const TOOL_CALL_AUDIT_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    id: "tool-call-audit-v1-table",
    sql: `
CREATE TABLE IF NOT EXISTS tool_call_audit (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  agent_run_id TEXT,
  tool_name TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  output_summary TEXT,
  dry_run_json TEXT,
  permission_request_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  error_json TEXT,
  record_json TEXT NOT NULL
)`.trim(),
  },
  {
    id: "tool-call-audit-v1-task-index",
    sql: `
CREATE INDEX IF NOT EXISTS tool_call_audit_task_idx
ON tool_call_audit (task_id, started_at)`.trim(),
  },
];

const UPSERT_TOOL_CALL_AUDIT_SQL = `
INSERT INTO tool_call_audit (
  id,
  task_id,
  agent_run_id,
  tool_name,
  permission_level,
  status,
  input_summary,
  output_summary,
  dry_run_json,
  permission_request_id,
  started_at,
  ended_at,
  error_json,
  record_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  task_id = excluded.task_id,
  agent_run_id = excluded.agent_run_id,
  tool_name = excluded.tool_name,
  permission_level = excluded.permission_level,
  status = excluded.status,
  input_summary = excluded.input_summary,
  output_summary = excluded.output_summary,
  dry_run_json = excluded.dry_run_json,
  permission_request_id = excluded.permission_request_id,
  started_at = excluded.started_at,
  ended_at = excluded.ended_at,
  error_json = excluded.error_json,
  record_json = excluded.record_json`.trim();

const SELECT_TOOL_CALL_AUDIT_BY_TASK_SQL = `
SELECT record_json
FROM tool_call_audit
WHERE task_id = ?
ORDER BY COALESCE(started_at, ended_at, id) ASC`.trim();

export async function ensureToolCallAuditSchema(database: DesktopDatabase): Promise<void> {
  for (const migration of TOOL_CALL_AUDIT_MIGRATIONS) {
    await database.execute(migration.sql);
  }
}

export async function upsertToolCallAuditRecord(
  database: DesktopDatabase,
  record: ToolCallAuditRecord,
): Promise<ToolCallAuditRecord | null> {
  const sanitized = sanitizeToolCallAuditRecord(record);
  if (!sanitized) {
    return null;
  }
  await database.execute(UPSERT_TOOL_CALL_AUDIT_SQL, bindToolCallAuditRecord(sanitized));
  return sanitized;
}

export async function listToolCallAuditRecordsForTask(
  database: DesktopDatabase,
  taskId: string,
): Promise<ToolCallAuditRecord[]> {
  const rows = await database.select<{ record_json: unknown }>(
    SELECT_TOOL_CALL_AUDIT_BY_TASK_SQL,
    [taskId],
  );
  return rows
    .map((row) => parseToolCallAuditRecord(row.record_json))
    .filter((record): record is ToolCallAuditRecord => Boolean(record));
}

export function sanitizeToolCallAuditRecord(
  value: unknown,
): ToolCallAuditRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isString(value.id) ||
    !isString(value.taskId) ||
    !isString(value.toolName) ||
    !isPermissionLevel(value.permissionLevel) ||
    !isToolCallStatus(value.status) ||
    !isString(value.inputSummary) ||
    ("agentRunId" in value && !isString(value.agentRunId)) ||
    ("outputSummary" in value && !isString(value.outputSummary)) ||
    ("dryRunJson" in value && !isString(value.dryRunJson)) ||
    ("permissionRequestId" in value && !isString(value.permissionRequestId)) ||
    ("startedAt" in value && !isString(value.startedAt)) ||
    ("endedAt" in value && !isString(value.endedAt)) ||
    ("errorJson" in value && !isString(value.errorJson))
  ) {
    return null;
  }

  return {
    id: value.id,
    taskId: value.taskId,
    toolName: value.toolName,
    permissionLevel: value.permissionLevel,
    status: value.status,
    inputSummary: value.inputSummary,
    ...(isString(value.agentRunId) ? { agentRunId: value.agentRunId } : {}),
    ...(isString(value.outputSummary) ? { outputSummary: value.outputSummary } : {}),
    ...(isString(value.dryRunJson) ? { dryRunJson: value.dryRunJson } : {}),
    ...(isString(value.permissionRequestId)
      ? { permissionRequestId: value.permissionRequestId }
      : {}),
    ...(isString(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(isString(value.endedAt) ? { endedAt: value.endedAt } : {}),
    ...(isString(value.errorJson) ? { errorJson: value.errorJson } : {}),
  };
}

export function serializeToolCallAuditJsonLine(
  record: ToolCallAuditRecord,
  recordedAt = new Date().toISOString(),
): string | null {
  const sanitized = sanitizeToolCallAuditRecord(record);
  if (!sanitized) {
    return null;
  }
  return `${JSON.stringify({
    kind: "tool_call_audit",
    recordedAt,
    record: sanitized,
  } satisfies ToolCallAuditJsonLine)}\n`;
}

export async function appendToolCallAuditJsonLine(
  writer: ToolCallAuditJsonLineWriter,
  record: ToolCallAuditRecord,
  recordedAt = new Date().toISOString(),
): Promise<ToolCallAuditJsonLine | null> {
  const line = serializeToolCallAuditJsonLine(record, recordedAt);
  if (!line) {
    return null;
  }
  await writer.appendLine(line);
  return parseToolCallAuditJsonLines(line)[0] ?? null;
}

export function createLocalStorageTaskAuditJsonLineWriter(
  storage: Pick<Storage, "getItem" | "setItem">,
  key = TASK_AUDIT_JSONL_STORAGE_KEY,
): ToolCallAuditJsonLineWriter {
  return {
    async appendLine(line) {
      storage.setItem(key, `${storage.getItem(key) ?? ""}${line}`);
    },
  };
}

export function createFileBackedTaskAuditJsonLineWriter(
  appendToFile: (line: string) => Promise<void>,
  fallbackStorage: Pick<Storage, "getItem" | "setItem">,
  fallbackKey = TASK_AUDIT_JSONL_STORAGE_KEY,
): ToolCallAuditJsonLineWriter {
  const fallbackWriter = createLocalStorageTaskAuditJsonLineWriter(
    fallbackStorage,
    fallbackKey,
  );
  return {
    async appendLine(line) {
      try {
        await appendToFile(line);
      } catch {
        await fallbackWriter.appendLine(line);
      }
    },
  };
}

export async function appendTaskSnapshotAuditJsonLines(
  writer: ToolCallAuditJsonLineWriter,
  snapshot: TaskSnapshot,
  seenRecordIds: Set<string> = new Set(),
  recordedAt = new Date().toISOString(),
): Promise<TaskAuditJsonLine[]> {
  const lines = createTaskSnapshotAuditJsonLines(snapshot, recordedAt)
    .filter((line) => {
      const key = `${line.kind}:${line.record.id}`;
      if (seenRecordIds.has(key)) {
        return false;
      }
      seenRecordIds.add(key);
      return true;
    });

  for (const line of lines) {
    await writer.appendLine(`${JSON.stringify(line)}\n`);
  }
  return lines;
}

export function createTaskSnapshotAuditJsonLines(
  snapshot: TaskSnapshot,
  recordedAt = new Date().toISOString(),
): TaskAuditJsonLine[] {
  return [
    ...createAgentRunAuditJsonLines(snapshot, recordedAt),
    ...createToolCallAuditJsonLines(snapshot, recordedAt),
  ];
}

export function parseToolCallAuditJsonLines(value: string): ToolCallAuditJsonLine[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return sanitizeToolCallAuditJsonLine(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((line): line is ToolCallAuditJsonLine => Boolean(line));
}

export function parseTaskAuditJsonLines(value: string): TaskAuditJsonLine[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return sanitizeTaskAuditJsonLine(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((line): line is TaskAuditJsonLine => Boolean(line));
}

function bindToolCallAuditRecord(record: ToolCallAuditRecord): DatabaseValue[] {
  return [
    record.id,
    record.taskId,
    record.agentRunId ?? null,
    record.toolName,
    record.permissionLevel,
    record.status,
    record.inputSummary,
    record.outputSummary ?? null,
    record.dryRunJson ?? null,
    record.permissionRequestId ?? null,
    record.startedAt ?? null,
    record.endedAt ?? null,
    record.errorJson ?? null,
    JSON.stringify(record),
  ];
}

function sanitizeToolCallAuditJsonLine(value: unknown): ToolCallAuditJsonLine | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind !== "tool_call_audit" || !isString(value.recordedAt)) {
    return null;
  }
  const record = sanitizeToolCallAuditRecord(value.record);
  if (!record) {
    return null;
  }
  return {
    kind: "tool_call_audit",
    recordedAt: value.recordedAt,
    record,
  };
}

function createAgentRunAuditJsonLines(
  snapshot: TaskSnapshot,
  recordedAt: string,
): AgentRunAuditJsonLine[] {
  if (snapshot.id === "task-idle") {
    return [];
  }
  return snapshot.agents
    .filter((agent) => agent.status !== "queued")
    .map((agent) => ({
      kind: "agent_run_audit",
      recordedAt,
      record: {
        id: `${snapshot.id}:agent:${agent.id}:${agent.status}`,
        taskId: snapshot.id,
        agentId: agent.id,
        agentName: agent.name,
        status: agent.status,
        task: agent.task,
        recordedAt,
      },
    }));
}

function createToolCallAuditJsonLines(
  snapshot: TaskSnapshot,
  recordedAt: string,
): ToolCallAuditJsonLine[] {
  const records = snapshot.logs
    .filter((log) => log.kind === "tool" || log.kind === "permission")
    .map((log) => createToolCallAuditRecordFromLog(snapshot, log, recordedAt))
    .filter((record): record is ToolCallAuditRecord => Boolean(record));
  return records.map((record) => ({
    kind: "tool_call_audit",
    recordedAt,
    record,
  }));
}

function createToolCallAuditRecordFromLog(
  snapshot: TaskSnapshot,
  log: TaskSnapshot["logs"][number],
  recordedAt: string,
): ToolCallAuditRecord | null {
  const permissionRequest = snapshot.permissionRequest;
  const permissionLogMatchesRequest =
    log.kind === "permission" &&
    Boolean(permissionRequest && log.id.includes(permissionRequest.id));
  const toolName = permissionLogMatchesRequest
    ? inferToolNameFromPermissionRequest(permissionRequest)
    : inferToolNameFromLog(log);

  if (!toolName) {
    return null;
  }

  const permissionLevel = permissionLogMatchesRequest && permissionRequest
    ? permissionRequest.level
    : inferPermissionLevel(toolName);
  const status = inferAuditStatus(snapshot, log, permissionLogMatchesRequest);
  return sanitizeToolCallAuditRecord({
    id: `${snapshot.id}:log:${log.id}`,
    taskId: snapshot.id,
    toolName,
    permissionLevel,
    status,
    inputSummary: log.detail,
    outputSummary: log.title,
    ...(permissionLogMatchesRequest && permissionRequest
      ? {
          dryRunJson: JSON.stringify(permissionRequest.dryRun),
          permissionRequestId: permissionRequest.id,
        }
      : {}),
    startedAt: recordedAt,
    ...(isTerminalAuditStatus(status) ? { endedAt: recordedAt } : {}),
    ...(status === "failed" ? { errorJson: JSON.stringify({ message: log.detail }) } : {}),
  });
}

function inferToolNameFromLog(log: TaskSnapshot["logs"][number]): string | null {
  const text = `${log.title} ${log.detail}`;
  const knownTool = [
    "commander.plan",
    "verifier.check",
    "file.scanMarkdownDocuments",
    "file.planPdfOrganization",
    "file.executePdfOrganization",
    "file.planWriteText",
    "file.writeText",
    "project.inspect",
    "code.inspectRepository",
    "code.proposeEdit",
    "code.applyProposedEdit",
    "code.analyzeProject",
    "web.search",
    "web.fetchSource",
    "shell.runReadOnlyCommand",
  ].find((name) => text.includes(name));
  if (knownTool) {
    return knownTool;
  }
  if (/^(node|pnpm|git)\b/.test(log.title)) {
    return "shell.runReadOnlyCommand";
  }
  return null;
}

function inferToolNameFromPermissionRequest(
  request: TaskSnapshot["permissionRequest"],
): string | null {
  if (!request) {
    return null;
  }
  const text = `${request.title} ${request.dryRun.operation}`;
  if (/code|patch/i.test(text)) {
    return "code.applyProposedEdit";
  }
  if (/pdf|move|organ/i.test(text)) {
    return "file.executePdfOrganization";
  }
  if (/text|write|file/i.test(text)) {
    return "file.writeText";
  }
  return null;
}

function inferPermissionLevel(toolName: string): ToolCallAuditRecord["permissionLevel"] {
  if (toolName === "code.applyProposedEdit" || toolName === "file.executePdfOrganization" || toolName === "file.writeText") {
    return "confirmed_write";
  }
  if (toolName === "code.inspectRepository" || toolName === "code.proposeEdit" || toolName === "file.planPdfOrganization" || toolName === "file.planWriteText") {
    return "preview";
  }
  return "read";
}

function inferAuditStatus(
  snapshot: TaskSnapshot,
  log: TaskSnapshot["logs"][number],
  permissionLogMatchesRequest: boolean,
): ToolCallAuditStatus {
  if (permissionLogMatchesRequest && snapshot.permissionRequest?.status === "pending") {
    return "waiting_permission";
  }
  if (permissionLogMatchesRequest && snapshot.permissionRequest?.status === "denied") {
    return "denied";
  }
  if (/failed|task\.failed|verification\.failed/i.test(`${log.title} ${log.detail}`)) {
    return "failed";
  }
  if (/planned|requested/i.test(log.title)) {
    return log.kind === "permission" ? "waiting_permission" : "planned";
  }
  if (snapshot.status === "cancelled") {
    return "cancelled";
  }
  return "succeeded";
}

function isTerminalAuditStatus(status: ToolCallAuditStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "denied" || status === "cancelled";
}

function sanitizeTaskAuditJsonLine(value: unknown): TaskAuditJsonLine | null {
  if (!isRecord(value) || !isString(value.recordedAt)) {
    return null;
  }
  if (value.kind === "tool_call_audit") {
    return sanitizeToolCallAuditJsonLine(value);
  }
  if (value.kind !== "agent_run_audit") {
    return null;
  }
  const record = sanitizeAgentRunAuditRecord(value.record);
  if (!record) {
    return null;
  }
  return {
    kind: "agent_run_audit",
    recordedAt: value.recordedAt,
    record,
  };
}

function sanitizeAgentRunAuditRecord(value: unknown): AgentRunAuditRecord | null {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.taskId) ||
    !isString(value.agentId) ||
    !isString(value.agentName) ||
    !isAgentRunStatus(value.status) ||
    !isString(value.task) ||
    ("recordedAt" in value && !isString(value.recordedAt))
  ) {
    return null;
  }
  return {
    id: value.id,
    taskId: value.taskId,
    agentId: value.agentId,
    agentName: value.agentName,
    status: value.status,
    task: value.task,
    ...(isString(value.recordedAt) ? { recordedAt: value.recordedAt } : {}),
  };
}

function parseToolCallAuditRecord(value: unknown): ToolCallAuditRecord | null {
  if (!isString(value)) {
    return null;
  }
  try {
    return sanitizeToolCallAuditRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPermissionLevel(
  value: unknown,
): value is ToolCallAuditRecord["permissionLevel"] {
  return (
    value === "read" ||
    value === "preview" ||
    value === "confirmed_write" ||
    value === "dangerous"
  );
}

function isToolCallStatus(value: unknown): value is ToolCallAuditStatus {
  return (
    value === "planned" ||
    value === "waiting_permission" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "denied" ||
    value === "cancelled"
  );
}

function isAgentRunStatus(value: unknown): value is AgentRunAuditRecord["status"] {
  return (
    value === "queued" ||
    value === "planning" ||
    value === "running" ||
    value === "waiting_permission" ||
    value === "verifying" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}
