import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENTED_TASK_TRANSITIONS,
  TASK_STATUS_PROGRESS,
  TASK_STATUSES,
  createInitialTaskSnapshot,
  getTaskProgress,
  isLegalTaskTransition,
  isTerminalTaskStatus,
  transitionTask,
} from "../index";
import type { TaskSnapshot, TaskStatus } from "../index";

function transitionThrough(
  initialSnapshot: TaskSnapshot,
  statuses: TaskStatus[],
): TaskSnapshot {
  return statuses.reduce(
    (snapshot, status, index) =>
      transitionTask(snapshot, status, {
        updatedAt: `2026-05-24T00:00:0${index}.000Z`,
      }),
    initialSnapshot,
  );
}

describe("task-state", () => {
  it("documents the existing task status vocabulary", () => {
    expect(TASK_STATUSES).toEqual([
      "created",
      "planning",
      "waiting_info",
      "waiting_permission",
      "running",
      "generating",
      "verifying",
      "retrying",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("documents real existing transitions without enforcing a full transition table", () => {
    expect(DOCUMENTED_TASK_TRANSITIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "created", to: "planning" }),
        expect.objectContaining({ from: "planning", to: "waiting_info" }),
        expect.objectContaining({ from: "waiting_info", to: "running" }),
        expect.objectContaining({ from: "planning", to: "running" }),
        expect.objectContaining({ from: "running", to: "waiting_permission" }),
        expect.objectContaining({ from: "waiting_permission", to: "running" }),
        expect.objectContaining({ from: "running", to: "generating" }),
        expect.objectContaining({ from: "generating", to: "completed" }),
        expect.objectContaining({ from: "running", to: "verifying" }),
        expect.objectContaining({ from: "verifying", to: "completed" }),
        expect.objectContaining({ from: "waiting_permission", to: "completed" }),
        expect.objectContaining({ from: "waiting_permission", to: "failed" }),
        expect.objectContaining({ from: "running", to: "failed" }),
        expect.objectContaining({ from: "verifying", to: "failed" }),
      ]),
    );
  });

  it("transitions created to planning to running to completed", () => {
    const finalSnapshot = transitionThrough(createInitialTaskSnapshot(), [
      "planning",
      "running",
      "completed",
    ]);

    expect(finalSnapshot.status).toBe("completed");
    expect(finalSnapshot.updatedAt).toBe("2026-05-24T00:00:02.000Z");
  });

  it("maps product status stages to non-zero progress", () => {
    expect(TASK_STATUS_PROGRESS.waiting_info).toBe(35);
    expect(TASK_STATUS_PROGRESS.waiting_permission).toBe(40);
    expect(TASK_STATUS_PROGRESS.generating).toBe(75);
    expect(getTaskProgress("completed")).toBe(100);
  });

  it("warns but allows undocumented non-terminal transitions", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = {
      ...createInitialTaskSnapshot(),
      status: "planning" as const,
    };

    expect(isLegalTaskTransition("planning", "completed")).toBe(false);
    expect(transitionTask(snapshot, "completed").status).toBe("completed");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("transitions running through permission and verification to completed", () => {
    const finalSnapshot = transitionThrough(createInitialTaskSnapshot(), [
      "planning",
      "running",
      "waiting_permission",
      "running",
      "verifying",
      "completed",
    ]);

    expect(finalSnapshot.status).toBe("completed");
  });

  it("transitions waiting permission to completed when a write is denied", () => {
    const waitingSnapshot = transitionThrough(createInitialTaskSnapshot(), [
      "planning",
      "running",
      "waiting_permission",
    ]);

    expect(transitionTask(waitingSnapshot, "completed").status).toBe("completed");
  });

  it("transitions waiting permission to failed when restored approval execution fails", () => {
    const waitingSnapshot = transitionThrough(createInitialTaskSnapshot(), [
      "planning",
      "running",
      "waiting_permission",
    ]);

    expect(transitionTask(waitingSnapshot, "failed").status).toBe("failed");
  });

  it("transitions running and verifying snapshots to failed", () => {
    const runningSnapshot = transitionThrough(createInitialTaskSnapshot(), [
      "planning",
      "running",
    ]);
    const verifyingSnapshot = transitionTask(runningSnapshot, "verifying");

    expect(transitionTask(runningSnapshot, "failed").status).toBe("failed");
    expect(transitionTask(verifyingSnapshot, "failed").status).toBe("failed");
  });

  it("does not allow terminal states to re-enter running flows", () => {
    for (const terminalStatus of ["completed", "failed", "cancelled"] as const) {
      const terminalSnapshot = {
        ...createInitialTaskSnapshot(),
        status: terminalStatus,
      };

      expect(isTerminalTaskStatus(terminalStatus)).toBe(true);
      expect(() => transitionTask(terminalSnapshot, "running")).toThrow(
        `Cannot transition terminal task task-idle from ${terminalStatus} to running.`,
      );
    }
  });

  it("allows idempotent terminal transitions", () => {
    const completedSnapshot = {
      ...createInitialTaskSnapshot(),
      status: "completed" as const,
    };

    expect(transitionTask(completedSnapshot, "completed").status).toBe("completed");
  });
});
