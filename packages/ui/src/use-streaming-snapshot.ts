import { useEffect, useRef, useState } from "react";

/**
 * RAF-throttled subscription to a TaskRuntime.
 * Avoids re-rendering on every chunk during streaming output.
 * At most ~60fps; in practice 15-30fps is sufficient for typewriter effect.
 */
export function useStreamingSnapshot<T>(runtime: {
  getSnapshot(): T;
  subscribe(listener: (snapshot: T) => void): () => void;
}): T {
  const [snapshot, setSnapshot] = useState<T>(() => runtime.getSnapshot());
  const rafId = useRef<number>(0);
  const pending = useRef<T | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = runtime.subscribe((next) => {
      pending.current = next;
      if (rafId.current === 0) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = 0;
          if (!cancelled && pending.current !== null) {
            setSnapshot(pending.current);
            pending.current = null;
          }
        });
      }
    });
    return () => {
      cancelled = true;
      if (rafId.current !== 0) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
      }
      unsubscribe();
    };
  }, [runtime]);

  return snapshot;
}
