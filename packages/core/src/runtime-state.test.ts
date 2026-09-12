import { describe, expect, it } from "vitest";
import type { TaskSnapshot } from "./index";
import { shouldAcceptRuntimeDelta } from "./runtime-state";

function snapshot(overrides: Partial<TaskSnapshot> = {}): Pick<TaskSnapshot, "id" | "status"> {
  return { id: "task-1", status: "running", ...overrides };
}

describe("shouldAcceptRuntimeDelta", () => {
  it("accepts deltas for the active task", () => {
    expect(shouldAcceptRuntimeDelta(snapshot(), { taskId: "task-1" })).toBe(true);
    for (const status of ["created", "planning", "running", "waiting_permission", "verifying"] as const) {
      expect(shouldAcceptRuntimeDelta(snapshot({ status }), { taskId: "task-1" })).toBe(true);
    }
  });

  it("rejects deltas for a different task", () => {
    expect(shouldAcceptRuntimeDelta(snapshot(), { taskId: "task-2" })).toBe(false);
  });

  it("rejects deltas once the task is terminal", () => {
    // This is the regression guard for the runaway writer: a failed task kept
    // receiving stream deltas and re-notifying subscribers ~52 times per second.
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(
        shouldAcceptRuntimeDelta(snapshot({ status }), { taskId: "task-1" }),
        `status ${status} must not accept further stream deltas`,
      ).toBe(false);
    }
  });

  it("accepts deltas again when a continuation resumes the same task id", () => {
    // A resumed task reuses its id, and the flow emits the non-terminal starting
    // snapshot before the model stream produces deltas, so streaming works.
    expect(shouldAcceptRuntimeDelta(snapshot({ status: "failed" }), { taskId: "task-1" })).toBe(false);
    expect(shouldAcceptRuntimeDelta(snapshot({ status: "running" }), { taskId: "task-1" })).toBe(true);
  });
});
