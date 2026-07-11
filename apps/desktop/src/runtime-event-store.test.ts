import { describe, expect, it } from "vitest";
import type { RuntimeEventEnvelope } from "@javis/core";
import {
  COMPACTED_STREAM_EVENT_KIND,
  COMPACTED_STREAM_TEXT_LIMIT,
  buildStreamingCompactionEvents,
  createRuntimeEventStore,
} from "./runtime-event-store";
import type { DesktopDatabase } from "./desktop-database";

type TestRuntimeEventEnvelope = RuntimeEventEnvelope<Record<string, unknown>>;

describe("runtime-event-store", () => {
  it("compacts streaming events into a structural summary per run", async () => {
    const taskId = "task-1";
    const runId = "run-1";
    const structuralEnvelope = createEnvelope({
      eventId: "evt-structural",
      taskId,
      runId,
      sequence: 1,
      payload: { kind: "task.completed", taskId, detail: "done" },
    });
    const chunkEnvelope = createEnvelope({
      eventId: "evt-chunk",
      taskId,
      runId,
      sequence: 2,
      payload: { kind: "agent.chunk", taskId, agentKind: "code", text: "hello" },
    });
    const partialEnvelope = createEnvelope({
      eventId: "evt-partial",
      taskId,
      runId,
      sequence: 3,
      payload: { kind: "tool.partial", taskId, toolCallId: "tool-1", partialOutput: "world" },
    });
    const database = createMemoryDatabase([structuralEnvelope, chunkEnvelope, partialEnvelope]);
    const store = createRuntimeEventStore(database);

    const deletedCount = await store.pruneByTaskId(taskId, true);

    expect(deletedCount).toBe(2);
    const remaining = await store.replayByTaskId(taskId, 10);
    expect(remaining.map((event) => payloadKind(event))).toEqual([
      "task.completed",
      COMPACTED_STREAM_EVENT_KIND,
    ]);
    const compacted = remaining[1]?.payload as {
      kind: typeof COMPACTED_STREAM_EVENT_KIND;
      compactedEventCount: number;
      summary: string;
      truncated: boolean;
      contentHash: string;
      originalSequenceRange: { first: number; last: number };
    };
    expect(compacted.compactedEventCount).toBe(2);
    expect(compacted.summary).toBe("helloworld");
    expect(compacted.truncated).toBe(false);
    expect(compacted.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((compacted as { hashAlgorithm?: string }).hashAlgorithm).toBe("sha256-canonical-json-v1");
    expect(compacted.originalSequenceRange).toEqual({ first: 2, last: 3 });
    expect(await store.pruneByTaskId(taskId, true)).toBe(0);
  });

  it("preserves structural lifecycle and approval events during terminal compaction", async () => {
    const taskId = "task-structural";
    const runId = "run-structural";
    const database = createMemoryDatabase([
      createEnvelope({
        eventId: "evt-task-created",
        taskId,
        runId,
        sequence: 1,
        payload: { kind: "task.created", taskId },
      }),
      createEnvelope({
        eventId: "evt-step-started",
        taskId,
        runId,
        sequence: 2,
        payload: { kind: "step.started", taskId, stepId: "step-1" },
      }),
      createEnvelope({
        eventId: "evt-chunk",
        taskId,
        runId,
        sequence: 3,
        payload: { kind: "agent.chunk", taskId, agentKind: "code", text: "draft" },
      }),
      createEnvelope({
        eventId: "evt-permission-requested",
        taskId,
        runId,
        sequence: 4,
        payload: { kind: "permission.requested", taskId, approvalId: "approval-1" },
      }),
      createEnvelope({
        eventId: "evt-tool-partial",
        taskId,
        runId,
        sequence: 5,
        payload: { kind: "tool.partial", taskId, toolCallId: "tool-1", partialOutput: " output" },
      }),
      createEnvelope({
        eventId: "evt-permission-resolved",
        taskId,
        runId,
        sequence: 6,
        payload: { kind: "permission.resolved", taskId, approvalId: "approval-1", outcome: "approved" },
      }),
      createEnvelope({
        eventId: "evt-step-completed",
        taskId,
        runId,
        sequence: 7,
        payload: { kind: "step.completed", taskId, stepId: "step-1" },
      }),
      createEnvelope({
        eventId: "evt-step-failed",
        taskId,
        runId,
        sequence: 8,
        payload: { kind: "step.failed", taskId, stepId: "step-2", error: "verification failed" },
      }),
      createEnvelope({
        eventId: "evt-task-completed",
        taskId,
        runId,
        sequence: 9,
        payload: { kind: "task.completed", taskId },
      }),
    ]);
    const store = createRuntimeEventStore(database);

    expect(await store.pruneByTaskId(taskId, true)).toBe(2);

    expect((await store.replayByTaskId(taskId, 20)).map((event) => payloadKind(event))).toEqual([
      "task.created",
      "step.started",
      "permission.requested",
      "permission.resolved",
      "step.completed",
      "step.failed",
      "task.completed",
      COMPACTED_STREAM_EVENT_KIND,
    ]);
  });

  it("buildStreamingCompactionEvents keeps the summary bounded", () => {
    const taskId = "task-2";
    const runId = "run-2";
    const streamingEnvelope = createEnvelope({
      eventId: "evt-long",
      taskId,
      runId,
      sequence: 5,
      payload: {
        kind: "agent.chunk",
        taskId,
        agentKind: "code",
        text: "x".repeat(COMPACTED_STREAM_TEXT_LIMIT + 50),
      },
    });

    const compacted = buildStreamingCompactionEvents(taskId, [streamingEnvelope]);

    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.payload.summary).toHaveLength(COMPACTED_STREAM_TEXT_LIMIT + "[truncated]".length);
    expect(compacted[0]?.payload.truncated).toBe(true);
    expect(compacted[0]?.sequence).toBe(6);
  });

  it("does not compact non-terminal tasks", async () => {
    const taskId = "task-active";
    const runId = "run-active";
    const chunkEnvelope = createEnvelope({
      eventId: "evt-active-chunk",
      taskId,
      runId,
      sequence: 1,
      payload: { kind: "agent.chunk", taskId, agentKind: "code", text: "still running" },
    });
    const database = createMemoryDatabase([chunkEnvelope]);
    const store = createRuntimeEventStore(database);

    expect(await store.pruneByTaskId(taskId, true)).toBe(0);
    expect((await store.replayByTaskId(taskId, 10)).map((event) => payloadKind(event))).toEqual([
      "agent.chunk",
    ]);
  });

  it("can replay events through a checkpoint sequence without truncation", async () => {
    const taskId = "task-sequence";
    const runId = "run-sequence";
    const database = createMemoryDatabase([
      createEnvelope({
        eventId: "evt-1",
        taskId,
        runId,
        sequence: 1,
        payload: { kind: "step.started", taskId, stepId: "scan" },
      }),
      createEnvelope({
        eventId: "evt-2",
        taskId,
        runId,
        sequence: 2,
        payload: { kind: "step.completed", taskId, stepId: "scan" },
      }),
    ]);
    const store = createRuntimeEventStore(database);

    const events = await store.replayByRunIdThroughSequence(runId, 2);

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });
});

