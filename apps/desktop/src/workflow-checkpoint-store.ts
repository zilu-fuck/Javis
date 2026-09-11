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
  if (obj.agentRuntimeMetrics !== undefined &&
    !isAgentRuntimeMetricsSnapshotArray(obj.agentRuntimeMetrics)) return undefined;
  if (obj.agentRuntimeRoutingMetrics !== undefined &&
    !isAgentRuntimeRoutingMetricsSnapshotArray(obj.agentRuntimeRoutingMetrics)) return undefined;
  if (obj.tokenUsage !== undefined && !isTokenUsageSummary(obj.tokenUsage)) return undefined;
  if (obj.usageObservations !== undefined && !isUsageObservationArray(obj.usageObservations)) return undefined;
  return obj as unknown as WorkflowCheckpoint;
}

function isUsageObservationArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 10_000) return false;
  for (const item of value) {
    if (typeof item !== "object" || item === null) return false;
    const observation = item as Record<string, unknown>;
    if (!isNonEmptyString(observation.callId) ||
      !isNonEmptyString(observation.taskId) ||
      !Number.isInteger(observation.revision) ||
      (observation.revision as number) < 1 ||
      typeof observation.final !== "boolean" ||
      !isNonEmptyString(observation.agentKind) ||
      !isNonEmptyString(observation.backend) ||
      (observation.availability !== "reported" && observation.availability !== "unavailable")) {
      return false;
    }
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "contextWindowTokens", "attempt"]) {
      if (observation[key] !== undefined && !isNonNegativeInteger(observation[key])) return false;
    }
  }
  return true;
}

function isAgentRuntimeRoutingMetricsSnapshotArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 200) return false;
  const dimensions = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return false;
    const metrics = item as Record<string, unknown>;
    const opencodeRouteCount = metrics.opencodeRouteCount === undefined
      ? 0
      : metrics.opencodeRouteCount;
    const javisSpecializedRouteCount = metrics.javisSpecializedRouteCount === undefined
      ? 0
      : metrics.javisSpecializedRouteCount;
    if (!isCanonicalBoundedString(metrics.providerId, 160) ||
      metrics.providerId !== (metrics.providerId as string).toLowerCase() ||
      !isCanonicalBoundedString(metrics.agentKind, 160) ||
      !isCanonicalBoundedString(metrics.taskType, 80) ||
      !isNonNegativeInteger(metrics.routeCount) ||
      !isNonNegativeInteger(metrics.rolloutTargetCount) ||
      !isNonNegativeInteger(metrics.langchainRouteCount) ||
      !isNonNegativeInteger(opencodeRouteCount) ||
      !isNonNegativeInteger(metrics.legacyRouteCount) ||
      !isNonNegativeInteger(metrics.unavailableRouteCount) ||
      !isNonNegativeInteger(javisSpecializedRouteCount) ||
      !isNonNegativeInteger(metrics.fallbackCount) ||
      (metrics.rolloutTargetCount as number) > (metrics.routeCount as number) ||
      (metrics.langchainRouteCount as number) +
        (opencodeRouteCount as number) +
        (metrics.legacyRouteCount as number) +
        (metrics.unavailableRouteCount as number) +
        (javisSpecializedRouteCount as number) !== metrics.routeCount ||
      (metrics.langchainRouteCount as number) +
        (opencodeRouteCount as number) +
        (metrics.fallbackCount as number) !== metrics.rolloutTargetCount ||
      !isRatio(metrics.fallbackRate)) return false;
    const expectedRate = (metrics.rolloutTargetCount as number) === 0
      ? 0
      : (metrics.fallbackCount as number) / (metrics.rolloutTargetCount as number);
    if (Math.abs((metrics.fallbackRate as number) - expectedRate) > 1e-12) return false;
    if (!isAgentRuntimeFallbackReasonCounts(metrics.fallbackReasons, metrics.fallbackCount as number)) {
      return false;
    }
    if (!isUniqueBoundedStringArray(
      metrics.observationIds,
      metrics.routeCount as number,
      320,
    )) return false;
    const key = `${metrics.providerId}\u0000${metrics.agentKind}\u0000${metrics.taskType}`;
    if (dimensions.has(key)) return false;
    dimensions.add(key);
  }
  return true;
}

