import type { RuntimeEventEnvelope } from "@javis/core";
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
  replayByTaskId(taskId: string, limit?: number): Promise<RuntimeEventEnvelope[]>;
  latestByRunId(runId: string): Promise<RuntimeEventEnvelope | undefined>;
  pruneByTaskId(taskId: string, keepStructuralOnly: boolean): Promise<number>;
  countByRunId(runId: string): Promise<number>;
}

const MAX_ENVELOPES_PER_QUERY = 10_000;
const DEFAULT_TASK_REPLAY_LIMIT = 5_000;

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
      const rows = await database.select<{ envelope_json: string }>(
        `SELECT envelope_json FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?`,
        [runId, MAX_ENVELOPES_PER_QUERY],
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
        await database.execute(
          `DELETE FROM runtime_events WHERE task_id = ? AND event_kind IN (?, ?, ?, ?)`,
          [taskId, "agent.chunk_start", "agent.chunk", "agent.chunk_end", "tool.partial"],
        );
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

async function insertEnvelope(
  database: DesktopDatabase,
  envelope: RuntimeEventEnvelope,
): Promise<void> {
  const kind = (envelope.payload as { kind?: string })?.kind ?? "unknown";
  await database.execute(
    `INSERT INTO runtime_events (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
