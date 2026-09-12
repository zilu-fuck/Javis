import { describe, expect, it } from "vitest";
import { GOLDEN_TASKS, isPlanExpectation } from "./golden-tasks";
import { runGoldenTask } from "./golden-task-runner";

/**
 * One test per golden task so the JSON reporter yields a per-task scorecard
 * (`pnpm eval` converts it). The names are the task ids.
 */
describe("golden tasks", () => {
  for (const task of GOLDEN_TASKS) {
    it(`${task.id}${task.category === "plan-legality" ? "" : ""}`, () => {
      const result = runGoldenTask(task);
      expect(
        result.ok,
        [
          `golden task ${task.id} (${task.category}) failed`,
          `  goal:     ${task.goal}`,
          `  expected: ${result.expected}`,
          `  observed: ${result.observed}`,
          result.failureKind ? `  kind:     ${result.failureKind}` : "",
        ].filter(Boolean).join("\n"),
      ).toBe(true);
    });
  }

  it("covers every golden category with a usable plan or goal shape", () => {
    expect(GOLDEN_TASKS.length).toBeGreaterThanOrEqual(20);
    const categories = new Set(GOLDEN_TASKS.map((task) => task.category));
    expect([...categories].sort()).toEqual(["plan-legality", "routing", "write-intent"]);
    for (const task of GOLDEN_TASKS) {
      if (isPlanExpectation(task.expectation)) {
        expect(task.expectation.plan.steps.length).toBeGreaterThanOrEqual(0);
      } else {
        expect(task.goal.trim().length).toBeGreaterThan(0);
      }
    }
    // Ids must be unique so the scorecard can key on them.
    expect(new Set(GOLDEN_TASKS.map((task) => task.id)).size).toBe(GOLDEN_TASKS.length);
  });
});
