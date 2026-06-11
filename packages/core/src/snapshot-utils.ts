import type { TaskLogEntry, TaskSnapshot } from "./index";

export const MAX_TASK_LOG_ENTRIES = 500;
const TASK_LOG_HEAD_RETAIN_COUNT = 20;

export function appendLog(snapshotValue: TaskSnapshot, entry: TaskLogEntry): TaskLogEntry[] {
  return appendTaskLogEntry(snapshotValue.logs, entry);
}

export function appendTaskLogEntry(logs: TaskLogEntry[], entry: TaskLogEntry): TaskLogEntry[] {
  const baseLogs = shouldReplaceExistingLog(entry)
    ? logs.filter((log) => log.id !== entry.id)
    : logs;
  return compactTaskLogs([...baseLogs, entry]);
}

export function compactTaskSnapshotLogs(snapshot: TaskSnapshot): TaskSnapshot {
  const logs = compactTaskLogs(snapshot.logs);
  return logs === snapshot.logs ? snapshot : { ...snapshot, logs };
}

export function compactTaskLogs(
  logs: TaskLogEntry[],
  maxEntries = MAX_TASK_LOG_ENTRIES,
): TaskLogEntry[] {
  if (logs.length <= maxEntries) {
    return logs;
  }

  const headCount = Math.min(TASK_LOG_HEAD_RETAIN_COUNT, Math.max(0, maxEntries));
  const tailCount = Math.max(0, maxEntries - headCount);
  return [
    ...logs.slice(0, headCount),
    ...logs.slice(logs.length - tailCount),
  ];
}

function shouldReplaceExistingLog(entry: TaskLogEntry): boolean {
  return entry.title === "step.progress" ||
    entry.title === "agent.status" ||
    entry.title === "agent.chunk_start" ||
    entry.title === "agent.chunk_end";
}
