import { computeContentHash, extractEventKind, isStreamingEvent } from "@javis/core";
import type { RuntimeEventEnvelope, RuntimeEventKind } from "@javis/core";
import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const RUNTIME_EVENTS_TABLE_NAME = "runtime_events";

export const RUNTIME_EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_version INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  workflow_id TEXT,
  step_id TEXT,
  agent_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  UNIQUE(run_id, sequence)
)`.trim();

export const RUNTIME_EVENTS_IDX_TASK_RECORDED_SQL = `
CREATE INDEX IF NOT EXISTS idx_runtime_events_task_recorded ON runtime_events (task_id, recorded_at)
`.trim();

export const RUNTIME_EVENTS_IDX_RUN_SEQUENCE_SQL = `
CREATE INDEX IF NOT EXISTS idx_runtime_events_run_sequence ON runtime_events (run_id, sequence)
`.trim();

export const RUNTIME_EVENTS_IDX_WORKFLOW_RECORDED_SQL = `
CREATE INDEX IF NOT EXISTS idx_runtime_events_workflow_recorded ON runtime_events (workflow_id, recorded_at)
`.trim();

export const RUNTIME_EVENTS_IDX_KIND_RECORDED_SQL = `
CREATE INDEX IF NOT EXISTS idx_runtime_events_kind_recorded ON runtime_events (event_kind, recorded_at)
`.trim();

export const RUNTIME_EVENTS_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "030_runtime_events_schema",
  sql: RUNTIME_EVENTS_SCHEMA_SQL,
};
export const RUNTIME_EVENTS_IDX_TASK_RECORDED_MIGRATION: DesktopDatabaseMigration = {
  id: "031_runtime_events_idx_task_recorded",
  sql: RUNTIME_EVENTS_IDX_TASK_RECORDED_SQL,
};
export const RUNTIME_EVENTS_IDX_RUN_SEQUENCE_MIGRATION: DesktopDatabaseMigration = {
  id: "032_runtime_events_idx_run_sequence",
  sql: RUNTIME_EVENTS_IDX_RUN_SEQUENCE_SQL,
};
export const RUNTIME_EVENTS_IDX_WORKFLOW_RECORDED_MIGRATION: DesktopDatabaseMigration = {
  id: "033_runtime_events_idx_workflow_recorded",
  sql: RUNTIME_EVENTS_IDX_WORKFLOW_RECORDED_SQL,
};
export const RUNTIME_EVENTS_IDX_KIND_RECORDED_MIGRATION: DesktopDatabaseMigration = {
  id: "034_runtime_events_idx_kind_recorded",
  sql: RUNTIME_EVENTS_IDX_KIND_RECORDED_SQL,
};

export const RUNTIME_EVENT_MIGRATIONS: DesktopDatabaseMigration[] = [
  RUNTIME_EVENTS_SCHEMA_MIGRATION,
  RUNTIME_EVENTS_IDX_TASK_RECORDED_MIGRATION,
  RUNTIME_EVENTS_IDX_RUN_SEQUENCE_MIGRATION,
  RUNTIME_EVENTS_IDX_WORKFLOW_RECORDED_MIGRATION,
  RUNTIME_EVENTS_IDX_KIND_RECORDED_MIGRATION,
];

export interface RuntimeEventStore {
  append(envelope: RuntimeEventEnvelope): Promise<void>;
  appendBatch(envelopes: RuntimeEventEnvelope[]): Promise<void>;
  replayByRunId(runId: string): Promise<RuntimeEventEnvelope[]>;
  replayByRunIdThroughSequence(runId: string, eventSequence: number): Promise<RuntimeEventEnvelope[]>;
  replayByTaskId(taskId: string, limit?: number): Promise<RuntimeEventEnvelope[]>;
  latestByRunId(runId: string): Promise<RuntimeEventEnvelope | undefined>;
  pruneByTaskId(taskId: string, keepStructuralOnly: boolean): Promise<number>;
  countByRunId(runId: string): Promise<number>;
}

const MAX_ENVELOPES_PER_QUERY = 10_000;
const DEFAULT_TASK_REPLAY_LIMIT = 5_000;
const SQLITE_UNBOUNDED_LIMIT = -1;
const EVENT_ID_DELETE_BATCH_SIZE = 900;
export const COMPACTED_STREAM_TEXT_LIMIT = 20_000;
export const COMPACTED_STREAM_EVENT_KIND = "runtime.compacted";

export interface CompactedRuntimeStreamPayload {
  kind: typeof COMPACTED_STREAM_EVENT_KIND;
  taskId: string;
  compactedEventKinds: RuntimeEventKind[];
  compactedEventCount: number;
  originalSequenceRange: { first: number; last: number };
  summary: string;
  contentHash: string;
  hashAlgorithm: "sha256-canonical-json-v1";
  truncated: boolean;
}

export function createRuntimeEventStore(database: DesktopDatabase): RuntimeEventStore {
  return {
    async append(envelope) {
      await insertEnvelope(database, envelope);
    },

    async appendBatch(envelopes) {
      for (const envelope of envelopes) {
        await insertEnvelope(database, envelope);
      }
    },

    async replayByRunId(runId) {
      const latest = await this.latestByRunId(runId);
      if (!latest) return [];
      return this.replayByRunIdThroughSequence(runId, latest.sequence);
    },

    async replayByRunIdThroughSequence(runId, eventSequence) {
      const limit = Math.max(MAX_ENVELOPES_PER_QUERY, Math.trunc(eventSequence) + 1);
      const rows = await database.select<{ envelope_json: string }>(
        `SELECT envelope_json FROM runtime_events WHERE run_id = ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?`,
        [runId, eventSequence, limit],
      );
      return rows.map((row) => JSON.parse(row.envelope_json) as RuntimeEventEnvelope);
    },

    async replayByTaskId(taskId, limit) {
      const rows = await database.select<{ envelope_json: string }>(
        `SELECT envelope_json FROM runtime_events WHERE task_id = ? ORDER BY recorded_at ASC, sequence ASC LIMIT ?`,
        [taskId, limit ?? DEFAULT_TASK_REPLAY_LIMIT],
      );
      return rows.map((row) => JSON.parse(row.envelope_json) as RuntimeEventEnvelope);
    },

    async latestByRunId(runId) {
      const rows = await database.select<{ envelope_json: string }>(
        `SELECT envelope_json FROM runtime_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1`,
        [runId],
      );
      if (rows.length === 0) return undefined;
      return JSON.parse(rows[0].envelope_json) as RuntimeEventEnvelope;
    },

    async pruneByTaskId(taskId, keepStructuralOnly) {
      if (keepStructuralOnly) {
        const events = await this.replayByTaskId(taskId, SQLITE_UNBOUNDED_LIMIT);
        const terminalRunIds = terminalRunIdsForTask(taskId, events);
        if (terminalRunIds.size === 0) {
          return 0;
        }
        const compactionEvents = buildStreamingCompactionEvents(taskId, events, terminalRunIds);
        const compactedEventIds = events
          .filter((event) => {
            if (event.taskId !== taskId || !terminalRunIds.has(event.runId)) return false;
            const kind = safeExtractEventKind(event);
            return Boolean(kind && isStreamingEvent(kind));
          })
          .map((event) => event.eventId);
        const compactedEventCount = compactedEventIds.length;
        if (compactedEventCount === 0) {
          return 0;
        }
        if (database.compactRuntimeEvents) {
          await database.compactRuntimeEvents(taskId, compactedEventIds, compactionEvents);
        } else {
          await compactRuntimeEventsFallback(database, taskId, compactedEventIds, compactionEvents);
        }
        return compactedEventCount;
      } else {
        await database.execute(
          `DELETE FROM runtime_events WHERE task_id = ?`,
          [taskId],
        );
      }
      return 0;
    },

    async countByRunId(runId) {
      const rows = await database.select<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?`,
        [runId],
      );
      return rows[0]?.count ?? 0;
    },
  };
}

