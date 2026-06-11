import { describe, expect, it } from "vitest";
import { createGoalEvent, createGoalState, type GoalStrategy } from "@javis/core";
import {
  applyGoalEvaluationTransition,
  applyGoalStrategies,
  createGoalCreatedTransition,
  createGoalContinuationPrompt,
  createGoalEvaluatedEvent,
  createGoalStrategyContext,
  createGoalTaskBoundTransition,
  createGoalTaskTerminalEvent,
  createManualGoalTransition,
  findLatestGoalEvaluation,
  findLatestGoalTaskSnapshot,
  goalDecisionFromEvaluation,
  parseGoalCommand,
  reconcileGoalWithPersistedEvaluation,
} from "./goal-runtime";

describe("goal runtime helpers", () => {
  it("parses slash goal commands", () => {
    expect(parseGoalCommand("/goal Finish the project")).toBe("Finish the project");
    expect(parseGoalCommand("／goal 完成测试")).toBe("完成测试");
    expect(parseGoalCommand("Finish the project")).toBeNull();
  });

  it("builds continuation prompts with structured evaluation context", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal mode",
      acceptanceCriteria: ["Persist evaluations", "Show timeline"],
      now: "2026-06-09T00:00:00.000Z",
    });

    const prompt = createGoalContinuationPrompt({
      goal,
      latestEvaluation: {
        id: "eval-1",
        goalId: goal.id,
        taskId: "task-1",
        decision: "continue",
        confidence: "medium",
        satisfiedCriteria: ["Persist evaluations"],
        unsatisfiedCriteria: ["Show timeline"],
        evidence: ["UI has no timeline yet"],
        completedChecks: ["Persist evaluations"],
        reason: "UI still missing detail.",
        createdAt: "2026-06-09T00:01:00.000Z",
      },
      latestTask: {
        id: "task-1",
        title: "Task",
        userGoal: "Implement persistence",
        status: "completed",
        commanderMessage: "Done",
        plan: [],
        agents: [],
        logs: [],
      },
    });

    expect(prompt).toContain("Unsatisfied criteria: Show timeline");
    expect(prompt).toContain("Latest evidence: UI has no timeline yet");
    expect(prompt).toContain("Previous task status: completed");
  });

  it("applies synchronous Goal strategies and records events", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Fix tests",
      now: "2026-06-09T00:00:00.000Z",
    });
    const strategy: GoalStrategy = {
      name: "test-strategy",
      beforeRun() {
        return {
          nextPromptPrefix: "Prefix",
          nextPromptSuffix: "Suffix",
          event: {
            id: "event-1",
            type: "strategy_applied",
            message: "Applied",
            createdAt: "2026-06-09T00:01:00.000Z",
          },
        };
      },
    };

    const result = applyGoalStrategies(
      createGoalStrategyContext({
        goal,
        events: [createGoalEvent({ id: "existing", goalId: goal.id, type: "created" })],
      }),
      "Prompt",
      [strategy],
    );

    expect(result.prompt).toBe("Prefix\n\nPrompt\n\nSuffix");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: "event-1",
      goalId: "goal-1",
      type: "strategy_applied",
      message: "Applied",
    });
  });

  it("preserves strategy order when composing prompt prefixes and suffixes", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Fix tests",
      now: "2026-06-09T00:00:00.000Z",
    });
    const result = applyGoalStrategies(
      createGoalStrategyContext({ goal }),
      "Body",
      [
        {
          name: "first",
          beforeRun: () => ({ nextPromptPrefix: "Prefix A", nextPromptSuffix: "Suffix A" }),
        },
        {
          name: "second",
          beforeRun: () => ({ nextPromptPrefix: "Prefix B", nextPromptSuffix: "Suffix B" }),
        },
      ],
    );

    expect(result.prompt).toBe("Prefix A\n\nPrefix B\n\nBody\n\nSuffix A\n\nSuffix B");
  });

  it("creates Goal lifecycle transitions with standard timeline events", () => {
    const created = createGoalCreatedTransition({
      objective: "Ship Goal mode",
      workspacePath: "E:/Javis",
      now: "2026-06-09T00:00:00.000Z",
    });
    expect(created.goal?.objective).toBe("Ship Goal mode");
    expect(created.events).toMatchObject([{ type: "created", message: "Goal created from /goal command." }]);

    const bound = createGoalTaskBoundTransition(
      created.goal!,
      { id: "task-1", status: "running" },
      "2026-06-09T00:01:00.000Z",
    );
    expect(bound.goal?.taskIds).toEqual(["task-1"]);
    expect(bound.events).toMatchObject([{ type: "task_bound", taskId: "task-1" }]);
    expect(createGoalTaskBoundTransition(bound.goal!, { id: "task-1", status: "running" }).events).toEqual([]);

    const terminalEvent = createGoalTaskTerminalEvent(bound.goal!, { id: "task-1", status: "completed" });
    expect(terminalEvent).toMatchObject({ type: "task_terminal", taskId: "task-1" });
  });

  it("transitions evaluated Goals to continue, complete, or blocked events", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal mode",
      maxRunCount: 4,
      now: "2026-06-09T00:00:00.000Z",
    });
    const evaluation = {
      id: "eval-1",
      goalId: goal.id,
      taskId: "task-1",
      decision: "continue" as const,
      confidence: "medium" as const,
      satisfiedCriteria: [],
      unsatisfiedCriteria: ["Tests"],
      evidence: ["vitest failed"],
      completedChecks: [],
      reason: "Need more work.",
      createdAt: "2026-06-09T00:01:00.000Z",
    };

    const continued = applyGoalEvaluationTransition(
      goal,
      { id: "task-1" },
      goalDecisionFromEvaluation(evaluation),
      evaluation,
      "2026-06-09T00:02:00.000Z",
    );
    expect(continued.goal?.status).toBe("active");
    expect(continued.events).toMatchObject([{ type: "continued", taskId: "task-1" }]);

    const completeEval = { ...evaluation, id: "eval-2", taskId: "task-2", decision: "complete" as const };
    const completed = applyGoalEvaluationTransition(
      continued.goal!,
      { id: "task-2" },
      goalDecisionFromEvaluation(completeEval),
      completeEval,
    );
    expect(completed.goal?.status).toBe("complete");
    expect(completed.events).toMatchObject([{ type: "completed", taskId: "task-2" }]);
  });

  it("reconciles persisted evaluations newer than the saved Goal state", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal mode",
      now: "2026-06-09T00:00:00.000Z",
    });
    const evaluation = {
      id: "eval-1",
      goalId: goal.id,
      taskId: "task-1",
      decision: "complete" as const,
      confidence: "high" as const,
      satisfiedCriteria: ["Tests passed"],
      unsatisfiedCriteria: [],
      evidence: ["vitest passed"],
      completedChecks: ["Tests passed"],
      reason: "Goal is verified.",
      createdAt: "2026-06-09T00:01:00.000Z",
    };

    const reconciled = reconcileGoalWithPersistedEvaluation(
      goal,
      evaluation,
      "2026-06-09T00:02:00.000Z",
    );

    expect(reconciled.goal?.status).toBe("complete");
    expect(reconciled.goal?.completedChecks).toEqual(["Tests passed"]);
    expect(reconciled.events).toMatchObject([{ type: "completed", taskId: "task-1" }]);
  });

  it("does not replay evaluations superseded by a newer Goal update", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal mode",
      now: "2026-06-09T00:02:00.000Z",
    });
    const evaluation = {
      id: "eval-1",
      goalId: goal.id,
      taskId: "task-1",
      decision: "blocked" as const,
      confidence: "low" as const,
      satisfiedCriteria: [],
      unsatisfiedCriteria: ["Need API key"],
      evidence: [],
      completedChecks: [],
      blockedReason: "Missing API key",
      reason: "Blocked.",
      createdAt: "2026-06-09T00:01:00.000Z",
    };

    const reconciled = reconcileGoalWithPersistedEvaluation(goal, evaluation);

    expect(reconciled.goal).toBe(goal);
    expect(reconciled.events).toEqual([]);
  });

  it("creates manual Goal transitions and finds latest restored context", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal mode",
      now: "2026-06-09T00:00:00.000Z",
    });
    const paused = createManualGoalTransition(goal, "pause", "2026-06-09T00:01:00.000Z");
    const resumed = createManualGoalTransition(paused.goal!, "resume", "2026-06-09T00:02:00.000Z");
    expect(paused.goal?.status).toBe("paused");
    expect(paused.events).toMatchObject([{ type: "paused" }]);
    expect(resumed.goal?.status).toBe("active");
    expect(resumed.events).toMatchObject([{ type: "resumed" }]);

    const withTask = createGoalTaskBoundTransition(resumed.goal!, { id: "task-1", status: "completed" }).goal!;
    const task = {
      id: "task-1",
      title: "Goal task",
      userGoal: "Continue Goal",
      status: "completed" as const,
      commanderMessage: "Done",
      plan: [],
      agents: [],
      logs: [],
    };
    const evaluation = {
      id: "eval-1",
      goalId: withTask.id,
      taskId: task.id,
      decision: "continue" as const,
      confidence: "medium" as const,
      satisfiedCriteria: [],
      unsatisfiedCriteria: ["UI"],
      evidence: [],
      completedChecks: [],
      reason: "",
      createdAt: "2026-06-09T00:03:00.000Z",
    };

    expect(findLatestGoalTaskSnapshot(withTask, task, [])).toBe(task);
    expect(findLatestGoalEvaluation(withTask, [evaluation])?.id).toBe("eval-1");
    expect(createGoalEvaluatedEvent(withTask, evaluation)).toMatchObject({
      type: "evaluated",
      taskId: "task-1",
    });
  });
});
