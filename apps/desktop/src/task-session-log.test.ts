import { describe, expect, it, vi } from "vitest";
import { createInitialTaskSnapshot, type TaskSnapshot } from "@javis/core";
import {
  appendTaskSessionSnapshotJsonLine,
  createFileBackedTaskSessionJsonLineWriter,
  createLocalStorageTaskSessionJsonLineWriter,
  parseTaskSessionJsonLines,
  resumeLatestTaskSessionSnapshot,
  rewindTaskSessionToSnapshot,
  TASK_SESSION_JSONL_STORAGE_KEY,
} from "./task-session-log";

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function createSnapshot(id: string, status: TaskSnapshot["status"]): TaskSnapshot {
  return {
    ...createInitialTaskSnapshot(),
    id,
    title: `Task ${id}`,
    userGoal: "Resume this task",
    status,
  };
}

describe("task session JSONL", () => {
  it("appends and parses restorable task snapshots", async () => {
    const storage = createMemoryStorage();
    const writer = createLocalStorageTaskSessionJsonLineWriter(storage);

    const line = await appendTaskSessionSnapshotJsonLine(
      writer,
      createSnapshot("task-1", "running"),
      "2026-05-25T00:00:00.000Z",
    );

    expect(line?.kind).toBe("task_session_snapshot");
    const parsed = parseTaskSessionJsonLines(storage.getItem(TASK_SESSION_JSONL_STORAGE_KEY) ?? "");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.snapshot.status).toBe("running");
  });

  it("prefers file writes and falls back to localStorage", async () => {
    const storage = createMemoryStorage();
    const appendToFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(undefined);
    const writer = createFileBackedTaskSessionJsonLineWriter(appendToFile, storage);

    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "running"));
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-2", "running"));

    expect(appendToFile).toHaveBeenCalledTimes(2);
    expect(parseTaskSessionJsonLines(storage.getItem(TASK_SESSION_JSONL_STORAGE_KEY) ?? "")).toHaveLength(1);
  });

  it("resumes the newest non-terminal snapshot", () => {
    const lines = [
      {
        kind: "task_session_snapshot" as const,
        recordedAt: "2026-05-25T00:00:00.000Z",
        taskId: "task-1",
        snapshot: createSnapshot("task-1", "completed"),
      },
      {
        kind: "task_session_snapshot" as const,
        recordedAt: "2026-05-25T00:01:00.000Z",
        taskId: "task-2",
        snapshot: createSnapshot("task-2", "waiting_permission"),
      },
    ];

    expect(resumeLatestTaskSessionSnapshot(lines)?.id).toBe("task-2");
  });

  it("rewinds a task session to a selected snapshot line", () => {
    const lines = [
      {
        kind: "task_session_snapshot" as const,
        recordedAt: "2026-05-25T00:00:00.000Z",
        taskId: "task-1",
        snapshot: createSnapshot("task-1", "planning"),
      },
      {
        kind: "task_session_snapshot" as const,
        recordedAt: "2026-05-25T00:01:00.000Z",
        taskId: "task-1",
        snapshot: createSnapshot("task-1", "running"),
      },
    ];

    expect(rewindTaskSessionToSnapshot(lines, "task-1", "task-1")).toHaveLength(1);
  });
});
