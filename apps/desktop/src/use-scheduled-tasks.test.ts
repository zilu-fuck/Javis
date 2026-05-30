// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScheduledTasks } from "./use-scheduled-tasks";
import type { ScheduledTask } from "./scheduled-tasks";

function createScheduledTasksRepo() {
  let lastSaved: ScheduledTask[] | null = null;
  return {
    list: vi.fn().mockResolvedValue([]),
    save(tasks: ScheduledTask[]) {
      lastSaved = tasks;
      return Promise.resolve(tasks);
    },
    upsert: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue([]),
    importFromLocalStorage: vi.fn().mockResolvedValue([]),
    getLastSaved() {
      return lastSaved;
    },
  };
}

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "st-1",
    name: "Test Task",
    goal: "Run tests",
    workspacePath: "/test",
    schedule: { type: "interval", value: "3600000" },
    enabled: true,
    nextRunAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: new Date().toISOString(),
    source: "user",
    ...overrides,
  };
}

describe("useScheduledTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupHook(tasks: ScheduledTask[]) {
    const repo = createScheduledTasksRepo();
    const repoRef = { current: repo };
    const submitGoalRef = { current: vi.fn() };
    const isTaskActiveRef = { current: false };
    const setScheduledTasks = vi.fn().mockImplementation(
      (updater: (prev: ScheduledTask[]) => ScheduledTask[]) => {
        tasks = updater(tasks);
      },
    );

    const { result } = renderHook(
      ({ tasks: t }: { tasks: ScheduledTask[] }) =>
        useScheduledTasks({
          scheduledTasks: t,
          setScheduledTasks,
          submitGoalRef,
          isTaskActiveRef,
          scheduledTasksRepoRef: repoRef,
        } as any),
      { initialProps: { tasks: [...tasks] } },
    );

    return { result, repo, tasks, setScheduledTasks };
  }

  it("toggleScheduledTask toggles enabled flag and persists", () => {
    const { result, repo, setScheduledTasks } = setupHook([createTask({ enabled: true })]);

    act(() => {
      result.current.toggleScheduledTask("st-1");
    });

    expect(setScheduledTasks).toHaveBeenCalled();

    const saved = repo.getLastSaved();
    expect(saved).not.toBeNull();
    expect(saved![0].enabled).toBe(false);
  });

  it("deleteScheduledTask removes the task and persists", () => {
    const { result, repo, setScheduledTasks } = setupHook([
      createTask({ id: "st-1" }),
      createTask({ id: "st-2", name: "Task 2" }),
    ]);

    act(() => {
      result.current.deleteScheduledTask("st-1");
    });

    expect(setScheduledTasks).toHaveBeenCalled();

    const saved = repo.getLastSaved();
    expect(saved).not.toBeNull();
    expect(saved!.length).toBe(1);
    expect(saved![0].id).toBe("st-2");
  });

  it("returns scheduledTasks from props", () => {
    const tasks = [createTask(), createTask({ id: "st-2", name: "Task 2" })];
    const { result } = setupHook(tasks);

    expect(result.current.scheduledTasks).toEqual(tasks);
  });

  it("toggle and delete on non-existent id do not throw", () => {
    const { result } = setupHook([createTask()]);

    expect(() => {
      act(() => result.current.toggleScheduledTask("nonexistent"));
    }).not.toThrow();

    expect(() => {
      act(() => result.current.deleteScheduledTask("nonexistent"));
    }).not.toThrow();
  });
});
