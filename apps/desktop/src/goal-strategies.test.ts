import { describe, expect, it } from "vitest";
import { createGoalEvent, createGoalState, type GoalEvaluation } from "@javis/core";
import {
  createDefaultGoalStrategies,
  createGuardrailStrategy,
  createHandoffStrategy,
  createReflectStrategy,
  createRetrievalStrategy,
  createSelfRefineStrategy,
} from "./goal-strategies";
import { applyGoalStrategies, createGoalStrategyContext } from "./goal-runtime";

describe("goal strategies", () => {
  it("exports the full default strategy pipeline", () => {
    expect(createDefaultGoalStrategies().map((strategy) => strategy.name)).toEqual([
      "guardrail",
      "retrieval",
      "reflect",
      "self-refine",
      "handoff",
    ]);
  });

  it("applies guardrail, retrieval, reflect, self-refine, and handoff prompt patches", () => {
    const goal = createGoalState({
      id: "goal-1",
      objective: "Fix code tests without delete operations",
      now: "2026-06-09T00:00:00.000Z",
    });
    const latestEvaluation: GoalEvaluation = {
      id: "eval-1",
      goalId: goal.id,
      taskId: "task-1",
      decision: "blocked",
      confidence: "low",
      satisfiedCriteria: [],
      unsatisfiedCriteria: ["Tests pass"],
      evidence: ["tsc failed"],
      completedChecks: [],
      blockedReason: "TypeScript errors remain",
      reason: "Still failing.",
      createdAt: "2026-06-09T00:01:00.000Z",
    };

    const result = applyGoalStrategies(
      createGoalStrategyContext({
        goal: { ...goal, blockedStreak: 1, runCount: 2 },
        latestEvaluation,
        latestTask: {
          id: "task-1",
          title: "Task",
          userGoal: "Fix code tests",
          status: "failed",
          commanderMessage: "Failed",
          plan: [],
          agents: [],
          logs: [],
        },
        events: [createGoalEvent({ id: "event-1", goalId: goal.id, type: "task_terminal", payloadJson: "{\"status\":\"failed\"}" })],
      }),
      "Next prompt",
      [
        createGuardrailStrategy(),
        createRetrievalStrategy(),
        createReflectStrategy(),
        createSelfRefineStrategy(),
        createHandoffStrategy(),
      ],
    );

    expect(result.prompt).toContain("Goal guardrail:");
    expect(result.prompt).toContain("Goal retrieval context:");
    expect(result.prompt).toContain("Goal reflection:");
    expect(result.prompt).toContain("Goal self-refine loop:");
    expect(result.prompt).toContain("Goal handoff check:");
    expect(result.events.map((event) => event.type)).toEqual([
      "strategy_applied",
      "strategy_applied",
      "strategy_applied",
      "self_refine_started",
      "handoff_requested",
    ]);
  });
});
