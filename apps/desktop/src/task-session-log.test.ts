import { describe, expect, it, vi } from "vitest";
import { createInitialTaskSnapshot, type TaskSnapshot } from "@javis/core";
import {
  appendTaskSessionSnapshotJsonLine,
  createDeduplicatingTaskSessionWriter,
  createTaskSessionSnapshotJsonLine,
  createFileBackedTaskSessionJsonLineWriter,
  createLocalStorageTaskSessionJsonLineWriter,
  parseTaskSessionJsonLines,
  resumeLatestTaskSessionSnapshot,
  rewindTaskSessionToSnapshot,
  TASK_SESSION_JSONL_STORAGE_KEY,
  type TaskSessionJsonLineWriter,
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
        invalidInputContextKeys: [],
        unconsumedOutputContextKeys: [],
        steps: [{
          stepId: "collect-evidence",
          assignedAgentKind: "code",
          dependsOn: [],
          inputContextKeys: [],
          outputContextKey: "repoEvidence",
          missingInputContextKeys: [],
          invalidInputContextKeys: [],
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
        progressLedger: {
          completed: [{
            stepId: "parse-request",
            title: "Parse request",
            agentKind: "commander",
          }],
          failed: [{
            stepId: "collect-primary",
            title: "Collect primary evidence",
            agentKind: "research",
            errorSummary: "HTTP 503 from primary provider",
          }],
          blocked: [],
          repeatedActions: [],
          remainingWork: ["collect-fallback"],
        },
        stuckSignals: [],
        commanderGuidance: [],
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
      progressLedger: {
        remainingWork: ["collect-fallback"],
      },
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

describe("deduplicating task session writer", () => {
  function createRecordingWriter() {
    const lines: string[] = [];
    const inner: TaskSessionJsonLineWriter = {
      async appendLine(line) {
        lines.push(line);
      },
    };
    return { inner, lines };
  }

  it("writes an unchanged terminal snapshot only once", async () => {
    const { inner, lines } = createRecordingWriter();
    const writer = createDeduplicatingTaskSessionWriter(() => inner, { minIntervalMs: 0 });
    const failed = createSnapshot("task-1", "failed");

    for (let index = 0; index < 1_000; index += 1) {
      await appendTaskSessionSnapshotJsonLine(writer, failed);
    }

    expect(lines).toHaveLength(1);
    expect(writer.writtenRows).toBe(1);
    expect(writer.skippedDuplicateRows).toBe(999);
  });

  it("always writes a status transition even inside the throttle window", async () => {
    const { inner, lines } = createRecordingWriter();
    let now = 1_000;
    const writer = createDeduplicatingTaskSessionWriter(() => inner, {
      minIntervalMs: 1_500,
      now: () => now,
    });

    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "planning"));
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "running"));
    now += 10;
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "waiting_permission"));
    now += 10;
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "completed"));

    expect(lines).toHaveLength(4);
    const statuses = parseTaskSessionJsonLines(lines.join("")).map((line) => line.snapshot.status);
    expect(statuses).toEqual(["planning", "running", "waiting_permission", "completed"]);
  });

  it("throttles same-status streaming writes while staying within one interval of the newest state", async () => {
    const { inner, lines } = createRecordingWriter();
    let now = 0;
    const intervalMs = 1_500;
    const stepMs = 10;
    const writer = createDeduplicatingTaskSessionWriter(() => inner, {
      minIntervalMs: intervalMs,
      now: () => now,
    });

    // 1,000 distinct streaming updates over ~10 seconds of wall clock: one row
    // per interval instead of one row per delta.
    const updates = 1_000;
    for (let index = 0; index < updates; index += 1) {
      now += stepMs;
      await appendTaskSessionSnapshotJsonLine(writer, {
        ...createSnapshot("task-1", "running"),
        commanderMessage: `chunk-${index}`,
      });
    }

    expect(lines.length).toBeLessThanOrEqual(Math.ceil((updates * stepMs) / intervalMs) + 1);
    expect(lines.length).toBeGreaterThan(1);
    expect(writer.skippedThrottledRows).toBeGreaterThan(900);

    // The newest state is never more than one throttle interval behind: anything
    // older than that within the same status carries no resumable information.
    const lastWritten = Number(
      (parseTaskSessionJsonLines(lines[lines.length - 1] ?? "")[0]?.snapshot.commanderMessage ?? "")
        .replace("chunk-", ""),
    );
    expect(updates - 1 - lastWritten).toBeLessThanOrEqual(intervalMs / stepMs);
  });

  it("writes the final terminal state even when it lands inside the throttle window", async () => {
    const { inner, lines } = createRecordingWriter();
    let now = 0;
    const writer = createDeduplicatingTaskSessionWriter(() => inner, {
      minIntervalMs: 1_500,
      now: () => now,
    });

    await appendTaskSessionSnapshotJsonLine(writer, {
      ...createSnapshot("task-1", "running"),
      commanderMessage: "streaming",
    });
    now += 5;
    await appendTaskSessionSnapshotJsonLine(writer, {
      ...createSnapshot("task-1", "failed"),
      commanderMessage: "model call failed",
    });

    expect(lines).toHaveLength(2);
    expect(parseTaskSessionJsonLines(lines[1] ?? "")[0]?.snapshot.status).toBe("failed");
  });

  it("keeps per-task state independent and isolates unknown tasks", async () => {
    const { inner, lines } = createRecordingWriter();
    const writer = createDeduplicatingTaskSessionWriter(() => inner, { minIntervalMs: 0 });

    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "running"));
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-2", "running"));
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "running"));
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-2", "running"));

    expect(lines).toHaveLength(2);
    writer.forgetTask("task-1");
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "running"));
    expect(lines).toHaveLength(3);
  });

  it("bounds tracked tasks and never drops unparseable lines", async () => {
    const { inner, lines } = createRecordingWriter();
    const writer = createDeduplicatingTaskSessionWriter(() => inner, {
      minIntervalMs: 0,
      maxTrackedTasks: 2,
    });

    await writer.appendLine("not json at all\n");
    expect(lines).toEqual(["not json at all\n"]);

    for (const taskId of ["task-1", "task-2", "task-3"]) {
      await appendTaskSessionSnapshotJsonLine(writer, createSnapshot(taskId, "running"));
    }
    // Eviction must only forget dedupe memory, never skip a legitimate write.
    expect(lines).toHaveLength(4);
  });

  it("creates the inner writer lazily per append", async () => {
    const { inner, lines } = createRecordingWriter();
    const createInner = vi.fn(() => inner);
    const writer = createDeduplicatingTaskSessionWriter(createInner, { minIntervalMs: 1_500 });

    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "running"));
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "running"));

    expect(createInner).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
  });

  it("resets counters and dedupe memory", async () => {
    const { inner, lines } = createRecordingWriter();
    const writer = createDeduplicatingTaskSessionWriter(() => inner, { minIntervalMs: 0 });

    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "failed"));
    writer.reset();
    expect(writer.writtenRows).toBe(0);
    expect(writer.skippedDuplicateRows).toBe(0);
    await appendTaskSessionSnapshotJsonLine(writer, createSnapshot("task-1", "failed"));
    expect(lines).toHaveLength(2);
  });

  it("keeps a production-scale runaway stream under the M1 write budget", async () => {
    // Reproduces the observed pathology for task-1789226288412: ~3 minutes of
    // streamed snapshots, then a terminal snapshot re-notified 15,929 times at
    // ~52/s for five minutes. That produced 34,577 rows / 93 MB.
    const { inner, lines } = createRecordingWriter();
    let now = 0;
    const writer = createDeduplicatingTaskSessionWriter(() => inner, {
      minIntervalMs: 1_500,
      now: () => now,
    });

    const streamingUpdates = 10_800; // ~60/s for 3 minutes
    for (let index = 0; index < streamingUpdates; index += 1) {
      now += 17;
      await appendTaskSessionSnapshotJsonLine(writer, {
        ...createSnapshot("task-1", "running"),
        commanderMessage: `chunk-${index}`,
      });
    }

    const terminal = {
      ...createSnapshot("task-1", "failed"),
      commanderMessage: "模型请求失败",
    };
    await appendTaskSessionSnapshotJsonLine(writer, terminal);
    const writesAfterTerminal = lines.length;

    const runawayRepeats = 15_929;
    for (let index = 0; index < runawayRepeats; index += 1) {
      now += 19;
      await appendTaskSessionSnapshotJsonLine(writer, terminal);
    }

    // M1 acceptance: a long task must stay far below 500 rows.
    expect(lines.length).toBeLessThan(500);
    // The runaway phase contributes nothing at all, not merely "less".
    expect(lines.length).toBe(writesAfterTerminal);
    expect(writer.skippedDuplicateRows).toBe(runawayRepeats);
    // The terminal snapshot itself is always persisted, so the task stays resumable.
    expect(
      parseTaskSessionJsonLines(lines[lines.length - 1] ?? "")[0]?.snapshot.status,
    ).toBe("failed");
  }, 60_000);
});
