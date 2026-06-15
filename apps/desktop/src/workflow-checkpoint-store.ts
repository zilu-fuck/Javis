import type { WorkflowCheckpoint } from "@javis/core";
import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const WORKFLOW_CHECKPOINTS_TABLE_NAME = "workflow_checkpoints";

export const WORKFLOW_CHECKPOINTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  plan_hash TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  workflow_json TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  UNIQUE(run_id, event_sequence)
)`.trim();

export const WORKFLOW_CHECKPOINTS_IDX_TASK_CREATED_SQL = `
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_task_created ON workflow_checkpoints (task_id, created_at)
`.trim();

export const WORKFLOW_CHECKPOINTS_IDX_RUN_SEQUENCE_SQL = `
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_run_sequence ON workflow_checkpoints (run_id, event_sequence)
`.trim();

export const WORKFLOW_CHECKPOINTS_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "040_workflow_checkpoints_schema",
  sql: WORKFLOW_CHECKPOINTS_SCHEMA_SQL,
};
export const WORKFLOW_CHECKPOINTS_IDX_TASK_CREATED_MIGRATION: DesktopDatabaseMigration = {
  id: "041_workflow_checkpoints_idx_task_created",
  sql: WORKFLOW_CHECKPOINTS_IDX_TASK_CREATED_SQL,
};
export const WORKFLOW_CHECKPOINTS_IDX_RUN_SEQUENCE_MIGRATION: DesktopDatabaseMigration = {
  id: "042_workflow_checkpoints_idx_run_sequence",
  sql: WORKFLOW_CHECKPOINTS_IDX_RUN_SEQUENCE_SQL,
};

export const WORKFLOW_CHECKPOINT_MIGRATIONS: DesktopDatabaseMigration[] = [
  WORKFLOW_CHECKPOINTS_SCHEMA_MIGRATION,
  WORKFLOW_CHECKPOINTS_IDX_TASK_CREATED_MIGRATION,
  WORKFLOW_CHECKPOINTS_IDX_RUN_SEQUENCE_MIGRATION,
];

export interface WorkflowCheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  latestByRunId(runId: string): Promise<WorkflowCheckpoint | undefined>;
  latestByTaskId(taskId: string): Promise<WorkflowCheckpoint | undefined>;
  listByTaskId(taskId: string, limit?: number): Promise<WorkflowCheckpoint[]>;
  pruneByTaskId(taskId: string, keepLatest: number): Promise<number>;
}

export function createWorkflowCheckpointStore(database: DesktopDatabase): WorkflowCheckpointStore {
  return {
    async save(checkpoint) {
      const checkpointId = `ckpt-${checkpoint.runId}-${checkpoint.eventSequence}`;
      await database.execute(
        `INSERT INTO workflow_checkpoints (checkpoint_id, task_id, run_id, workflow_id, workflow_version, plan_hash, event_sequence, created_at, workflow_json, checkpoint_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(checkpoint_id) DO UPDATE SET task_id = excluded.task_id, run_id = excluded.run_id, workflow_id = excluded.workflow_id, workflow_version = excluded.workflow_version, plan_hash = excluded.plan_hash, event_sequence = excluded.event_sequence, created_at = excluded.created_at, workflow_json = excluded.workflow_json, checkpoint_json = excluded.checkpoint_json`,
        [
          checkpointId,
          checkpoint.taskId,
          checkpoint.runId,
          checkpoint.workflowId,
          checkpoint.workflowVersion,
          checkpoint.planHash,
          checkpoint.eventSequence,
          checkpoint.createdAt,
          JSON.stringify(checkpoint.workflowSnapshot),
          JSON.stringify(checkpoint),
        ],
      );
    },

    async latestByRunId(runId) {
      const rows = await database.select<{ checkpoint_json: string }>(
        `SELECT checkpoint_json FROM workflow_checkpoints WHERE run_id = ? ORDER BY event_sequence DESC LIMIT 1`,
        [runId],
      );
      if (rows.length === 0) return undefined;
      return JSON.parse(rows[0].checkpoint_json) as WorkflowCheckpoint;
    },

    async latestByTaskId(taskId) {
      const rows = await database.select<{ checkpoint_json: string }>(
        `SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
        [taskId],
      );
      if (rows.length === 0) return undefined;
      return JSON.parse(rows[0].checkpoint_json) as WorkflowCheckpoint;
    },

    async listByTaskId(taskId, limit) {
      const rows = await database.select<{ checkpoint_json: string }>(
        `SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY event_sequence DESC LIMIT ?`,
        [taskId, limit ?? 50],
      );
      return rows.map((row) => JSON.parse(row.checkpoint_json) as WorkflowCheckpoint);
    },

    async pruneByTaskId(taskId, keepLatest) {
      const rows = await database.select<{ checkpoint_id: string }>(
        `SELECT checkpoint_id FROM workflow_checkpoints WHERE task_id = ? ORDER BY event_sequence DESC`,
        [taskId],
      );
      if (rows.length <= keepLatest) return 0;
      const toRemove = rows.slice(keepLatest);
      for (const row of toRemove) {
        await database.execute(
          `DELETE FROM workflow_checkpoints WHERE checkpoint_id = ?`,
          [row.checkpoint_id],
        );
      }
      return toRemove.length;
    },
  };
}

export function sanitizeWorkflowCheckpoint(value: unknown): WorkflowCheckpoint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.taskId !== "string") return undefined;
  if (typeof obj.runId !== "string") return undefined;
  if (typeof obj.workflowId !== "string") return undefined;
  if (typeof obj.eventSequence !== "number") return undefined;
  if (!Array.isArray(obj.completedStepIds)) return undefined;
  if (!Array.isArray(obj.abandonedStepIds)) return undefined;
  if (!Array.isArray(obj.pendingStepIds)) return undefined;
  if (!Array.isArray(obj.runningStepIds)) return undefined;
  return obj as unknown as WorkflowCheckpoint;
}
