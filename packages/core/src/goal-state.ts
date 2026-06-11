export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "cleared";

export type GoalDecisionStatus = "complete" | "continue" | "blocked";

export interface GoalDecision {
  status: GoalDecisionStatus;
  confidence?: "low" | "medium" | "high";
  satisfiedCriteria?: string[];
  unsatisfiedCriteria?: string[];
  evidence?: string[];
  completedChecks?: string[];
  blockedReason?: string;
  nextPrompt?: string;
  reason?: string;
}

export interface GoalEvaluation {
  id: string;
  goalId: string;
  taskId: string;
  decision: GoalDecisionStatus;
  confidence: "low" | "medium" | "high";
  satisfiedCriteria: string[];
  unsatisfiedCriteria: string[];
  evidence: string[];
  completedChecks: string[];
  nextPrompt?: string;
  blockedReason?: string;
  reason: string;
  createdAt: string;
}

export type GoalRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface GoalRun {
  id: string;
  goalId: string;
  taskId?: string;
  prompt: string;
  status: GoalRunStatus;
  startedAt?: string;
  completedAt?: string;
  evaluationId?: string;
}

export type GoalEventType =
  | "created"
  | "task_bound"
  | "task_terminal"
  | "evaluated"
  | "continued"
  | "paused"
  | "resumed"
  | "completed"
  | "blocked"
  | "cleared"
  | "strategy_applied"
  | "handoff_requested"
  | "self_refine_started";

export interface GoalEvent {
  id: string;
  goalId: string;
  runId?: string;
  taskId?: string;
  type: GoalEventType;
  message?: string;
  payloadJson?: string;
  createdAt: string;
}

export interface GoalStrategyContext {
  goal: GoalState;
  latestTask?: { id: string; status: string; userGoal?: string; userFacingError?: string };
  latestEvaluation?: GoalEvaluation;
  events: GoalEvent[];
}

export interface GoalStrategyPatch {
  nextPromptPrefix?: string;
  nextPromptSuffix?: string;
  event?: Omit<GoalEvent, "id" | "goalId" | "createdAt"> & { id?: string; createdAt?: string };
}

export interface GoalStrategy {
  name: string;
  beforeRun?(context: GoalStrategyContext): GoalStrategyPatch | null | undefined;
  afterFailure?(context: GoalStrategyContext): GoalStrategyPatch | null | undefined;
  beforeEvaluation?(context: GoalStrategyContext): GoalStrategyPatch | null | undefined;
  afterEvaluation?(context: GoalStrategyContext): GoalStrategyPatch | null | undefined;
}

export interface GoalState {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  status: GoalStatus;
  workspacePath?: string;
  taskIds: string[];
  completedChecks: string[];
  blockedReason?: string;
  blockedStreak: number;
  runCount: number;
  maxRunCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGoalStateInput {
  id?: string;
  objective: string;
  acceptanceCriteria?: string[];
  workspacePath?: string;
  maxRunCount?: number;
  now?: string;
}

export const DEFAULT_GOAL_MAX_RUN_COUNT = 8;
export const GOAL_BLOCKED_STREAK_THRESHOLD = 3;

export function createGoalState(input: CreateGoalStateInput): GoalState {
  const now = input.now ?? new Date().toISOString();
  const rawObjective = input.objective.trim();
  const objective = normalizeText(input.objective);
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : parseGoalAcceptanceCriteria(rawObjective),
    objective,
  );

  return {
    id: input.id ?? `goal-${Date.now()}`,
    objective,
    acceptanceCriteria,
    status: "active",
    workspacePath: normalizeOptionalText(input.workspacePath),
    taskIds: [],
    completedChecks: [],
    blockedStreak: 0,
    runCount: 0,
    maxRunCount: normalizePositiveInteger(input.maxRunCount, DEFAULT_GOAL_MAX_RUN_COUNT),
    createdAt: now,
    updatedAt: now,
  };
}

export function createGoalEvent(
  input: Omit<GoalEvent, "id" | "createdAt"> & { id?: string; createdAt?: string },
): GoalEvent {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: normalizeOptionalText(input.id) ?? `goal-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goalId: normalizeText(input.goalId),
    runId: normalizeOptionalText(input.runId),
    taskId: normalizeOptionalText(input.taskId),
    type: input.type,
    message: normalizeOptionalText(input.message),
    payloadJson: normalizeOptionalText(input.payloadJson),
    createdAt,
  };
}

export function createGoalEvaluationFromDecision(
  goal: GoalState,
  task: { id: string },
  decision: GoalDecision,
  input?: { id?: string; createdAt?: string },
): GoalEvaluation {
  const createdAt = input?.createdAt ?? new Date().toISOString();
  return {
    id: normalizeOptionalText(input?.id) ?? `goal-eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goalId: goal.id,
    taskId: normalizeText(task.id),
    decision: decision.status,
    confidence: normalizeGoalConfidence(decision.confidence),
    satisfiedCriteria: normalizeStringArray(decision.satisfiedCriteria),
    unsatisfiedCriteria: normalizeStringArray(decision.unsatisfiedCriteria),
    evidence: normalizeStringArray(decision.evidence),
    completedChecks: normalizeStringArray(decision.completedChecks),
    nextPrompt: normalizeOptionalText(decision.nextPrompt),
    blockedReason: normalizeOptionalText(decision.blockedReason),
    reason: normalizeOptionalText(decision.reason) ?? "",
    createdAt,
  };
}

export function parseGoalAcceptanceCriteria(objective: string): string[] {
  const lines = objective
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    return [objective.trim()].filter(Boolean);
  }

  const criteria = lines
    .slice(1)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)、]\s*/, "").trim())
    .filter(Boolean);

  return criteria.length > 0 ? criteria : [objective.trim()].filter(Boolean);
}