function createEnvelope(input: {
  eventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  payload: Record<string, unknown>;
}): TestRuntimeEventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId: input.eventId,
    eventVersion: 1,
    sequence: input.sequence,
    taskId: input.taskId,
    runId: input.runId,
    correlationId: input.runId,
    occurredAt: now,
    recordedAt: now,
    payload: input.payload,
  };
}

function payloadKind(envelope: RuntimeEventEnvelope): unknown {
  return (envelope.payload as { kind?: unknown }).kind;
}

function createMemoryDatabase(initialRows: RuntimeEventEnvelope[]): DesktopDatabase {
  const rows = initialRows.map((envelope) => ({
    event_id: envelope.eventId,
    task_id: envelope.taskId,
    run_id: envelope.runId,
    sequence: envelope.sequence,
    event_kind: String((envelope.payload as { kind?: string }).kind ?? "unknown"),
    envelope_json: JSON.stringify(envelope),
    recorded_at: envelope.recordedAt,
  }));

  return {
    async execute(sql, bindValues = []) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("delete from runtime_events where task_id = ? and event_kind in")) {
        const taskId = String(bindValues[0] ?? "");
        const kinds = new Set(bindValues.slice(1).map((value) => String(value ?? "")));
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index]?.task_id === taskId && kinds.has(rows[index]?.event_kind ?? "")) {
            rows.splice(index, 1);
          }
        }
        return;
      }
      if (normalized.startsWith("insert into runtime_events")) {
        const envelopeJson = String(bindValues[11] ?? "");
        const envelope = JSON.parse(envelopeJson) as RuntimeEventEnvelope;
        rows.push({
          event_id: String(bindValues[0] ?? ""),
          task_id: String(bindValues[1] ?? ""),
          run_id: String(bindValues[2] ?? ""),
          sequence: Number(bindValues[3] ?? 0),
          event_kind: String(bindValues[5] ?? "unknown"),
          envelope_json: envelopeJson,
          recorded_at: envelope.recordedAt,
        });
        return;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async select<T extends Record<string, unknown>>(sql: string, bindValues = []) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("select envelope_json from runtime_events where task_id = ?")) {
        const taskId = String(bindValues[0] ?? "");
        const limit = Number(bindValues[1] ?? 0);
        return rows
          .filter((row) => row.task_id === taskId)
          .sort((left, right) =>
            left.recorded_at.localeCompare(right.recorded_at) || left.sequence - right.sequence)
          .slice(0, limit)
          .map((row) => ({ envelope_json: row.envelope_json })) as unknown as T[];
      }
      if (normalized.startsWith("select envelope_json from runtime_events where run_id = ? and sequence <= ?")) {
        const runId = String(bindValues[0] ?? "");
        const maxSequence = Number(bindValues[1] ?? 0);
        const limit = Number(bindValues[2] ?? 0);
        return rows
          .filter((row) => row.run_id === runId && row.sequence <= maxSequence)
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, limit)
          .map((row) => ({ envelope_json: row.envelope_json })) as unknown as T[];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}
