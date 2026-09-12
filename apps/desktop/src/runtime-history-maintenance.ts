import type {
  DesktopDatabase,
  RuntimeHistoryMaintenanceReport,
} from "./desktop-database";

/**
 * Retention policy for the append-heavy runtime history tables.
 *
 * `task_session_log` and `workflow_checkpoints` exist so a task can be resumed,
 * its approvals replayed, or its run rewound after a restart. That only needs the
 * recent history of a task — not every streamed snapshot and step checkpoint
 * forever.
 */
export const DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_PER_TASK = 100;
export const DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_CHECKPOINTS_PER_TASK = 20;
export const DEFAULT_RUNTIME_HISTORY_RETAIN_DAYS = 30;

/** How often at most the bounded maintenance pass may run during a session. */
export const RUNTIME_HISTORY_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1_000;

export interface RuntimeHistoryMaintenanceOptions {
  keepLatestPerTask?: number;
  keepLatestCheckpointsPerTask?: number;
  retainDays?: number;
  /** Only worth enabling for the startup pass; VACUUM rewrites the whole file. */
  vacuum?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * ISO-8601 UTC cutoff used by the native prune. Timestamps are always written by
 * `toISOString()`, so lexicographic comparison in SQLite matches chronology.
 */
export function runtimeHistoryRetentionCutoff(retainDays: number, now = Date.now()): string {
  const days = Number.isFinite(retainDays) ? Math.max(0, Math.trunc(retainDays)) : 0;
  return new Date(now - days * DAY_MS).toISOString();
}

export function shouldRunRuntimeHistoryMaintenance(
  lastRunAt: number | undefined,
  now: number,
  intervalMs = RUNTIME_HISTORY_MAINTENANCE_INTERVAL_MS,
): boolean {
  if (lastRunAt === undefined) {
    return true;
  }
  return now - lastRunAt >= intervalMs;
}

/**
 * Runs the native maintenance pass when the database exposes it.
 *
 * Returns `undefined` when the running desktop build has no native command for
 * it (older bundle), so callers can treat maintenance as best effort and never
 * fail a task because housekeeping was unavailable.
 */
export async function runRuntimeHistoryMaintenance(
  database: Pick<DesktopDatabase, "maintainRuntimeHistory"> | null | undefined,
  options: RuntimeHistoryMaintenanceOptions = {},
  now = Date.now(),
): Promise<RuntimeHistoryMaintenanceReport | undefined> {
  if (!database?.maintainRuntimeHistory) {
    return undefined;
  }
  return database.maintainRuntimeHistory({
    keepLatestPerTask:
      options.keepLatestPerTask ?? DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_PER_TASK,
    keepLatestCheckpointsPerTask:
      options.keepLatestCheckpointsPerTask
      ?? DEFAULT_RUNTIME_HISTORY_KEEP_LATEST_CHECKPOINTS_PER_TASK,
    cutoffIso: runtimeHistoryRetentionCutoff(
      options.retainDays ?? DEFAULT_RUNTIME_HISTORY_RETAIN_DAYS,
      now,
    ),
    vacuum: options.vacuum ?? false,
  });
}
