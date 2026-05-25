import type { TaskSnapshot } from "./index";

export interface RuntimeState {
  clearTimers(): void;
  dispose(): void;
  emit(nextSnapshot: TaskSnapshot): void;
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
  let disposed = false;

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
      this.clearTimers();
      listeners.clear();
    },
    emit(nextSnapshot) {
      if (disposed) {
        return;
      }
      snapshot = nextSnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
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
