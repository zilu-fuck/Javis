// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTaskRuntime } from "./use-task-runtime";
import type { TaskSnapshot } from "@javis/core";

function createTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const base: TaskSnapshot = {
    id: "task-1",
    title: "Test Task",
    userGoal: "Test goal",
    status: "running",
    commanderMessage: "Working on it...",
    logs: [],
    plan: [],
    agents: [],
    workspacePath: "",
    scheduledTaskId: undefined,
    updatedAt: undefined,
  } as TaskSnapshot;
  return { ...base, ...overrides };
}

describe("useTaskRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupHook(taskHistoryRepository: { upsert(task: TaskSnapshot): Promise<TaskSnapshot[]> } | null = null) {
    let subscriber: ((snapshot: TaskSnapshot) => void) | null = null;
    let historyState: TaskSnapshot[] = [];
    const runtime = {
      subscribe: vi.fn((fn: (snapshot: TaskSnapshot) => void) => {
        subscriber = fn;
        return () => { subscriber = null; };
      }),
      dispose: vi.fn(),
      emit(snapshot: TaskSnapshot) {
        subscriber?.(snapshot);
      },
    };

    const setHistory = vi.fn((updater) => {
      historyState = typeof updater === "function" ? updater(historyState) : updater;
    });
    const setActiveHistoryEntryId = vi.fn();
    const setScheduledTasks = vi.fn();
    const persistWorkspaceForTask = vi.fn();
    const persistDurableApprovalRecord = vi.fn();
    const onTaskSnapshot = vi.fn();

    const { result } = renderHook(() =>
      useTaskRuntime({
        runtime,
        setHistory,
        setActiveHistoryEntryId,
        setScheduledTasks,
        persistWorkspaceForTask,
        persistDurableApprovalRecord,
        onTaskSnapshot,
        taskHistoryRepoRef: { current: taskHistoryRepository },
        scheduledTasksRepoRef: { current: null },
        workspacePathRef: { current: "/test" },
      } as any),
    );

    return {
      result,
      runtime,
      setActiveHistoryEntryId,
      onTaskSnapshot,
      persistDurableApprovalRecord,
      getHistory: () => historyState,
    };
  }

  it("initializes with isTaskActive false and idle task snapshot", () => {
    const { result } = setupHook();

    expect(result.current.isTaskActive).toBe(false);
    expect(result.current.task.status).toBe("created");
    expect(result.current.task.id).toBe("task-idle");
  });

  it("setIsTaskActive updates both state and ref", () => {
    const { result } = setupHook();

    act(() => {
      result.current.setIsTaskActive(true);
    });

    expect(result.current.isTaskActive).toBe(true);
    expect(result.current.isTaskActiveRef.current).toBe(true);
  });

  it("enqueueTaskSnapshot eventually calls setTask", () => {
    const { result } = setupHook();

    const snapshot = createTaskSnapshot();
    act(() => {
      result.current.enqueueTaskSnapshot(snapshot);
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.task.id).toBe("task-1");
  });

  it("streaming snapshots with same ID merge in queue", () => {
    const { result } = setupHook();

    const firstStream = createTaskSnapshot({
      id: "task-s1",
      isStreaming: true,
      streamingText: "Hello",
    });
    const secondStream = createTaskSnapshot({
      id: "task-s1",
      isStreaming: true,
      streamingText: "Hello World",
    });

    act(() => {
      result.current.enqueueTaskSnapshot(firstStream);
      result.current.enqueueTaskSnapshot(secondStream);
    });

    // Flush the streaming snapshot timer (16ms delay)
    act(() => {
      vi.advanceTimersByTime(20);
    });

    // Merged snapshot should have the latest streamingText from secondStream
    expect(result.current.task.id).toBe("task-s1");
    expect(result.current.task.streamingText).toBe("Hello World");
  });

  it("clearQueuedTaskSnapshots prevents task update", () => {
    const { result } = setupHook();

    const snapshot = createTaskSnapshot();
    act(() => {
      result.current.enqueueTaskSnapshot(snapshot);
      result.current.clearQueuedTaskSnapshots();
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.task.id).toBe("task-idle");
  });

  it("selects the archived history entry when a task reaches a terminal state", () => {
    const { runtime, setActiveHistoryEntryId } = setupHook();

    act(() => {
      runtime.emit(createTaskSnapshot({
        id: "task-done",
        status: "completed",
        conversationMessages: [
          { role: "user", content: "Build a local wallpaper video browser" },
          { role: "assistant", content: "Done." },
        ],
      }));
    });

    expect(setActiveHistoryEntryId).toHaveBeenCalledWith("task-done");
  });

  it("archives and persists failed DAG snapshots with undefined optional fields", () => {
    const repository = { upsert: vi.fn().mockResolvedValue([]) };
    const { runtime, getHistory } = setupHook(repository);
    const failed = createTaskSnapshot({
      id: "task-failed",
      status: "failed",
      plan: [{
        id: "fallback",
        title: "Try Page Agent fallback",
        assignedAgentKind: "page-agent",
        status: "failed",
        inputContextKeys: undefined,
        outputContextKey: undefined,
      }],
      logs: [{
        id: "task-failed-waiting",
        kind: "event",
        title: "waiting_model",
        detail: "Waiting for Page Agent.",
        agentId: undefined,
        stepId: undefined,
      }],
    });

    act(() => {
      runtime.emit(failed);
    });

    expect(getHistory()).toHaveLength(1);
    expect(getHistory()[0]).toMatchObject({ id: "task-failed", status: "failed" });
    expect(repository.upsert).toHaveBeenCalledWith(failed);
  });

  it("reports terminal history persistence failures", async () => {
    const error = new Error("database unavailable");
    const repository = { upsert: vi.fn().mockRejectedValue(error) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runtime } = setupHook(repository);

    act(() => {
      runtime.emit(createTaskSnapshot({ id: "task-failed-write", status: "failed" }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(warn).toHaveBeenCalledWith(
      "[TaskHistory] Failed to persist task snapshot.",
      expect.objectContaining({
        taskId: "task-failed-write",
        status: "failed",
        error,
      }),
    );
    warn.mockRestore();
  });
});
