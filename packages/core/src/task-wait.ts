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
