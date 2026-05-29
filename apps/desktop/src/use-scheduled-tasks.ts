import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ScheduledTask } from "./scheduled-tasks";
import { computeNextRun, isDue } from "./scheduled-tasks";
import type { createScheduledTasksRepository } from "./scheduled-tasks-persistence";

type SubmitGoal = (goalOverride?: string, workspacePathOverride?: string, scheduledTaskId?: string) => void;

export type ScheduledTasksRepositoryLike = ReturnType<typeof createScheduledTasksRepository> | null;

interface UseScheduledTasksOptions {
  scheduledTasks: ScheduledTask[];
  setScheduledTasks: Dispatch<SetStateAction<ScheduledTask[]>>;
  submitGoalRef: MutableRefObject<SubmitGoal>;
  isTaskActiveRef: MutableRefObject<boolean>;
  scheduledTasksRepoRef: MutableRefObject<ScheduledTasksRepositoryLike>;
}

export interface ScheduledTasksControls {
  scheduledTasks: ScheduledTask[];
  toggleScheduledTask(id: string): void;
  deleteScheduledTask(id: string): void;
}

export function useScheduledTasks({
  scheduledTasks,
  setScheduledTasks,
  submitGoalRef,
  isTaskActiveRef,
  scheduledTasksRepoRef,
}: UseScheduledTasksOptions): ScheduledTasksControls {
  useEffect(() => {
    const checkDue = () => {
      setScheduledTasks((current) => {
        const now = new Date();
        const updated = current.map((t) => {
          if (!isDue(t, now)) return t;
          if (isTaskActiveRef.current) return t;
          submitGoalRef.current(t.goal, t.workspacePath, t.id);
          const nextRun = computeNextRun(t.schedule, now.toISOString());
          return {
            ...t,
            lastRunStartedAt: now.toISOString(),
            nextRunAt: nextRun ?? t.nextRunAt,
            enabled: t.schedule.type === "once" && !nextRun ? false : t.enabled,
          };
        });
        const repository = scheduledTasksRepoRef.current;
        if (repository) {
          void repository.save(updated);
        }
        return updated;
      });
    };

    const interval = setInterval(checkDue, 60_000);
    const handleFocus = () => checkDue();
    window.addEventListener("focus", handleFocus);
    checkDue();

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [isTaskActiveRef, scheduledTasksRepoRef, submitGoalRef]);

  const toggleScheduledTask = useCallback((id: string) => {
    setScheduledTasks((current) => {
      const updated = current.map((t) =>
        t.id === id ? { ...t, enabled: !t.enabled } : t,
      );
      const repository = scheduledTasksRepoRef.current;
      if (repository) {
        void repository.save(updated);
      }
      return updated;
    });
  }, [scheduledTasksRepoRef]);

  const deleteScheduledTask = useCallback((id: string) => {
    setScheduledTasks((current) => {
      const updated = current.filter((t) => t.id !== id);
      const repository = scheduledTasksRepoRef.current;
      if (repository) {
        void repository.save(updated);
      }
      return updated;
    });
  }, [scheduledTasksRepoRef]);

  return {
    scheduledTasks,
    toggleScheduledTask,
    deleteScheduledTask,
  };
}
