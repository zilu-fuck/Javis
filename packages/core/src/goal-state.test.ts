import { describe, expect, it } from "vitest";
import {
  GOAL_BLOCKED_STREAK_THRESHOLD,
  applyGoalDecision,
  bindGoalTask,
  completeGoal,
  createGoalEvaluationFromDecision,
  createGoalEvent,
  createGoalState,
  parseGoalAcceptanceCriteria,
  pauseGoal,
  resumeGoal,
  sanitizeGoalState,
} from "./goal-state";

describe("goal state", () => {
  it("creates an active goal with parsed acceptance criteria", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal MVP\n- Persist current goal\n- Resume paused goals",
      now: "2026-06-09T00:00:00.000Z",
    });

    expect(goal.status).toBe("active");
    expect(goal.acceptanceCriteria).toEqual([
      "Persist current goal",
      "Resume paused goals",
    ]);
    expect(goal.runCount).toBe(0);
    expect(goal.maxRunCount).toBe(8);
  });

  it("binds task ids once and marks complete decisions terminal", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Finish the work",
      now: "2026-06-09T00:00:00.000Z",
    });

    const withTask = bindGoalTask(goal, "task-1", "2026-06-09T00:01:00.000Z");
    const duplicateBind = bindGoalTask(withTask, "task-1", "2026-06-09T00:02:00.000Z");
    const completed = applyGoalDecision(
      duplicateBind,
      { id: "task-1" },
      { status: "complete", completedChecks: ["Tests passed"] },
      "2026-06-09T00:03:00.000Z",
    );

    expect(duplicateBind.taskIds).toEqual(["task-1"]);
    expect(duplicateBind.runCount).toBe(1);
    expect(completed.status).toBe("complete");
    expect(completed.completedChecks).toEqual(["Tests passed"]);
  });

  it("requires the same blocked reason to repeat before marking blocked", () => {
    let goal = createGoalState({
      id: "goal-1",
      objective: "Fix flaky test",
      now: "2026-06-09T00:00:00.000Z",
    });

    for (let index = 0; index < GOAL_BLOCKED_STREAK_THRESHOLD - 1; index += 1) {
      goal = applyGoalDecision(
        goal,
        { id: `task-${index}` },
        { status: "blocked", blockedReason: "Missing API key" },
        `2026-06-09T00:0${index + 1}:00.000Z`,
      );
      expect(goal.status).toBe("active");
    }

    goal = applyGoalDecision(
      goal,
      { id: "task-final" },
      { status: "blocked", blockedReason: "Missing API key" },
      "2026-06-09T00:05:00.000Z",
    );

    expect(goal.status).toBe("blocked");
    expect(goal.blockedStreak).toBe(GOAL_BLOCKED_STREAK_THRESHOLD);
  });

  it("blocks after reaching the configured run limit", () => {
    let goal = createGoalState({
      id: "goal-1",
      objective: "Try twice",
      maxRunCount: 2,
      now: "2026-06-09T00:00:00.000Z",
    });

    goal = applyGoalDecision(goal, { id: "task-1" }, { status: "continue" });
    goal = applyGoalDecision(goal, { id: "task-2" }, { status: "continue" });

    expect(goal.status).toBe("blocked");
    expect(goal.blockedReason).toBe("Reached the Goal iteration limit (2).");
  });

  it("also enforces the run limit for blocked decisions with changing reasons", () => {
    let goal = createGoalState({
      id: "goal-1",
      objective: "Try twice",
      maxRunCount: 2,
      now: "2026-06-09T00:00:00.000Z",
    });

    goal = applyGoalDecision(
      goal,
      { id: "task-1" },
      { status: "blocked", blockedReason: "Missing token" },
    );
    goal = applyGoalDecision(
      goal,
      { id: "task-2" },
      { status: "blocked", blockedReason: "Network unavailable" },
    );

    expect(goal.status).toBe("blocked");
    expect(goal.blockedReason).toBe(
      "Reached the Goal iteration limit (2). Last blocked reason: Network unavailable",
    );
  });

  it("sanitizes persisted goal state and lifecycle transitions", () => {
    const sanitized = sanitizeGoalState({
      id: "goal-1",
      objective: "  Keep going  ",
      acceptanceCriteria: ["  pass tests  ", ""],
      status: "active",
      taskIds: ["task-1", ""],
      completedChecks: ["  inspected  "],
      blockedStreak: "2",
      runCount: 1,
      maxRunCount: 4,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:01:00.000Z",
    });

    expect(sanitized?.objective).toBe("Keep going");
    expect(sanitized?.acceptanceCriteria).toEqual(["pass tests"]);
    expect(sanitized?.taskIds).toEqual(["task-1"]);
    expect(sanitizeGoalState({ objective: "bad", status: "unknown" })).toBeNull();
    expect(pauseGoal(sanitized!).status).toBe("paused");
    const resumed = resumeGoal(pauseGoal({ ...sanitized!, blockedReason: "Blocked", blockedStreak: 3 }));
    expect(resumed.status).toBe("active");
    expect(resumed.blockedReason).toBeUndefined();
    expect(resumed.blockedStreak).toBe(0);
    expect(completeGoal(sanitized!).status).toBe("complete");
  });

  it("falls back to the objective when no separate criteria are present", () => {
    expect(parseGoalAcceptanceCriteria("Fix the bug")).toEqual(["Fix the bug"]);
  });

  it("creates structured goal evaluation and timeline events", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal MVP",
      now: "2026-06-09T00:00:00.000Z",
    });
    const evaluation = createGoalEvaluationFromDecision(
      goal,
      { id: "task-1" },
      {
        status: "continue",
        confidence: "high",
        satisfiedCriteria: ["Repository inspected"],
        unsatisfiedCriteria: ["Tests still fail"],
        evidence: ["Latest task failed in tsc"],
        completedChecks: ["Read compiler output"],
        nextPrompt: "Fix the TypeScript error.",
        reason: "Goal is not complete yet.",
      },
      { id: "eval-1", createdAt: "2026-06-09T00:02:00.000Z" },
    );
    const event = createGoalEvent({
      id: "event-1",
      goalId: goal.id,
      taskId: "task-1",
      type: "evaluated",
      message: "Verifier requested another run.",
      createdAt: "2026-06-09T00:03:00.000Z",
    });

    expect(evaluation).toMatchObject({
      id: "eval-1",
      goalId: "goal-1",
      taskId: "task-1",
      decision: "continue",
      confidence: "high",
      satisfiedCriteria: ["Repository inspected"],
      unsatisfiedCriteria: ["Tests still fail"],
      evidence: ["Latest task failed in tsc"],
    });
    expect(event).toMatchObject({
      id: "event-1",
      goalId: "goal-1",
      taskId: "task-1",
      type: "evaluated",
    });
  });
});
