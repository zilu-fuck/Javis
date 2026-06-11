import { describe, expect, it, vi } from "vitest";
import { createInitialTaskSnapshot, type TaskSnapshot } from "@javis/core";
import {
  appendTaskSessionSnapshotJsonLine,
  createTaskSessionSnapshotJsonLine,
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

  it("redacts image data URLs before writing session snapshots", () => {
    const line = createTaskSessionSnapshotJsonLine({
      ...createSnapshot("task-1", "running"),
      userGoal: "Describe data:image/png;base64,AA==",
      commanderMessage: "Saw data:image/png;base64,BB==",
      logs: [
        {
          id: "log-1",
          kind: "event",
          title: "image.received",
          detail: "detail data:image/png;base64,CC==",
          devDetail: "dev data:image/png;base64,DD==",
        },
      ],
      conversationMessages: [
        {
          role: "user",
          content: "content data:image/png;base64,EE==",
          attachments: ["data:image/png;base64,FF=="],
        },
      ],
    });

    const serialized = JSON.stringify(line);

    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("attachments");
    expect(line?.snapshot.userGoal).toContain("[redacted image data URL]");
    expect(line?.snapshot.conversationMessages?.[0]?.attachments).toBeUndefined();
  });

  it("preserves handoff reports in session snapshot JSONL", () => {
    const line = createTaskSessionSnapshotJsonLine({
      ...createSnapshot("task-handoff", "running"),
      handoffReport: {
        generatedAt: "2026-06-11T00:00:00.000Z",
        status: "complete",
        missingInputContextKeys: [],
        unconsumedOutputContextKeys: [],
        steps: [{
          stepId: "collect-evidence",
          assignedAgentKind: "code",
          dependsOn: [],
          inputContextKeys: [],
          outputContextKey: "repoEvidence",
          missingInputContextKeys: [],
        }],
        handoffs: [{
          contextKey: "repoEvidence",
          producedByStepId: "collect-evidence",
          consumedByStepIds: ["review-evidence"],
          status: "available",
          valueSummary: { type: "object", present: true, keyCount: 2 },
        }],
      },
    });

    const parsed = parseTaskSessionJsonLines(`${JSON.stringify(line)}\n`);

    expect(parsed[0]?.snapshot.handoffReport?.handoffs[0]).toMatchObject({
      contextKey: "repoEvidence",
      producedByStepId: "collect-evidence",
      consumedByStepIds: ["review-evidence"],
      status: "available",
    });
  });

  it("preserves recovery reports in session snapshot JSONL", () => {
    const line = createTaskSessionSnapshotJsonLine({
      ...createSnapshot("task-recovery", "running"),
      recoveryReport: {
        generatedAt: "2026-06-11T00:00:00.000Z",
        status: "recovered",
        failureCount: 1,
        recoveredCount: 1,
        unrecoveredCount: 0,
        abandonedStepIds: ["collect-primary"],
        replannedStepIds: ["collect-fallback"],
        attempts: [{
          failedStepId: "collect-primary",
          failedStepTitle: "Collect primary evidence",
          agentKind: "research",
          errorSummary: "HTTP 503 from primary provider",
          failureKind: "network",
          completedBefore: ["parse-request"],
          replanAttempted: true,
          replanStatus: "planned",
          abandonedFailedStep: true,
          recoveryStepIds: ["collect-fallback"],
          suggestedAlternatives: [
            "retry with a fallback provider",
            "use cached or user-provided sources when available",
          ],
        }],
      },
    });

    const parsed = parseTaskSessionJsonLines(`${JSON.stringify(line)}\n`);

    expect(parsed[0]?.snapshot.recoveryReport).toMatchObject({
      status: "recovered",
      abandonedStepIds: ["collect-primary"],
      replannedStepIds: ["collect-fallback"],
    });
    expect(parsed[0]?.snapshot.recoveryReport?.attempts[0]).toMatchObject({
      failedStepId: "collect-primary",
      failureKind: "network",
      replanStatus: "planned",
      recoveryStepIds: ["collect-fallback"],
    });
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
