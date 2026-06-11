import {
  createGoalEvaluationFromDecision,
  createGoalEvent,
  type GoalDecision,
  type GoalEvaluation,
  type GoalEvent,
  type GoalState,
} from "@javis/core";
import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const GOAL_EVENTS_TABLE_NAME = "goal_events";
export const GOAL_EVALUATIONS_TABLE_NAME = "goal_evaluations";
export const GOAL_EVENT_LIST_LIMIT = 200;
export const GOAL_EVALUATION_LIST_LIMIT = 100;

export const GOAL_EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goal_events (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  event_json TEXT NOT NULL
)
`.trim();

export const GOAL_EVENTS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS goal_events_goal_created_idx
ON goal_events(goal_id, created_at, id)
`.trim();

export const GOAL_EVALUATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goal_evaluations (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  evaluation_json TEXT NOT NULL
)
`.trim();

export const GOAL_EVALUATIONS_GOAL_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS goal_evaluations_goal_created_idx
ON goal_evaluations(goal_id, created_at, id)
`.trim();

export const GOAL_EVALUATIONS_TASK_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS goal_evaluations_goal_task_idx
ON goal_evaluations(goal_id, task_id, created_at)
`.trim();

export const GOAL_EVENT_MIGRATIONS: DesktopDatabaseMigration[] = [
  { id: "001_goal_events", sql: GOAL_EVENTS_SCHEMA_SQL },
  { id: "002_goal_events_goal_created_index", sql: GOAL_EVENTS_INDEX_SQL },
  { id: "003_goal_evaluations", sql: GOAL_EVALUATIONS_SCHEMA_SQL },
  { id: "004_goal_evaluations_goal_created_index", sql: GOAL_EVALUATIONS_GOAL_INDEX_SQL },
  { id: "005_goal_evaluations_goal_task_index", sql: GOAL_EVALUATIONS_TASK_INDEX_SQL },
];

export interface GoalTimelineRepository {
  appendEvent(event: GoalEvent): Promise<GoalEvent | null>;
  listEvents(goalId: string, limit?: number): Promise<GoalEvent[]>;
  clearEvents(goalId: string): Promise<void>;
  saveEvaluation(evaluation: GoalEvaluation): Promise<GoalEvaluation | null>;
  saveDecisionEvaluation(goal: GoalState, task: { id: string }, decision: GoalDecision): Promise<GoalEvaluation | null>;
  listEvaluations(goalId: string, limit?: number): Promise<GoalEvaluation[]>;
  getEvaluationForTask(goalId: string, taskId: string): Promise<GoalEvaluation | null>;
  clearEvaluations(goalId: string): Promise<void>;
}

export function createGoalTimelineRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): GoalTimelineRepository {
  return {
    appendEvent(event) {
      return saveGoalEventToDatabase(database, event);
    },
    listEvents(goalId, limit = GOAL_EVENT_LIST_LIMIT) {
      return loadGoalEventsFromDatabase(database, goalId, limit);
    },
    clearEvents(goalId) {
      return clearGoalEventsFromDatabase(database, goalId);
    },
    saveEvaluation(evaluation) {
      return saveGoalEvaluationToDatabase(database, evaluation);
    },
    saveDecisionEvaluation(goal, task, decision) {
      return saveGoalEvaluationToDatabase(database, createGoalEvaluationFromDecision(goal, task, decision));
    },
    listEvaluations(goalId, limit = GOAL_EVALUATION_LIST_LIMIT) {
      return loadGoalEvaluationsFromDatabase(database, goalId, limit);
    },
    getEvaluationForTask(goalId, taskId) {
      return loadGoalEvaluationForTaskFromDatabase(database, goalId, taskId);
    },
    clearEvaluations(goalId) {
      return clearGoalEvaluationsFromDatabase(database, goalId);
    },
  };
}

export async function saveGoalEventToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  event: GoalEvent,
): Promise<GoalEvent | null> {
  const sanitized = sanitizeGoalEvent(event);
  if (!sanitized) {
    return null;
  }
  await database.execute(
    `INSERT INTO ${GOAL_EVENTS_TABLE_NAME} (id, goal_id, run_id, task_id, type, created_at, event_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       goal_id = excluded.goal_id,
       run_id = excluded.run_id,
       task_id = excluded.task_id,
       type = excluded.type,
       created_at = excluded.created_at,
       event_json = excluded.event_json`,
    [
      sanitized.id,
      sanitized.goalId,
      sanitized.runId ?? null,
      sanitized.taskId ?? null,
      sanitized.type,
      sanitized.createdAt,
      JSON.stringify(sanitized),
    ],
  );
  return sanitized;
}

export async function loadGoalEventsFromDatabase(
  database: Pick<DesktopDatabase, "select">,
  goalId: string,
  limit = GOAL_EVENT_LIST_LIMIT,
): Promise<GoalEvent[]> {
  const rows = await database.select<{ event_json: string }>(
    `SELECT event_json FROM ${GOAL_EVENTS_TABLE_NAME}
     WHERE goal_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [goalId, limit],
  );
  return rows
    .reverse()
    .map((row) => parseGoalEvent(row.event_json))
    .filter((event): event is GoalEvent => Boolean(event));
}

