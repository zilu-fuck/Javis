import { describe, expect, it } from "vitest";
import type { TaskLogEntry, TaskSnapshot } from "./index";
import { appendLog, compactTaskLogs, MAX_TASK_LOG_ENTRIES } from "./snapshot-utils";

describe("snapshot log utilities", () => {
  it("updates duplicate log ids instead of growing repeated progress logs", () => {
    const snapshot = createSnapshot([
      createLog("task-1-step-scan-progress", "Still waiting after 15s"),
    ]);

    const logs = appendLog(
      snapshot,
      createLog("task-1-step-scan-progress", "Still waiting after 30s"),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail).toBe("Still waiting after 30s");
  });

  it("keeps task logs bounded while preserving the initial context logs", () => {
    const logs = Array.from({ length: MAX_TASK_LOG_ENTRIES + 25 }, (_, index) =>
      createLog(`log-${index}`, `entry ${index}`),
    );

    const compacted = compactTaskLogs(logs);

    expect(compacted).toHaveLength(MAX_TASK_LOG_ENTRIES);
    expect(compacted[0]?.id).toBe("log-0");
    expect(compacted[19]?.id).toBe("log-19");
    expect(compacted[20]?.id).toBe(`log-${logs.length - (MAX_TASK_LOG_ENTRIES - 20)}`);
    expect(compacted[compacted.length - 1]?.id).toBe(`log-${logs.length - 1}`);
  });

  it("keeps repeated tool-call logs for audit detail", () => {
    const snapshot = createSnapshot([
      { ...createLog("tool-log", "first scan"), title: "tool_call.updated", kind: "tool" },
    ]);

    const logs = appendLog(
      snapshot,
      { ...createLog("tool-log", "second scan"), title: "tool_call.updated", kind: "tool" },
    );

    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.detail)).toEqual(["first scan", "second scan"]);
  });
});

function createSnapshot(logs: TaskLogEntry[]): TaskSnapshot {
  return {
    id: "task-1",
    title: "Task",
    userGoal: "Test",
    status: "running",
    commanderMessage: "",
    plan: [],
    agents: [],
    logs,
  };
}

function createLog(id: string, detail: string): TaskLogEntry {
  return {
    id,
    kind: "event",
    title: "step.progress",
    detail,
  };
}
