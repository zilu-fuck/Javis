import {
  applyGoalDecision,
  bindGoalTask,
  clearGoal,
  completeGoal,
  createGoalEvent,
  createGoalState,
  pauseGoal,
  resumeGoal,
  type GoalDecision,
  type GoalEvaluation,
  type GoalEvent,
  type GoalState,
  type GoalStrategy,
  type GoalStrategyContext,
  type TaskSnapshot,
} from "@javis/core";

export interface GoalContinuationInput {
  goal: GoalState;
  decision?: GoalDecision;
  latestTask?: TaskSnapshot;
  latestEvaluation?: GoalEvaluation;
}

export interface GoalStrategyApplication {
  prompt: string;
  events: GoalEvent[];
}

export interface GoalRuntimeTransition {
  goal: GoalState | null;
  events: GoalEvent[];
}

export function parseGoalCommand(rawGoal: string): string | null {
  const match = rawGoal.match(/^(?:\/|／)goal(?:\s+|$)([\s\S]*)$/i);
  const objective = match?.[1]?.trim();
  return objective || null;
}

export function createGoalCreatedTransition(input: {
  objective: string;
  workspacePath?: string;
  now?: string;
}): GoalRuntimeTransition {
  const goal = createGoalState(input);
  return {
    goal,
    events: [
      createGoalEvent({
        goalId: goal.id,
        type: "created",
        message: "Goal created from /goal command.",
        createdAt: input.now,
      }),
    ],
  };
}

export function createGoalTaskBoundTransition(
  goal: GoalState,
  task: Pick<TaskSnapshot, "id" | "status">,
  now?: string,
): GoalRuntimeTransition {
  const nextGoal = bindGoalTask(goal, task.id, now);
  if (nextGoal === goal) {
    return { goal, events: [] };
  }
  return {
    goal: nextGoal,
    events: [
      createGoalEvent({
        goalId: nextGoal.id,
        taskId: task.id,
        type: "task_bound",
        message: "Goal run bound to a task.",
        payloadJson: JSON.stringify({ status: task.status }),
        createdAt: now,
      }),
    ],
  };
}

export function createGoalTaskTerminalEvent(
  goal: GoalState,
  task: Pick<TaskSnapshot, "id" | "status">,
  now?: string,
): GoalEvent {
  return createGoalEvent({
    goalId: goal.id,
    taskId: task.id,
    type: "task_terminal",
    message: "Goal task reached a terminal state.",
    payloadJson: JSON.stringify({ status: task.status }),
    createdAt: now,
  });
}

export function createGoalEvaluatedEvent(
  goal: GoalState,
  evaluation: GoalEvaluation,
  now?: string,
): GoalEvent {
  return createGoalEvent({
    goalId: goal.id,
    taskId: evaluation.taskId,
    type: "evaluated",
    message: `Verifier decision: ${evaluation.decision}`,
    payloadJson: JSON.stringify({ evaluationId: evaluation.id, decision: evaluation.decision }),
    createdAt: now,
  });
}

export function applyGoalEvaluationTransition(
  goal: GoalState,
  task: Pick<TaskSnapshot, "id">,
  decision: GoalDecision,
  evaluation: GoalEvaluation,
  now?: string,
): GoalRuntimeTransition {
  const nextGoal = applyGoalDecision(goal, task, decision, now);
  const event = createGoalEvent({
    goalId: nextGoal.id,
    taskId: task.id,
    type: nextGoal.status === "complete"
      ? "completed"
      : nextGoal.status === "blocked"
        ? "blocked"
        : "continued",
    message: nextGoal.status === "complete"
      ? "Goal verifier marked the Goal complete."
      : nextGoal.status === "blocked"
        ? nextGoal.blockedReason ?? "Goal verifier marked the Goal blocked."
        : "Goal verifier requested another iteration.",
    payloadJson: JSON.stringify({
      evaluationId: evaluation.id,
      ...(nextGoal.status === "blocked" ? { blockedReason: nextGoal.blockedReason } : {}),
    }),
    createdAt: now,
  });
  return { goal: nextGoal, events: [event] };
}

export function reconcileGoalWithPersistedEvaluation(
  goal: GoalState,
  evaluation: GoalEvaluation,
  now?: string,
): GoalRuntimeTransition {
  if (!shouldApplyPersistedGoalEvaluation(goal, evaluation)) {
    return { goal, events: [] };
  }
  return applyGoalEvaluationTransition(
    goal,
    { id: evaluation.taskId },
    goalDecisionFromEvaluation(evaluation),
    evaluation,
    now,
  );
}

export function createManualGoalTransition(
  goal: GoalState,
  action: "pause" | "resume" | "complete" | "clear",
  now?: string,
): GoalRuntimeTransition {
  const nextGoal = action === "pause"
    ? pauseGoal(goal, undefined, now)
    : action === "resume"
      ? resumeGoal(goal, now)
      : action === "complete"
        ? completeGoal(goal, now)
        : clearGoal(goal, now);
  const type = action === "pause"
    ? "paused"
    : action === "resume"
      ? "resumed"
      : action === "complete"
        ? "completed"
        : "cleared";
  const message = action === "pause"
    ? "Goal paused by the user."
    : action === "resume"
      ? "Goal resumed by the user."
      : action === "complete"
        ? "Goal manually marked complete by the user."
        : "Goal cleared by the user.";
  return {
    goal: nextGoal,
    events: [createGoalEvent({ goalId: nextGoal.id, type, message, createdAt: now })],
  };
}

