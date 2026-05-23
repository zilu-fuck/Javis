import type { TaskLogEntry, TaskSnapshot } from "./index";

export function appendLog(snapshotValue: TaskSnapshot, entry: TaskLogEntry): TaskLogEntry[] {
  return [...snapshotValue.logs, entry];
}
