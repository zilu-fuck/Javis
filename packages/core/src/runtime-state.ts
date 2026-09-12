import type { TaskSnapshot } from "./index";
import type { TaskRuntimeEvent } from "./task-event-bus";
import { createDeltaReducer } from "./delta-reducer";
import { compactTaskSnapshotLogs } from "./snapshot-utils";
import { isTerminalTaskStatus } from "./state/task-state";

/**
 * Whether a streaming delta should still be applied to the current snapshot.
 *
 * Once a task has reached a terminal status its remaining stream deltas are
 * noise: the flows have already emitted the final snapshot, and applying them
 * re-notifies subscribers (which persist a row per notification) at the stream's
 * own rate. Production data showed a failed task re-persisting an unchanged
 * snapshot ~52 times per second for five minutes for exactly this reason, and
 * because the sanitizer drops `streamingText` the repeated rows looked identical.
 *
 * A continuation that reuses a task id is unaffected: the flow always emits its
 * non-terminal starting snapshot before the model stream produces deltas.
 */
export function shouldAcceptRuntimeDelta(
  snapshot: Pick<TaskSnapshot, "id" | "status">,
  event: Pick<TaskRuntimeEvent, "taskId">,
): boolean {
  if (snapshot.id !== event.taskId) {
    return false;
  }
  return !isTerminalTaskStatus(snapshot.status);
}

export interface RuntimeState {
  clearTimers(): void;
  dispose(): void;
  emit(nextSnapshot: TaskSnapshot): void;
  /** Apply an incremental event and notify subscribers. For streaming LLM output paths. */
  emitDelta(event: TaskRuntimeEvent): void;
  getSnapshot(): TaskSnapshot;
  isDisposed(): boolean;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
  wait(): Promise<void>;
}

export function createRuntimeState(
  initialSnapshot: TaskSnapshot,
  delayMs: number,
): RuntimeState {
  let snapshot = initialSnapshot;
  const listeners = new Set<(nextSnapshot: TaskSnapshot) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let pendingFrame: ReturnType<typeof setTimeout> | number | undefined;
  let disposed = false;
  const deltaReducer = createDeltaReducer(initialSnapshot);
  const notify = () => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const scheduleNotify = () => {
    if (pendingFrame !== undefined) {
      return;
    }
    const flush = () => {
      pendingFrame = undefined;
      if (!disposed) {
        notify();
      }
    };
    if (typeof requestAnimationFrame === "function") {
      pendingFrame = requestAnimationFrame(flush);
      return;
    }
    pendingFrame = setTimeout(flush, 0);
  };

  return {
    clearTimers() {
      disposed = false;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
    dispose() {
      disposed = true;
      if (pendingFrame !== undefined) {
        if (typeof cancelAnimationFrame === "function" && typeof pendingFrame === "number") {
          cancelAnimationFrame(pendingFrame);
        } else {
          clearTimeout(pendingFrame as ReturnType<typeof setTimeout>);
        }
        pendingFrame = undefined;
      }
      this.clearTimers();
      listeners.clear();
    },
    emit(nextSnapshot) {
      if (disposed) {
        return;
      }
      snapshot = compactTaskSnapshotLogs(nextSnapshot);
      deltaReducer.syncFrom(nextSnapshot);
      notify();
    },
    emitDelta(event) {
      if (disposed) {
        return;
      }
      snapshot = deltaReducer.apply(event);
      if (event.kind === "agent.chunk_end") {
        notify();
        return;
      }
      scheduleNotify();
    },
    getSnapshot() {
      return snapshot;
    },
    isDisposed() {
      return disposed;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    wait() {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, delayMs);
        timers.add(timer);
      });
    },
  };
}
