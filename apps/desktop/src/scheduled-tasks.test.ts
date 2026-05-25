import { describe, expect, it } from "vitest";
import {
  clearStaleGuards,
  computeNextRun,
  formatSchedule,
  isDue,
  type ScheduledTask,
} from "./scheduled-tasks";

describe("scheduled tasks", () => {
  it("computes interval next runs from the current time", () => {
    expect(computeNextRun(
      { type: "interval", value: String(30 * 60 * 1000) },
      "2026-05-25T10:00:00.000Z",
    )).toBe("2026-05-25T10:30:00.000Z");
  });

  it("rejects invalid interval values", () => {
    expect(computeNextRun({ type: "interval", value: "0" }, "2026-05-25T10:00:00.000Z"))
      .toBeNull();
    expect(computeNextRun({ type: "interval", value: "not-a-number" }, "2026-05-25T10:00:00.000Z"))
      .toBeNull();
  });

  it("keeps a daily schedule on the same day when the time is still ahead", () => {
    expect(computeNextRun({ type: "daily", value: "12:15" }, localIso(2026, 4, 25, 10, 0)))
      .toBe(localIso(2026, 4, 25, 12, 15));
  });

  it("moves a daily schedule to tomorrow when today's time has passed", () => {
    expect(computeNextRun({ type: "daily", value: "09:00" }, localIso(2026, 4, 25, 10, 0)))
      .toBe(localIso(2026, 4, 26, 9, 0));
  });

  it("keeps a weekly schedule on the same day when the time is still ahead", () => {
    expect(computeNextRun({ type: "weekly", value: "Mon 12:15" }, localIso(2026, 4, 25, 10, 0)))
      .toBe(localIso(2026, 4, 25, 12, 15));
  });

  it("moves a weekly schedule to next week when same-day time has passed", () => {
    expect(computeNextRun({ type: "weekly", value: "Mon 09:00" }, localIso(2026, 4, 25, 10, 0)))
      .toBe(localIso(2026, 5, 1, 9, 0));
  });

  it("returns the configured run time for one-time schedules", () => {
    expect(computeNextRun({ type: "once", value: "2026-05-25T12:00:00.000Z" }, "2026-05-25T10:00:00.000Z"))
      .toBe("2026-05-25T12:00:00.000Z");
    expect(computeNextRun({ type: "once", value: "2026-05-25T09:00:00.000Z" }, "2026-05-25T10:00:00.000Z"))
      .toBeNull();
  });

  it("checks due tasks while respecting disabled and running guards", () => {
    const dueTask = createTask({ enabled: true, nextRunAt: "2026-05-25T09:59:00.000Z" });
    expect(isDue(dueTask, new Date("2026-05-25T10:00:00.000Z"))).toBe(true);
    expect(isDue({ ...dueTask, enabled: false }, new Date("2026-05-25T10:00:00.000Z")))
      .toBe(false);
    expect(isDue(
      { ...dueTask, lastRunStartedAt: "2026-05-25T09:58:00.000Z" },
      new Date("2026-05-25T10:00:00.000Z"),
    )).toBe(false);
  });

  it("clears stale running guards", () => {
    expect(clearStaleGuards([
      createTask({ lastRunStartedAt: "2026-05-25T09:58:00.000Z" }),
    ])).toEqual([
      expect.objectContaining({ lastRunStartedAt: undefined }),
    ]);
  });

  it("formats schedule labels", () => {
    expect(formatSchedule({ type: "interval", value: String(90 * 60 * 1000) })).toBe("Every 2h");
    expect(formatSchedule({ type: "daily", value: "09:00" })).toBe("Daily at 09:00");
    expect(formatSchedule({ type: "weekly", value: "Mon 09:00" })).toBe("Weekly Mon 09:00");
    expect(formatSchedule({ type: "once", value: "2026-05-25T10:00:00.000Z" })).toContain("Once:");
  });
});

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "st-test",
    name: "Test task",
    goal: "Run the test task",
    workspacePath: "E:\\Javis",
    schedule: { type: "daily", value: "09:00" },
    enabled: true,
    nextRunAt: "2026-05-25T10:00:00.000Z",
    createdAt: "2026-05-25T08:00:00.000Z",
    source: "user",
    ...overrides,
  };
}

function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).toISOString();
}
