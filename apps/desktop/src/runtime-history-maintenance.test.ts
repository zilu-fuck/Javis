import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_CHECKPOINTS_PER_TASK,
  DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_PER_TASK,
  DEFAULT_RUNTIME_HISTORY_RETAIN_DAYS,
  RUNTIME_HISTORY_MAINTENANCE_INTERVAL_MS,
  runRuntimeHistoryMaintenance,
  runtimeHistoryRetentionCutoff,
  shouldRunRuntimeHistoryMaintenance,
} from "./runtime-history-maintenance";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");

function createReport(overrides: Record<string, unknown> = {}) {
  return {
    deletedSessionRows: 0,
    remainingSessionRows: 0,
    deletedCheckpointRows: 0,
    remainingCheckpointRows: 0,
    reclaimedBytes: 0,
    vacuumed: true,
    databaseBytes: 0,
    ...overrides,
  };
}

describe("runtime history retention cutoff", () => {
  it("derives an ISO-8601 UTC cutoff from the retention window", () => {
    expect(runtimeHistoryRetentionCutoff(30, NOW)).toBe("2026-08-14T00:00:00.000Z");
    expect(runtimeHistoryRetentionCutoff(0, NOW)).toBe("2026-09-13T00:00:00.000Z");
  });

  it("clamps negative and non-finite windows instead of moving the cutoff into the future", () => {
    expect(runtimeHistoryRetentionCutoff(-5, NOW)).toBe("2026-09-13T00:00:00.000Z");
    expect(runtimeHistoryRetentionCutoff(Number.NaN, NOW)).toBe("2026-09-13T00:00:00.000Z");
    expect(runtimeHistoryRetentionCutoff(2.9, NOW)).toBe("2026-09-11T00:00:00.000Z");
  });
});

describe("runtime history maintenance scheduling", () => {
  it("runs on the first opportunity and then honours the interval", () => {
    expect(shouldRunRuntimeHistoryMaintenance(undefined, NOW)).toBe(true);
    expect(shouldRunRuntimeHistoryMaintenance(NOW, NOW + 1_000)).toBe(false);
    expect(
      shouldRunRuntimeHistoryMaintenance(NOW, NOW + RUNTIME_HISTORY_MAINTENANCE_INTERVAL_MS),
    ).toBe(true);
  });
});

describe("runRuntimeHistoryMaintenance", () => {
  it("is a no-op when the native command is unavailable", async () => {
    await expect(runRuntimeHistoryMaintenance(null, {}, NOW)).resolves.toBeUndefined();
    await expect(runRuntimeHistoryMaintenance({}, {}, NOW)).resolves.toBeUndefined();
  });

  it("sends the retention defaults to the native command", async () => {
    const maintainRuntimeHistory = vi.fn(async () => createReport({ deletedSessionRows: 12 }));

    await expect(
      runRuntimeHistoryMaintenance({ maintainRuntimeHistory }, {}, NOW),
    ).resolves.toMatchObject({ deletedSessionRows: 12 });
    expect(maintainRuntimeHistory).toHaveBeenCalledWith({
      keepLatestPerTask: DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_PER_TASK,
      keepLatestCheckpointsPerTask: DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_CHECKPOINTS_PER_TASK,
      cutoffIso: "2026-08-14T00:00:00.000Z",
      vacuum: false,
    });
  });

  it("forwards explicit retention overrides and the vacuum opt-in", async () => {
    const maintainRuntimeHistory = vi.fn(async () => createReport());

    await runRuntimeHistoryMaintenance(
      { maintainRuntimeHistory },
      {
        keepLatestPerTask: 5,
        keepLatestCheckpointsPerTask: 2,
        retainDays: 1,
        vacuum: true,
      },
      NOW,
    );

    expect(maintainRuntimeHistory).toHaveBeenCalledWith({
      keepLatestPerTask: 5,
      keepLatestCheckpointsPerTask: 2,
      cutoffIso: "2026-09-12T00:00:00.000Z",
      vacuum: true,
    });
    expect(DEFAULT_RUNTIME_HISTORY_RETAIN_DAYS).toBe(30);
  });
});
