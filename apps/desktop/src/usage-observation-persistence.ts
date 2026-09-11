import type { UsageObservation, WorkflowExecutionBackend } from "@javis/core";
import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

/**
 * Durable per-call usage observation ledger (dual-kernel plan §12).
 *
 * Every model call upserts one canonical row addressed by call_id with a
 * monotonically increasing revision; a final record seals the call. The
 * task total always sums the latest record of each call, so stream + final
 * usage is never double counted and failed-call usage survives.
 */
export const USAGE_OBSERVATIONS_TABLE_NAME = "usage_observations";

export const USAGE_OBSERVATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_observations (
  call_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  final INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  workflow_run_id TEXT,
  step_id TEXT,
  attempt INTEGER,
  agent_kind TEXT NOT NULL,
  backend TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  context_window_tokens INTEGER,
  availability TEXT NOT NULL,
  semantics TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  updated_at TEXT NOT NULL
)`.trim();

export const USAGE_OBSERVATIONS_IDX_TASK_UPDATED_SQL = `
CREATE INDEX IF NOT EXISTS idx_usage_observations_task_updated
  ON usage_observations (task_id, updated_at)
`.trim();

export const USAGE_OBSERVATIONS_IDX_BACKEND_SQL = `
CREATE INDEX IF NOT EXISTS idx_usage_observations_backend
  ON usage_observations (backend, provider, model)
`.trim();

export const USAGE_OBSERVATIONS_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "050_usage_observations_schema",
  sql: USAGE_OBSERVATIONS_SCHEMA_SQL,
};
export const USAGE_OBSERVATIONS_IDX_TASK_UPDATED_MIGRATION: DesktopDatabaseMigration = {
  id: "051_usage_observations_idx_task_updated",
  sql: USAGE_OBSERVATIONS_IDX_TASK_UPDATED_SQL,
};
export const USAGE_OBSERVATIONS_IDX_BACKEND_MIGRATION: DesktopDatabaseMigration = {
  id: "052_usage_observations_idx_backend",
  sql: USAGE_OBSERVATIONS_IDX_BACKEND_SQL,
};

export const USAGE_OBSERVATION_MIGRATIONS: DesktopDatabaseMigration[] = [
  USAGE_OBSERVATIONS_SCHEMA_MIGRATION,
  USAGE_OBSERVATIONS_IDX_TASK_UPDATED_MIGRATION,
  USAGE_OBSERVATIONS_IDX_BACKEND_MIGRATION,
];

const USAGE_OBSERVATION_UPSERT_SQL = `
INSERT INTO usage_observations (
  call_id, revision, final, task_id, workflow_run_id, step_id, attempt,
  agent_kind, backend, provider, model, context_window_tokens,
  availability, semantics, input_tokens, output_tokens, total_tokens, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(call_id) DO UPDATE SET
  revision = excluded.revision,
  final = excluded.final,
  task_id = excluded.task_id,
  workflow_run_id = excluded.workflow_run_id,
  step_id = excluded.step_id,
  attempt = excluded.attempt,
  agent_kind = excluded.agent_kind,
  backend = excluded.backend,
  provider = excluded.provider,
  model = excluded.model,
  context_window_tokens = excluded.context_window_tokens,
  availability = excluded.availability,
  semantics = excluded.semantics,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  total_tokens = excluded.total_tokens,
  updated_at = excluded.updated_at
`.trim();

const USAGE_OBSERVATION_SELECT_BY_TASK_SQL = `
SELECT call_id, revision, final, task_id, workflow_run_id, step_id, attempt,
       agent_kind, backend, provider, model, context_window_tokens,
       availability, semantics, input_tokens, output_tokens, total_tokens
FROM usage_observations
WHERE task_id = ?
ORDER BY updated_at ASC
`.trim();

export interface UsageObservationStore {
  /** Idempotent per-call upsert; the revision guard rejects stale events. */
  upsert(observation: UsageObservation): Promise<void>;
  listByTaskId(taskId: string): Promise<UsageObservation[]>;
}

export function createUsageObservationStore(database: DesktopDatabase): UsageObservationStore {
  return {
    async upsert(observation) {
      await database.execute(USAGE_OBSERVATION_UPSERT_SQL, [
        observation.callId,
        observation.revision,
        observation.final ? 1 : 0,
        observation.taskId,
        observation.workflowRunId ?? null,
        observation.stepId ?? null,
        observation.attempt ?? null,
        observation.agentKind,
        observation.backend,
        observation.provider ?? null,
        observation.model ?? null,
        observation.contextWindowTokens ?? null,
        observation.availability,
        observation.semantics,
        observation.inputTokens ?? null,
        observation.outputTokens ?? null,
        observation.totalTokens ?? null,
        new Date().toISOString(),
      ]);
    },
    async listByTaskId(taskId) {
      const rows = await database.select<Record<string, unknown>>(
        USAGE_OBSERVATION_SELECT_BY_TASK_SQL,
        [taskId],
      );
      return rows.flatMap((row) => parseUsageObservationRow(row));
    },
  };
}

function parseUsageObservationRow(row: Record<string, unknown>): UsageObservation[] {
  if (typeof row.call_id !== "string" ||
    !Number.isInteger(row.revision) || (row.revision as number) < 1 ||
    typeof row.final !== "number" ||
    typeof row.task_id !== "string" ||
    typeof row.agent_kind !== "string" ||
    typeof row.backend !== "string" ||
    (row.availability !== "reported" && row.availability !== "unavailable") ||
    typeof row.semantics !== "string") {
    return [];
  }
  const observation: UsageObservation = {
    callId: row.call_id,
    revision: row.revision as number,
    final: row.final === 1,
    taskId: row.task_id,
    agentKind: row.agent_kind as UsageObservation["agentKind"],
    backend: row.backend as WorkflowExecutionBackend,
    availability: row.availability as "reported" | "unavailable",
    semantics: row.semantics as "cumulative_for_call",
  };
  const target = observation as unknown as Record<string, unknown>;
  for (const [key, destination] of [
    ["workflow_run_id", "workflowRunId"],
    ["step_id", "stepId"],
    ["provider", "provider"],
    ["model", "model"],
  ] as const) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) {
      target[destination] = value;
    }
  }
  if (Number.isInteger(row.attempt)) target.attempt = row.attempt as number;
  for (const [key, destination] of [
    ["context_window_tokens", "contextWindowTokens"],
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
    ["total_tokens", "totalTokens"],
  ] as const) {
    if (Number.isInteger(row[key])) {
      target[destination] = row[key];
    }
  }
  return [observation];
}