function shouldApplyPersistedGoalEvaluation(goal: GoalState, evaluation: GoalEvaluation): boolean {
  if (goal.id !== evaluation.goalId || goal.status !== "active") {
    return false;
  }
  const goalUpdatedAt = Date.parse(goal.updatedAt);
  const evaluationCreatedAt = Date.parse(evaluation.createdAt);
  return Number.isFinite(goalUpdatedAt) &&
    Number.isFinite(evaluationCreatedAt) &&
    evaluationCreatedAt > goalUpdatedAt;
}

export function goalDecisionFromEvaluation(evaluation: GoalEvaluation): GoalDecision {
  return {
    status: evaluation.decision,
    confidence: evaluation.confidence,
    satisfiedCriteria: evaluation.satisfiedCriteria,
    unsatisfiedCriteria: evaluation.unsatisfiedCriteria,
    evidence: evaluation.evidence,
    completedChecks: evaluation.completedChecks,
    blockedReason: evaluation.blockedReason,
    nextPrompt: evaluation.nextPrompt,
    reason: evaluation.reason,
  };
}

export function findLatestGoalTaskSnapshot(
  goal: GoalState,
  currentTask: TaskSnapshot,
  history: TaskSnapshot[],
): TaskSnapshot | undefined {
  const lastTaskId = [...goal.taskIds].reverse()[0];
  if (!lastTaskId) {
    return undefined;
  }
  if (currentTask.id === lastTaskId) {
    return currentTask;
  }
  return history.find((entry) => entry.id === lastTaskId);
}

export function findLatestGoalEvaluation(
  goal: GoalState,
  evaluations: GoalEvaluation[],
  taskId?: string,
): GoalEvaluation | undefined {
  const lookupTaskId = taskId ?? [...goal.taskIds].reverse()[0];
  if (!lookupTaskId) {
    return undefined;
  }
  return [...evaluations]
    .reverse()
    .find((evaluation) => evaluation.goalId === goal.id && evaluation.taskId === lookupTaskId);
}

export function createGoalContinuationPrompt({
  goal,
  decision,
  latestTask,
  latestEvaluation,
}: GoalContinuationInput): string {
  if (decision?.nextPrompt?.trim()) {
    return decision.nextPrompt.trim();
  }
  return [
    `Continue the Goal: ${goal.objective}`,
    goal.acceptanceCriteria.length > 0 ? `Acceptance criteria: ${goal.acceptanceCriteria.join("; ")}` : "",
    goal.completedChecks.length > 0 ? `Completed checks: ${goal.completedChecks.join("; ")}` : "",
    latestEvaluation?.unsatisfiedCriteria.length
      ? `Unsatisfied criteria: ${latestEvaluation.unsatisfiedCriteria.join("; ")}`
      : "",
    latestEvaluation?.evidence.length ? `Latest evidence: ${latestEvaluation.evidence.join("; ")}` : "",
    latestTask ? `Previous task status: ${latestTask.status}` : "",
    latestTask?.userFacingError ? `Previous task error: ${latestTask.userFacingError}` : "",
    decision?.reason ? `Verifier note: ${decision.reason}` : "",
    "Choose the smallest useful next step, execute it, and verify whether the Goal is now complete.",
  ].filter(Boolean).join("\n");
}

export function createGoalStrategyContext(input: {
  goal: GoalState;
  latestTask?: TaskSnapshot;
  latestEvaluation?: GoalEvaluation;
  events?: GoalEvent[];
}): GoalStrategyContext {
  return {
    goal: input.goal,
    latestTask: input.latestTask
      ? {
          id: input.latestTask.id,
          status: input.latestTask.status,
          userGoal: input.latestTask.userGoal,
          userFacingError: input.latestTask.userFacingError,
        }
      : undefined,
    latestEvaluation: input.latestEvaluation,
    events: input.events ?? [],
  };
}

export function applyGoalStrategies(
  context: GoalStrategyContext,
  prompt: string,
  strategies: GoalStrategy[],
  phase: "beforeRun" | "afterFailure" | "beforeEvaluation" | "afterEvaluation" = "beforeRun",
): GoalStrategyApplication {
  const promptBody = prompt.trim();
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  const events: GoalEvent[] = [];
  for (const strategy of strategies) {
    const apply = strategy[phase];
    if (!apply) {
      continue;
    }
    const patch = apply(context);
    if (!patch) {
      continue;
    }
    if (patch.nextPromptPrefix?.trim()) {
      prefixes.push(patch.nextPromptPrefix.trim());
    }
    if (patch.nextPromptSuffix?.trim()) {
      suffixes.push(patch.nextPromptSuffix.trim());
    }
    if (patch.event) {
      events.push(createGoalEvent({
        ...patch.event,
        goalId: context.goal.id,
      }));
    }
  }
  const nextPrompt = [
    ...prefixes,
    promptBody,
    ...suffixes,
  ].filter(Boolean).join("\n\n");
  return { prompt: nextPrompt, events };
}