function isUniqueBoundedStringArray(
  value: unknown,
  expectedLength: number,
  maxItemLength: number,
): boolean {
  return Array.isArray(value) && value.length === expectedLength &&
    value.every((item) => isCanonicalBoundedString(item, maxItemLength)) &&
    new Set(value).size === value.length;
}

function isAgentRuntimeFallbackReasonCounts(value: unknown, fallbackCount: number): boolean {
  if (!Array.isArray(value) || value.length > 5) return false;
  const reasons = new Set<string>();
  let total = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null) return false;
    const entry = item as Record<string, unknown>;
    if ((entry.reason !== "native_tool_call_unavailable" &&
      entry.reason !== "runtime_factory_unavailable" &&
      entry.reason !== "runtime_initialization_failed" &&
      entry.reason !== "eligible_tools_unavailable" &&
      entry.reason !== "legacy_backend_selected") ||
      reasons.has(entry.reason) || !isNonNegativeInteger(entry.count) || entry.count === 0) {
      return false;
    }
    reasons.add(entry.reason);
    total += entry.count as number;
  }
  return total === fallbackCount;
}

function isTokenUsageSummary(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  if (!isNonNegativeInteger(summary.inputTokens) ||
    !isNonNegativeInteger(summary.outputTokens) ||
    !isNonNegativeInteger(summary.totalTokens) ||
    !isNonNegativeInteger(summary.modelCalls) ||
    (summary.peakContextTokens !== undefined &&
      !isNonNegativeInteger(summary.peakContextTokens)) ||
    (summary.contextUsedTokens !== undefined &&
      !isNonNegativeInteger(summary.contextUsedTokens)) ||
    (summary.contextWindowTokens !== undefined &&
      !isNonNegativeInteger(summary.contextWindowTokens)) ||
    !Array.isArray(summary.byAgentKind) || summary.byAgentKind.length > 100) return false;
  const agentKinds = new Set<string>();
  for (const item of summary.byAgentKind) {
    if (typeof item !== "object" || item === null) return false;
    const usage = item as Record<string, unknown>;
    if (!isNonEmptyString(usage.agentKind) || agentKinds.has(usage.agentKind) ||
      !isNonNegativeInteger(usage.inputTokens) ||
      !isNonNegativeInteger(usage.outputTokens) ||
      !isNonNegativeInteger(usage.totalTokens) ||
      !isNonNegativeInteger(usage.modelCalls)) return false;
    agentKinds.add(usage.agentKind);
  }
  return true;
}

function isAgentRuntimeMetricsSnapshotArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 3) return false;
  const backends = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return false;
    const metrics = item as Record<string, unknown>;
    if ((metrics.backend !== "legacy" && metrics.backend !== "langchain" &&
      metrics.backend !== "opencode") ||
      backends.has(metrics.backend)) return false;
    backends.add(metrics.backend);
    if (!isNonNegativeInteger(metrics.runCount) ||
      !isNonNegativeInteger(metrics.completedRunCount) ||
      (metrics.completedRunCount as number) > (metrics.runCount as number) ||
      !isRatio(metrics.successRate) ||
      !isNonNegativeNumber(metrics.totalDurationMs) ||
      !isNonNegativeNumber(metrics.averageDurationMs) ||
      !isNonNegativeInteger(metrics.modelCalls) ||
      !isNonNegativeInteger(metrics.toolCalls)) return false;
    if (metrics.usage !== undefined && !isAgentTokenUsage(metrics.usage)) return false;
  }
  return true;
}

function isAgentTokenUsage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Record<string, unknown>;
  return isNonNegativeInteger(usage.inputTokens) &&
    isNonNegativeInteger(usage.outputTokens) &&
    (usage.totalTokens === undefined || isNonNegativeInteger(usage.totalTokens));
}

function isRatio(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
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

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maxLength;
}

function isCanonicalBoundedString(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && value === value.trim();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}
