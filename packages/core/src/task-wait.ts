export const DEFAULT_TASK_TIMEOUT_MS = 90_000;

export class TaskCancelledError extends Error {
  constructor(message = "Task cancelled.") {
    super(message);
    this.name = "TaskCancelledError";
  }
}

export class TaskTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = "TaskTimeoutError";
  }
}

/**
 * Raised when an operation stopped reporting progress.
 *
 * Distinct from a total timeout: a long generation is allowed to take a long
 * time, but a generation that has produced nothing for a minute is dead. The
 * distinction matters because the caller can keep partial output on a stall but
 * must not treat it as a clean, complete result.
 */
export class TaskStallError extends Error {
  constructor(label: string, stallMs: number) {
    super(`${label} stalled: no progress for ${stallMs}ms.`);
    this.name = "TaskStallError";
  }
}

export function isTaskStallError(error: unknown): boolean {
  return error instanceof TaskStallError;
}

export interface TaskWaitOptions {
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTimeout?: () => void;
  onAbort?: () => void;
}

export function throwIfTaskAborted(signal: AbortSignal | undefined, label = "Task"): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new TaskCancelledError(`${label} cancelled.`);
}

export function isTaskCancelledError(error: unknown): boolean {
  return error instanceof TaskCancelledError ||
    error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && /cancelled|canceled|aborted/i.test(error.message);
}

export async function withTaskTimeout<T>(
  promise: Promise<T> | (() => Promise<T>),
  {
    label,
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    signal,
    onTimeout,
    onAbort,
  }: TaskWaitOptions,
): Promise<T> {
  throwIfTaskAborted(signal, label);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        onTimeout?.();
        reject(new TaskTimeoutError(label, timeoutMs));
      }, timeoutMs);

      abortHandler = () => {
        onAbort?.();
        const reason = signal?.reason;
        reject(reason instanceof Error ? reason : new TaskCancelledError(`${label} cancelled.`));
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      const operation = typeof promise === "function" ? promise() : promise;
      operation.then(resolve, reject);
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}

export interface StallWatchdogOptions {
  label: string;
  /** Fail once no progress has been reported for this long. */
  stallMs: number;
  signal?: AbortSignal;
  onStall?: () => void;
  onAbort?: () => void;
}

/**
 * Runs an operation that must keep reporting progress, and fails it when it goes
 * quiet for `stallMs`.
 *
 * A total timeout cannot express "this is still working" versus "this is hung".
 * Long document generation legitimately runs for minutes, but production also
 * showed tasks that produced nothing for hours. This watchdog lets the caller
 * distinguish the two and decide whether partial output is worth keeping.
 *
 * The operation receives `reportProgress`, which must be called on every unit of
 * real progress (a streamed chunk, a completed step).
 */
export async function withStallWatchdog<T>(
  run: (reportProgress: () => void) => Promise<T>,
  { label, stallMs, signal, onStall, onAbort }: StallWatchdogOptions,
): Promise<T> {
  throwIfTaskAborted(signal, label);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let settled = false;

  const arm = (reject: (error: unknown) => void) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onStall?.();
      reject(new TaskStallError(label, stallMs));
    }, stallMs);
  };

  try {
    return await new Promise<T>((resolve, reject) => {
      abortHandler = () => {
        if (settled) return;
        settled = true;
        onAbort?.();
        const reason = signal?.reason;
        reject(reason instanceof Error ? reason : new TaskCancelledError(`${label} cancelled.`));
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      arm(reject);
      run(() => {
        if (!settled) {
          arm(reject);
        }
      }).then(
        (value) => {
          settled = true;
          resolve(value);
        },
        (error: unknown) => {
          settled = true;
          reject(error);
        },
      );
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}
