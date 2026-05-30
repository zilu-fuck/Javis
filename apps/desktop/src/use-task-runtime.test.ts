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

  function setupHook() {
    let subscriber: ((snapshot: TaskSnapshot) => void) | null = null;
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

    const setHistory = vi.fn();
    const setScheduledTasks = vi.fn();
    const persistWorkspaceForTask = vi.fn();
    const persistDurableApprovalRecord = vi.fn();
    const onTaskSnapshot = vi.fn();

    const { result } = renderHook(() =>
      useTaskRuntime({
        runtime,
        setHistory,
        setScheduledTasks,
        persistWorkspaceForTask,
        persistDurableApprovalRecord,
        onTaskSnapshot,
        taskHistoryRepoRef: { current: null },
        scheduledTasksRepoRef: { current: null },
        workspacePathRef: { current: "/test" },
      } as any),
    );

    return { result, runtime, onTaskSnapshot, persistDurableApprovalRecord };
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
});
