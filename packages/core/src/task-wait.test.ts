import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskCancelledError,
  TaskStallError,
  TaskTimeoutError,
  isTaskStallError,
  withStallWatchdog,
  withTaskTimeout,
} from "./task-wait";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTaskTimeout", () => {
  it("still fails on a total timeout", async () => {
    vi.useFakeTimers();
    const promise = withTaskTimeout(() => new Promise<void>(() => {}), {
      label: "Operation",
      timeoutMs: 1_000,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(TaskTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("does not fire when the operation finishes first", async () => {
    vi.useFakeTimers();
    const promise = withTaskTimeout(async () => "done", { label: "Operation", timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).resolves.toBe("done");
  });
});

describe("withStallWatchdog", () => {
  it("resolves when progress keeps arriving and reports counts", async () => {
    vi.useFakeTimers();
    let report: (() => void) | undefined;
    let release: (() => void) | undefined;
    let progressReports = 0;
    const promise = withStallWatchdog(
      async (reportProgress) => {
        report = () => {
          progressReports += 1;
          reportProgress();
        };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "streamed";
      },
      { label: "Generation", stallMs: 100 },
    );

    // Five reports, each inside the 100ms window.
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(50);
      report?.();
    }
    release?.();

    await expect(promise).resolves.toBe("streamed");
    expect(progressReports).toBe(5);
  });

  it("fails when nothing reports progress in time", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const promise = withStallWatchdog(
      () => new Promise<void>(() => {}),
      { label: "Generation", stallMs: 60_000, onStall },
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(TaskStallError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(onStall).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toThrow(/stalled: no progress for 60000ms/u);
  });

  it("resets the stall window on every progress report", async () => {
    vi.useFakeTimers();
    let report: (() => void) | undefined;
    let release: (() => void) | undefined;
    const promise = withStallWatchdog(
      async (reportProgress) => {
        report = reportProgress;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "kept going";
      },
      { label: "Generation", stallMs: 100 },
    );

    // Ten reports at 90ms apart: a naive total timeout of 100ms would have failed
    // long before the end, a per-progress watchdog does not.
    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(90);
      report?.();
    }
    release?.();

    await expect(promise).resolves.toBe("kept going");
  });

  it("reports the stall as a distinguishable error", async () => {
    vi.useFakeTimers();
    const promise = withStallWatchdog(() => new Promise<void>(() => {}), {
      label: "Generation",
      stallMs: 1_000,
    });
    const assertion = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await assertion;
    expect(isTaskStallError(error)).toBe(true);
    expect(isTaskStallError(new TaskTimeoutError("x", 1))).toBe(false);
  });

  it("aborts with the caller's reason before the stall window", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new TaskCancelledError("user stopped the task");
    const promise = withStallWatchdog(
      () => new Promise<void>(() => {}),
      { label: "Generation", stallMs: 60_000, signal: controller.signal },
    );
    const assertion = expect(promise).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
  });

  it("propagates the operation's own failure", async () => {
    const promise = withStallWatchdog(
      async () => {
        throw new Error("provider exploded");
      },
      { label: "Generation", stallMs: 60_000 },
    );
    await expect(promise).rejects.toThrow("provider exploded");
  });

  it("fails immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new TaskCancelledError("already stopped"));
    await expect(
      withStallWatchdog(async () => "never", {
        label: "Generation",
        stallMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
  });
});
