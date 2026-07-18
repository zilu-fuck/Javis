import {
  computePlanHash,
  sanitizeArtifactForPersistence,
  validateArtifactEnvelope,
  type WorkflowCheckpoint,
  type WorkbenchWorkflow,
} from "@javis/core";
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
      const persistedCheckpoint = sanitizeCheckpointForPersistence(checkpoint);
      if (!sanitizeWorkflowCheckpoint(persistedCheckpoint)) {
        throw new Error("Refusing to persist an invalid workflow checkpoint.");
      }
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
          JSON.stringify(persistedCheckpoint),
        ],
      );
    },

    async latestByRunId(runId) {
      const rows = await database.select<{ checkpoint_json: string }>(
        `SELECT checkpoint_json FROM workflow_checkpoints WHERE run_id = ? ORDER BY event_sequence DESC LIMIT 1`,
        [runId],
      );
      if (rows.length === 0) return undefined;
      return parsePersistedCheckpoint(rows[0].checkpoint_json, { runId });
    },

    async latestByTaskId(taskId) {
      const rows = await database.select<{ checkpoint_json: string }>(
        `SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [taskId],
      );
      if (rows.length === 0) return undefined;
      return parsePersistedCheckpoint(rows[0].checkpoint_json, { taskId });
    },

    async listByTaskId(taskId, limit) {
      const rows = await database.select<{ checkpoint_json: string }>(
        `SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        [taskId, limit ?? 50],
      );
      return rows
        .map((row) => parsePersistedCheckpoint(row.checkpoint_json, { taskId }))
        .filter((checkpoint): checkpoint is WorkflowCheckpoint => checkpoint !== undefined);
    },

    async pruneByTaskId(taskId, keepLatest) {
      const rows = await database.select<{ checkpoint_id: string }>(
        `SELECT checkpoint_id FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`,
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

export function sanitizeCheckpointForPersistence(checkpoint: WorkflowCheckpoint): WorkflowCheckpoint {
  const contextSnapshot: WorkflowCheckpoint["contextSnapshot"] = {};
  for (const [key, envelope] of Object.entries(checkpoint.contextSnapshot)) {
    contextSnapshot[key] = sanitizeArtifactForPersistence(envelope);
  }
  return {
    ...checkpoint,
    contextSnapshot,
  };
}

function parsePersistedCheckpoint(
  serialized: string,
  expected: { taskId?: string; runId?: string },
): WorkflowCheckpoint | undefined {
  try {
    const parsed = JSON.parse(serialized);
    const checkpoint = sanitizeWorkflowCheckpoint(parsed);
    if (!checkpoint) return undefined;
    if (expected.taskId !== undefined && checkpoint.taskId !== expected.taskId) return undefined;
    if (expected.runId !== undefined && checkpoint.runId !== expected.runId) return undefined;
    return checkpoint;
  } catch {
    return undefined;
  }
}

export function sanitizeWorkflowCheckpoint(value: unknown): WorkflowCheckpoint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!isNonEmptyString(obj.taskId) || !isNonEmptyString(obj.runId) || !isNonEmptyString(obj.workflowId)) return undefined;
  if (!Number.isInteger(obj.workflowVersion) || (obj.workflowVersion as number) < 1) return undefined;
  if (!isNonEmptyString(obj.planHash) || !Number.isInteger(obj.eventSequence) || (obj.eventSequence as number) < 0) return undefined;
  if (!isNonEmptyString(obj.createdAt)) return undefined;
  if (!isStringArray(obj.completedStepIds) || !isStringArray(obj.abandonedStepIds) ||
    !isStringArray(obj.pendingStepIds) || !isStringArray(obj.runningStepIds) ||
    !isStringArray(obj.approvalRequestIds)) return undefined;
  if (!isWorkflowSnapshot(obj.workflowSnapshot) || obj.workflowSnapshot.id !== obj.workflowId) return undefined;
  if (!hasValidCheckpointStepPartition(obj.workflowSnapshot, [
    obj.completedStepIds,
    obj.abandonedStepIds,
    obj.pendingStepIds,
    obj.runningStepIds,
  ])) return undefined;
  if (computePlanHash(obj.workflowSnapshot.steps) !== obj.planHash) return undefined;
  if (typeof obj.contextSnapshot !== "object" || obj.contextSnapshot === null) return undefined;
  for (const envelope of Object.values(obj.contextSnapshot as Record<string, unknown>)) {
    if (!validateArtifactEnvelope(envelope, { taskId: obj.taskId, runId: obj.runId })) return undefined;
  }
  return obj as unknown as WorkflowCheckpoint;
}

function isWorkflowSnapshot(value: unknown): value is WorkbenchWorkflow {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return isNonEmptyString(snapshot.id) && Array.isArray(snapshot.steps) && snapshot.steps.every(
    (step) => typeof step === "object" && step !== null &&
      isNonEmptyString((step as Record<string, unknown>).id),
  );
}

function hasValidCheckpointStepPartition(
  workflow: WorkbenchWorkflow,
  stateGroups: string[][],
): boolean {
  const workflowStepIds = workflow.steps.map((step) => step.id);
  const knownStepIds = new Set(workflowStepIds);
  if (knownStepIds.size !== workflowStepIds.length) return false;

  const seen = new Set<string>();
  for (const group of stateGroups) {
    for (const stepId of group) {
      if (!knownStepIds.has(stepId) || seen.has(stepId)) return false;
      seen.add(stepId);
    }
  }
  return seen.size === knownStepIds.size;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}