export function bindGoalTask(goal: GoalState, taskId: string, now = new Date().toISOString()): GoalState {
  const cleanTaskId = normalizeText(taskId);
  if (!cleanTaskId || goal.taskIds.includes(cleanTaskId)) {
    return goal;
  }
  const taskIds = [...goal.taskIds, cleanTaskId];
  return {
    ...goal,
    taskIds,
    runCount: taskIds.length,
    updatedAt: now,
  };
}

export function applyGoalDecision(
  goal: GoalState,
  task: { id: string },
  decision: GoalDecision,
  now = new Date().toISOString(),
): GoalState {
  const withTask = bindGoalTask(goal, task.id, now);
  const completedChecks = mergeUniqueText(withTask.completedChecks, decision.completedChecks ?? []);

  if (decision.status === "complete") {
    return {
      ...withTask,
      status: "complete",
      completedChecks,
      blockedReason: undefined,
      blockedStreak: 0,
      updatedAt: now,
    };
  }

  if (decision.status === "blocked") {
    const blockedReason = normalizeOptionalText(decision.blockedReason || decision.reason) ?? "Goal is blocked.";
    const blockedStreak = blockedReason === withTask.blockedReason
      ? withTask.blockedStreak + 1
      : 1;
    const reachedRunLimit = withTask.runCount >= withTask.maxRunCount;
    return {
      ...withTask,
      status: blockedStreak >= GOAL_BLOCKED_STREAK_THRESHOLD || reachedRunLimit ? "blocked" : "active",
      completedChecks,
      blockedReason: reachedRunLimit
        ? `Reached the Goal iteration limit (${withTask.maxRunCount}). Last blocked reason: ${blockedReason}`
        : blockedReason,
      blockedStreak: reachedRunLimit ? GOAL_BLOCKED_STREAK_THRESHOLD : blockedStreak,
      updatedAt: now,
    };
  }

  if (withTask.runCount >= withTask.maxRunCount) {
    return {
      ...withTask,
      status: "blocked",
      completedChecks,
      blockedReason: `Reached the Goal iteration limit (${withTask.maxRunCount}).`,
      blockedStreak: GOAL_BLOCKED_STREAK_THRESHOLD,
      updatedAt: now,
    };
  }

  return {
    ...withTask,
    status: "active",
    completedChecks,
    blockedReason: undefined,
    blockedStreak: 0,
    updatedAt: now,
  };
}

export function pauseGoal(goal: GoalState, reason?: string, now = new Date().toISOString()): GoalState {
  return {
    ...goal,
    status: "paused",
    blockedReason: normalizeOptionalText(reason) ?? goal.blockedReason,
    updatedAt: now,
  };
}

export function resumeGoal(goal: GoalState, now = new Date().toISOString()): GoalState {
  return {
    ...goal,
    status: "active",
    blockedReason: undefined,
    blockedStreak: 0,
    updatedAt: now,
  };
}

export function completeGoal(goal: GoalState, now = new Date().toISOString()): GoalState {
  return {
    ...goal,
    status: "complete",
    blockedReason: undefined,
    blockedStreak: 0,
    updatedAt: now,
  };
}

export function clearGoal(goal: GoalState, now = new Date().toISOString()): GoalState {
  return {
    ...goal,
    status: "cleared",
    updatedAt: now,
  };
}

export function isGoalTerminal(status: GoalStatus): boolean {
  return status === "complete" || status === "blocked" || status === "cleared";
}

export function sanitizeGoalState(value: unknown): GoalState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<GoalState>;
  const objective = normalizeOptionalText(candidate.objective);
  if (!objective || !isGoalStatus(candidate.status)) {
    return null;
  }
  const now = new Date().toISOString();
  const taskIds = normalizeStringArray(candidate.taskIds);
  const createdAt = normalizeOptionalText(candidate.createdAt) ?? now;
  return {
    id: normalizeOptionalText(candidate.id) ?? `goal-${Date.now()}`,
    objective,
    acceptanceCriteria: normalizeAcceptanceCriteria(candidate.acceptanceCriteria, objective),
    status: candidate.status,
    workspacePath: normalizeOptionalText(candidate.workspacePath),
    taskIds,
    completedChecks: normalizeStringArray(candidate.completedChecks),
    blockedReason: normalizeOptionalText(candidate.blockedReason),
    blockedStreak: Math.max(0, normalizeInteger(candidate.blockedStreak, 0)),
    runCount: Math.max(taskIds.length, normalizeInteger(candidate.runCount, taskIds.length)),
    maxRunCount: normalizePositiveInteger(candidate.maxRunCount, DEFAULT_GOAL_MAX_RUN_COUNT),
    createdAt,
    updatedAt: normalizeOptionalText(candidate.updatedAt) ?? createdAt,
  };
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" ||
    value === "paused" ||
    value === "complete" ||
    value === "blocked" ||
    value === "cleared";
}

function normalizeAcceptanceCriteria(value: unknown, fallbackObjective: string): string[] {
  const criteria = normalizeStringArray(value);
  return criteria.length > 0 ? criteria : [fallbackObjective].filter(Boolean);
}

function mergeUniqueText(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...existing, ...incoming]) {
    const normalized = normalizeText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(String(item))).filter(Boolean)
    : [];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeText(value) || undefined : undefined;
}

function normalizeInteger(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, normalizeInteger(value, fallback));
}

function normalizeGoalConfidence(value: unknown): GoalEvaluation["confidence"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}
