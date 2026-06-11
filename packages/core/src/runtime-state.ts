import type { TaskSnapshot } from "./index";
import type { TaskRuntimeEvent } from "./task-event-bus";
import { createDeltaReducer } from "./delta-reducer";
import { compactTaskSnapshotLogs } from "./snapshot-utils";

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
