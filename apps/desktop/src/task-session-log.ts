import type { TaskSnapshot } from "@javis/core";
import { sanitizeTaskSnapshot } from "./task-history";

export const TASK_SESSION_JSONL_STORAGE_KEY = "javis.taskSessionJsonl.v1";

export interface TaskSessionSnapshotJsonLine {
  kind: "task_session_snapshot";
  recordedAt: string;
  taskId: string;
  snapshot: TaskSnapshot;
}

export interface TaskSessionJsonLineWriter {
  appendLine(line: string): Promise<void>;
  /**
   * Optional fast path: receive the snapshot entry that was already sanitized by
   * `createTaskSessionSnapshotJsonLine`, so the durable writer does not have to
   * parse and re-sanitize the same ~3 KB snapshot again. Writers run at up to the
   * notification rate (observed 60/s while streaming), so the repeated deep
   * sanitize was a real cost.
   */
  appendEntry?(entry: TaskSessionSnapshotJsonLine): Promise<void>;
}

export function createLocalStorageTaskSessionJsonLineWriter(
  storage: Pick<Storage, "getItem" | "setItem">,
  key = TASK_SESSION_JSONL_STORAGE_KEY,
): TaskSessionJsonLineWriter {
  return {
    async appendLine(line) {
      storage.setItem(key, `${storage.getItem(key) ?? ""}${line}`);
    },
  };
}

export function createFileBackedTaskSessionJsonLineWriter(
  appendToFile: (line: string) => Promise<void>,
  fallbackStorage: Pick<Storage, "getItem" | "setItem">,
  fallbackKey = TASK_SESSION_JSONL_STORAGE_KEY,
): TaskSessionJsonLineWriter {
  const fallbackWriter = createLocalStorageTaskSessionJsonLineWriter(
    fallbackStorage,
    fallbackKey,
  );
  async function write(line: string) {
    try {
      await appendToFile(line);
    } catch {
      await fallbackWriter.appendLine(line);
    }
  }
  return {
    appendLine: write,
    appendEntry: (entry) => write(`${JSON.stringify(entry)}\n`),
  };
}

/** Minimum gap between two same-status writes for one task. */
export const DEFAULT_TASK_SESSION_WRITE_INTERVAL_MS = 1_500;

const DEFAULT_MAX_TRACKED_TASKS = 256;

export interface DeduplicatingTaskSessionWriter extends TaskSessionJsonLineWriter {
  /** Rows actually forwarded to the inner writer. */
  readonly writtenRows: number;
  /** Rows dropped because the snapshot repeated the previous persisted state. */
  readonly skippedDuplicateRows: number;
  /** Rows dropped because they arrived inside the per-task throttle window. */
  readonly skippedThrottledRows: number;
  forgetTask(taskId: string): void;
  reset(): void;
}

export interface DeduplicatingTaskSessionWriterOptions {
  minIntervalMs?: number;
  maxTrackedTasks?: number;
  now?: () => number;
}

interface TrackedTaskWriteState {
  fingerprint: string;
  status: TaskSnapshot["status"];
  writtenAt: number;
}

/**
 * Bounds what reaches the durable task session log.
 *
 * The runtime notifies subscribers on every streaming delta, and production
 * data showed it can also keep re-notifying an unchanged terminal snapshot
 * roughly 52 times per second. Persisting every notification verbatim produced a
 * 397 MB `task_session_log` table, with one 8 minute task accounting for 34,577
 * rows and 93 MB.
 *
 * Three rules keep the log bounded without losing resumable state:
 *
 *   1. a snapshot identical to the previous persisted snapshot of the same task
 *      carries no new information, so it is written once;
 *   2. a status transition is always written immediately, so every
 *      planning/running/waiting_permission/terminal step survives;
 *   3. remaining same-status writes are limited to one per task per
 *      `minIntervalMs`, which keeps the newest streamed state without writing a
 *      row per animation frame.
 *
 * The inner writer is created lazily per append so callers can resolve the
 * SQLite writer once the database is ready and still fall back to the
 * file-backed writer before that.
 */