async function compactRuntimeEventsFallback(
  database: DesktopDatabase,
  taskId: string,
  eventIds: string[],
  compactionEvents: RuntimeEventEnvelope[],
): Promise<void> {
  await database.execute("BEGIN TRANSACTION");
  try {
    await deleteRuntimeEventsByEventId(database, taskId, eventIds);
    for (const envelope of compactionEvents) {
      await insertEnvelope(database, envelope);
    }
    await database.execute("COMMIT");
  } catch (error) {
    try {
      await database.execute("ROLLBACK");
    } catch (rollbackError) {
      console.error("[RuntimeEvents] Failed to roll back stream compaction.", rollbackError);
    }
    throw error;
  }
}

async function deleteRuntimeEventsByEventId(
  database: DesktopDatabase,
  taskId: string,
  eventIds: string[],
): Promise<void> {
  for (let offset = 0; offset < eventIds.length; offset += EVENT_ID_DELETE_BATCH_SIZE) {
    const batch = eventIds.slice(offset, offset + EVENT_ID_DELETE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    await database.execute(
      `DELETE FROM runtime_events WHERE task_id = ? AND event_id IN (${placeholders})`,
      [taskId, ...batch],
    );
  }
}

function terminalRunIdsForTask(taskId: string, events: RuntimeEventEnvelope[]): Set<string> {
  const runIds = new Set<string>();
  for (const event of events) {
    const payload = event.payload as { kind?: string; taskId?: string };
    if (event.taskId === taskId && payload.taskId === taskId &&
      (payload.kind === "task.completed" || payload.kind === "task.failed")) {
      runIds.add(event.runId);
    }
  }
  return runIds;
}

export function buildStreamingCompactionEvents(
  taskId: string,
  events: RuntimeEventEnvelope[],
  eligibleRunIds?: ReadonlySet<string>,
): RuntimeEventEnvelope<CompactedRuntimeStreamPayload>[] {
  const eventsByRun = new Map<string, RuntimeEventEnvelope[]>();
  const maxSequenceByRun = new Map<string, number>();
  for (const envelope of events) {
    if (envelope.taskId !== taskId ||
      eligibleRunIds !== undefined && !eligibleRunIds.has(envelope.runId)) continue;
    maxSequenceByRun.set(
      envelope.runId,
      Math.max(maxSequenceByRun.get(envelope.runId) ?? 0, envelope.sequence),
    );
    const kind = safeExtractEventKind(envelope);
    if (kind && isStreamingEvent(kind)) {
      const current = eventsByRun.get(envelope.runId) ?? [];
      current.push(envelope);
      eventsByRun.set(envelope.runId, current);
    }
  }

  const compacted: RuntimeEventEnvelope<CompactedRuntimeStreamPayload>[] = [];
  for (const [runId, streamingEvents] of eventsByRun) {
    if (streamingEvents.length === 0) continue;
    streamingEvents.sort((left, right) => left.sequence - right.sequence);
    const representative = streamingEvents[0];
    if (!representative) continue;
    const nextSequence = (maxSequenceByRun.get(runId) ?? representative.sequence) + 1;
    const now = new Date().toISOString();
    const payload = buildCompactedStreamPayload(taskId, streamingEvents);
    compacted.push({
      eventId: `evt-${runId}-stream-compacted-${nextSequence}`,
      eventVersion: 1,
      sequence: nextSequence,
      taskId,
      runId,
      workflowId: representative.workflowId,
      correlationId: representative.correlationId,
      traceId: representative.traceId,
      occurredAt: now,
      recordedAt: now,
      payload,
    });
  }
  return compacted;
}

function buildCompactedStreamPayload(
  taskId: string,
  streamingEvents: RuntimeEventEnvelope[],
): CompactedRuntimeStreamPayload {
  const chunks = extractStreamTextChunks(streamingEvents);
  const fullText = chunks.filter((chunk) => chunk.length > 0).join("");
  const summary = fullText.length > COMPACTED_STREAM_TEXT_LIMIT
    ? `${fullText.slice(0, COMPACTED_STREAM_TEXT_LIMIT)}[truncated]`
    : fullText;
  const kinds = Array.from(new Set(
    streamingEvents
      .map((event) => safeExtractEventKind(event))
      .filter((kind): kind is RuntimeEventKind => Boolean(kind)),
  ));
  return {
    kind: COMPACTED_STREAM_EVENT_KIND,
    taskId,
    compactedEventKinds: kinds,
    compactedEventCount: streamingEvents.length,
    originalSequenceRange: {
      first: streamingEvents[0]?.sequence ?? 0,
      last: streamingEvents[streamingEvents.length - 1]?.sequence ?? 0,
    },
    summary,
    contentHash: computeContentHash({
      kinds,
      payloads: streamingEvents.map((event) => event.payload),
      sequences: streamingEvents.map((event) => event.sequence),
    }),
    hashAlgorithm: "sha256-canonical-json-v1",
    truncated: fullText.length > COMPACTED_STREAM_TEXT_LIMIT,
  };
}

function safeExtractEventKind(envelope: RuntimeEventEnvelope): RuntimeEventKind | undefined {
  try {
    return extractEventKind(envelope);
  } catch {
    return undefined;
  }
}

function extractStreamTextChunks(streamingEvents: RuntimeEventEnvelope[]): string[] {
  const hasAgentChunks = streamingEvents.some((event) => safeExtractEventKind(event) === "agent.chunk");
  return streamingEvents.map((event) => extractStreamText(event, hasAgentChunks));
}

function extractStreamText(envelope: RuntimeEventEnvelope, hasAgentChunks: boolean): string {
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  const kind = safeExtractEventKind(envelope);
  if (typeof record.text === "string") return record.text;
  if (typeof record.partialOutput === "string") return record.partialOutput;
  if (kind === "agent.chunk_end" && !hasAgentChunks && typeof record.fullText === "string") return record.fullText;
  if (kind === "agent.chunk_start" || kind === "agent.chunk_end") return "";
  return JSON.stringify(record);
}

async function insertEnvelope(
  database: DesktopDatabase,
  envelope: RuntimeEventEnvelope,
): Promise<void> {
  const kind = (envelope.payload as { kind?: string })?.kind ?? "unknown";
  await database.execute(
    `INSERT INTO runtime_events (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
    [
      envelope.eventId,
      envelope.taskId,
      envelope.runId,
      envelope.sequence,
      envelope.eventVersion,
      kind,
      envelope.workflowId ?? null,
      envelope.stepId ?? null,
      envelope.agentId ?? null,
      envelope.occurredAt,
      envelope.recordedAt,
      JSON.stringify(envelope),
    ],
  );
}

export function sanitizeRuntimeEventEnvelope(value: unknown): RuntimeEventEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.eventId !== "string") return undefined;
  if (typeof obj.taskId !== "string") return undefined;
  if (typeof obj.runId !== "string") return undefined;
  if (typeof obj.sequence !== "number") return undefined;
  if (typeof obj.eventVersion !== "number") return undefined;
  if (typeof obj.occurredAt !== "string") return undefined;
  if (typeof obj.recordedAt !== "string") return undefined;
  if (obj.payload === undefined) return undefined;
  return obj as unknown as RuntimeEventEnvelope;
}
