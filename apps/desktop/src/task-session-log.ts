import type { TaskSnapshot } from "@javis/core";
import { sanitizeTaskSnapshot } from "./task-history";

export const TASK_SESSION_JSONL_STORAGE_KEY = "javis.taskSessionJsonl.v1";

export interface TaskSessionSnapshotJsonLine {
  kind: "task_session_snapshot";
  recordedAt: string;
  taskId: string;
  snapshot: TaskSnapshot;
}

export interface TaskSessionJsonLineWriter {
  appendLine(line: string): Promise<void>;
}

export function createLocalStorageTaskSessionJsonLineWriter(
  storage: Pick<Storage, "getItem" | "setItem">,
  key = TASK_SESSION_JSONL_STORAGE_KEY,
): TaskSessionJsonLineWriter {
  return {
    async appendLine(line) {
      storage.setItem(key, `${storage.getItem(key) ?? ""}${line}`);
    },
  };
}

export function createFileBackedTaskSessionJsonLineWriter(
  appendToFile: (line: string) => Promise<void>,
  fallbackStorage: Pick<Storage, "getItem" | "setItem">,
  fallbackKey = TASK_SESSION_JSONL_STORAGE_KEY,
): TaskSessionJsonLineWriter {
  const fallbackWriter = createLocalStorageTaskSessionJsonLineWriter(
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

export async function appendTaskSessionSnapshotJsonLine(
  writer: TaskSessionJsonLineWriter,
  snapshot: TaskSnapshot,
  recordedAt = new Date().toISOString(),
): Promise<TaskSessionSnapshotJsonLine | null> {
  const line = createTaskSessionSnapshotJsonLine(snapshot, recordedAt);
  if (!line) {
    return null;
  }
  await writer.appendLine(`${JSON.stringify(line)}\n`);
  return line;
}

export function createTaskSessionSnapshotJsonLine(
  snapshot: TaskSnapshot,
  recordedAt = new Date().toISOString(),
): TaskSessionSnapshotJsonLine | null {
  const sanitized = sanitizeTaskSnapshot(snapshot);
  if (!sanitized || sanitized.id === "task-idle") {
    return null;
  }
  return {
    kind: "task_session_snapshot",
    recordedAt,
    taskId: sanitized.id,
    snapshot: sanitized,
  };
}

export function parseTaskSessionJsonLines(value: string): TaskSessionSnapshotJsonLine[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return sanitizeTaskSessionJsonLine(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((line): line is TaskSessionSnapshotJsonLine => Boolean(line));
}

export function resumeLatestTaskSessionSnapshot(
  lines: TaskSessionSnapshotJsonLine[],
): TaskSnapshot | undefined {
  return [...lines]
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .find((line) => !isTerminalStatus(line.snapshot.status))
    ?.snapshot;
}

export function rewindTaskSessionToSnapshot(
  lines: TaskSessionSnapshotJsonLine[],
  taskId: string,
  snapshotId: string,
): TaskSessionSnapshotJsonLine[] {
  const targetIndex = lines.findIndex(
    (line) => line.taskId === taskId && line.snapshot.id === snapshotId,
  );
  if (targetIndex < 0) {
    return lines;
  }
  return lines.slice(0, targetIndex + 1);
}

function sanitizeTaskSessionJsonLine(value: unknown): TaskSessionSnapshotJsonLine | null {
  if (!isRecord(value) || value.kind !== "task_session_snapshot") {
    return null;
  }
  if (!isString(value.recordedAt) || !isString(value.taskId)) {
    return null;
  }
  const snapshot = sanitizeTaskSnapshot(value.snapshot);
  if (!snapshot || snapshot.id !== value.taskId) {
    return null;
  }
  return {
    kind: "task_session_snapshot",
    recordedAt: value.recordedAt,
    taskId: value.taskId,
    snapshot,
  };
}

function isTerminalStatus(status: TaskSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