export function createDeduplicatingTaskSessionWriter(
  createInner: () => TaskSessionJsonLineWriter,
  options: DeduplicatingTaskSessionWriterOptions = {},
): DeduplicatingTaskSessionWriter {
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = Math.max(
    0,
    options.minIntervalMs ?? DEFAULT_TASK_SESSION_WRITE_INTERVAL_MS,
  );
  const maxTrackedTasks = Math.max(1, options.maxTrackedTasks ?? DEFAULT_MAX_TRACKED_TASKS);
  const tracked = new Map<string, TrackedTaskWriteState>();
  let writtenRows = 0;
  let skippedDuplicateRows = 0;
  let skippedThrottledRows = 0;

  function remember(taskId: string, state: TrackedTaskWriteState) {
    // Re-inserting keeps `tracked` ordered by recency for bounded eviction.
    tracked.delete(taskId);
    tracked.set(taskId, state);
    while (tracked.size > maxTrackedTasks) {
      const oldest = tracked.keys().next();
      if (oldest.done) {
        break;
      }
      tracked.delete(oldest.value);
    }
  }

  /**
   * Shared accept path for both the line and the entry fast path.
   * Returns the entries worth writing (empty means "skip the write").
   */
  function accept(entries: TaskSessionSnapshotJsonLine[]): TaskSessionSnapshotJsonLine[] {
    const kept: TaskSessionSnapshotJsonLine[] = [];
    for (const entry of entries) {
      const fingerprint = JSON.stringify(entry.snapshot);
      const previous = tracked.get(entry.taskId);
      const timestamp = now();
      if (previous && previous.fingerprint === fingerprint) {
        skippedDuplicateRows += 1;
        remember(entry.taskId, previous);
        continue;
      }
      if (
        previous
        && previous.status === entry.snapshot.status
        && timestamp - previous.writtenAt < minIntervalMs
      ) {
        skippedThrottledRows += 1;
        continue;
      }
      kept.push(entry);
      remember(entry.taskId, {
        fingerprint,
        status: entry.snapshot.status,
        writtenAt: timestamp,
      });
    }
    return kept;
  }

  async function forward(
    kept: TaskSessionSnapshotJsonLine[],
    totalEntries: number,
    originalLine: string,
  ): Promise<void> {
    if (kept.length === 0) {
      return;
    }
    writtenRows += kept.length;
    const inner = createInner();
    const isWholeLine = kept.length === totalEntries;
    if (inner.appendEntry && isWholeLine) {
      await inner.appendEntry(kept[0]);
      return;
    }
    await inner.appendLine(
      isWholeLine
        ? originalLine
        : kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }

  return {
    get writtenRows() {
      return writtenRows;
    },
    get skippedDuplicateRows() {
      return skippedDuplicateRows;
    },
    get skippedThrottledRows() {
      return skippedThrottledRows;
    },
    forgetTask(taskId) {
      tracked.delete(taskId);
    },
    reset() {
      tracked.clear();
      writtenRows = 0;
      skippedDuplicateRows = 0;
      skippedThrottledRows = 0;
    },
    async appendLine(line) {
      const entries = parseTaskSessionJsonLines(line);
      if (entries.length === 0) {
        // Unparseable input is forwarded unchanged; the log must not silently drop data.
        await createInner().appendLine(line);
        return;
      }
      await forward(accept(entries), entries.length, line);
    },
    async appendEntry(entry) {
      await forward(accept([entry]), 1, `${JSON.stringify(entry)}\n`);
    },
  };
}

export async function appendTaskSessionSnapshotJsonLine(
  writer: TaskSessionJsonLineWriter,
  snapshot: TaskSnapshot,
  recordedAt = new Date().toISOString(),
): Promise<TaskSessionSnapshotJsonLine | null> {
  const entry = createTaskSessionSnapshotJsonLine(snapshot, recordedAt);
  if (!entry) {
    return null;
  }
  // The fast path hands over the already-sanitized entry so the writer does not
  // have to parse and deep-sanitize the same snapshot again.
  if (writer.appendEntry) {
    await writer.appendEntry(entry);
    return entry;
  }
  await writer.appendLine(`${JSON.stringify(entry)}\n`);
  return entry;
}

export function createTaskSessionSnapshotJsonLine(
  snapshot: TaskSnapshot,
  recordedAt = new Date().toISOString(),
): TaskSessionSnapshotJsonLine | null {
  const sanitized = sanitizeTaskSnapshot(snapshot);
  if (!sanitized || sanitized.id === "task-idle") {
    return null;
  }
  return {
    kind: "task_session_snapshot",
    recordedAt,
    taskId: sanitized.id,
    snapshot: sanitized,
  };
}

export function parseTaskSessionJsonLines(value: string): TaskSessionSnapshotJsonLine[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return sanitizeTaskSessionJsonLine(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((line): line is TaskSessionSnapshotJsonLine => Boolean(line));
}

export function resumeLatestTaskSessionSnapshot(
  lines: TaskSessionSnapshotJsonLine[],
): TaskSnapshot | undefined {
  return [...lines]
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .find((line) => !isTerminalStatus(line.snapshot.status))
    ?.snapshot;
}

export function rewindTaskSessionToSnapshot(
  lines: TaskSessionSnapshotJsonLine[],
  taskId: string,
  snapshotId: string,
): TaskSessionSnapshotJsonLine[] {
  const targetIndex = lines.findIndex(
    (line) => line.taskId === taskId && line.snapshot.id === snapshotId,
  );
  if (targetIndex < 0) {
    return lines;
  }
  return lines.slice(0, targetIndex + 1);
}

function sanitizeTaskSessionJsonLine(value: unknown): TaskSessionSnapshotJsonLine | null {
  if (!isRecord(value) || value.kind !== "task_session_snapshot") {
    return null;
  }
  if (!isString(value.recordedAt) || !isString(value.taskId)) {
    return null;
  }
  const snapshot = sanitizeTaskSnapshot(value.snapshot);
  if (!snapshot || snapshot.id !== value.taskId) {
    return null;
  }
  return {
    kind: "task_session_snapshot",
    recordedAt: value.recordedAt,
    taskId: value.taskId,
    snapshot,
  };
}

function isTerminalStatus(status: TaskSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