export async function clearGoalEventsFromDatabase(
  database: Pick<DesktopDatabase, "execute">,
  goalId: string,
): Promise<void> {
  await database.execute(`DELETE FROM ${GOAL_EVENTS_TABLE_NAME} WHERE goal_id = ?`, [goalId]);
}

export async function saveGoalEvaluationToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  evaluation: GoalEvaluation,
): Promise<GoalEvaluation | null> {
  const sanitized = sanitizeGoalEvaluation(evaluation);
  if (!sanitized) {
    return null;
  }
  await database.execute(
    `INSERT INTO ${GOAL_EVALUATIONS_TABLE_NAME} (id, goal_id, task_id, decision, created_at, evaluation_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       goal_id = excluded.goal_id,
       task_id = excluded.task_id,
       decision = excluded.decision,
       created_at = excluded.created_at,
       evaluation_json = excluded.evaluation_json`,
    [
      sanitized.id,
      sanitized.goalId,
      sanitized.taskId,
      sanitized.decision,
      sanitized.createdAt,
      JSON.stringify(sanitized),
    ],
  );
  return sanitized;
}

export async function loadGoalEvaluationsFromDatabase(
  database: Pick<DesktopDatabase, "select">,
  goalId: string,
  limit = GOAL_EVALUATION_LIST_LIMIT,
): Promise<GoalEvaluation[]> {
  const rows = await database.select<{ evaluation_json: string }>(
    `SELECT evaluation_json FROM ${GOAL_EVALUATIONS_TABLE_NAME}
     WHERE goal_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [goalId, limit],
  );
  return rows
    .reverse()
    .map((row) => parseGoalEvaluation(row.evaluation_json))
    .filter((evaluation): evaluation is GoalEvaluation => Boolean(evaluation));
}

export async function loadGoalEvaluationForTaskFromDatabase(
  database: Pick<DesktopDatabase, "select">,
  goalId: string,
  taskId: string,
): Promise<GoalEvaluation | null> {
  const rows = await database.select<{ evaluation_json: string }>(
    `SELECT evaluation_json FROM ${GOAL_EVALUATIONS_TABLE_NAME}
     WHERE goal_id = ? AND task_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [goalId, taskId],
  );
  return parseGoalEvaluation(rows[0]?.evaluation_json);
}

export async function clearGoalEvaluationsFromDatabase(
  database: Pick<DesktopDatabase, "execute">,
  goalId: string,
): Promise<void> {
  await database.execute(`DELETE FROM ${GOAL_EVALUATIONS_TABLE_NAME} WHERE goal_id = ?`, [goalId]);
}

function parseGoalEvent(raw: unknown): GoalEvent | null {
  if (typeof raw !== "string") return null;
  try {
    return sanitizeGoalEvent(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseGoalEvaluation(raw: unknown): GoalEvaluation | null {
  if (typeof raw !== "string") return null;
  try {
    return sanitizeGoalEvaluation(JSON.parse(raw));
  } catch {
    return null;
  }
}

function sanitizeGoalEvent(value: unknown): GoalEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GoalEvent>;
  if (!candidate.goalId || !isGoalEventType(candidate.type)) return null;
  return createGoalEvent({
    id: stringValue(candidate.id) ?? undefined,
    goalId: String(candidate.goalId),
    runId: stringValue(candidate.runId) ?? undefined,
    taskId: stringValue(candidate.taskId) ?? undefined,
    type: candidate.type,
    message: stringValue(candidate.message) ?? undefined,
    payloadJson: stringValue(candidate.payloadJson) ?? undefined,
    createdAt: stringValue(candidate.createdAt) ?? undefined,
  });
}

function sanitizeGoalEvaluation(value: unknown): GoalEvaluation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GoalEvaluation>;
  if (!candidate.id || !candidate.goalId || !candidate.taskId || !candidate.decision) return null;
  const decision = candidate.decision;
  if (decision !== "complete" && decision !== "continue" && decision !== "blocked") return null;
  const confidence = candidate.confidence === "low" || candidate.confidence === "high"
    ? candidate.confidence
    : "medium";
  return {
    id: String(candidate.id),
    goalId: String(candidate.goalId),
    taskId: String(candidate.taskId),
    decision,
    confidence,
    satisfiedCriteria: stringArray(candidate.satisfiedCriteria),
    unsatisfiedCriteria: stringArray(candidate.unsatisfiedCriteria),
    evidence: stringArray(candidate.evidence),
    completedChecks: stringArray(candidate.completedChecks),
    nextPrompt: stringValue(candidate.nextPrompt) ?? undefined,
    blockedReason: stringValue(candidate.blockedReason) ?? undefined,
    reason: stringValue(candidate.reason) ?? "",
    createdAt: stringValue(candidate.createdAt) ?? new Date().toISOString(),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
}

function isGoalEventType(value: unknown): value is GoalEvent["type"] {
  return value === "created" ||
    value === "task_bound" ||
    value === "task_terminal" ||
    value === "evaluated" ||
    value === "continued" ||
    value === "paused" ||
    value === "resumed" ||
    value === "completed" ||
    value === "blocked" ||
    value === "cleared" ||
    value === "strategy_applied" ||
    value === "handoff_requested" ||
    value === "self_refine_started";
}
