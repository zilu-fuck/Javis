import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { createInitialTaskSnapshot, type TaskSnapshot } from "@javis/core";
import { getCompletedTaskWorkspacePath } from "./workspace-session";
import { isArchivableTask, upsertTaskHistory, type createTaskHistoryRepository } from "./task-history";
import type { ScheduledTask } from "./scheduled-tasks";
import type { createScheduledTasksRepository } from "./scheduled-tasks-persistence";
import type { createJavisRuntime } from "./app-runtime";

// Deliberately lower than the raw event rate — human eyes perceive ~20 fps as fluid
// while higher rates (60+ fps) waste React render budget on invisible deltas.
const TASK_SNAPSHOT_REVEAL_DELAY_MS = 60;
const STREAMING_SNAPSHOT_REVEAL_DELAY_MS = 50;

export type TaskHistoryRepositoryLike = ReturnType<typeof createTaskHistoryRepository> | null;
export type ScheduledTasksRepositoryLike = ReturnType<typeof createScheduledTasksRepository> | null;

interface UseTaskRuntimeOptions {
  runtime: ReturnType<typeof createJavisRuntime>;
  setHistory: Dispatch<SetStateAction<TaskSnapshot[]>>;
  setActiveHistoryEntryId?: Dispatch<SetStateAction<string | undefined>>;
  setScheduledTasks: Dispatch<SetStateAction<ScheduledTask[]>>;
  persistWorkspaceForTask: (status: TaskSnapshot["status"], workspacePath: string) => void;
  persistDurableApprovalRecord: (nextTask: TaskSnapshot) => void;
  onTaskSnapshot?: (nextTask: TaskSnapshot) => void;
  createInitialTask?: () => TaskSnapshot;
  taskHistoryRepoRef: MutableRefObject<TaskHistoryRepositoryLike>;
  scheduledTasksRepoRef: MutableRefObject<ScheduledTasksRepositoryLike>;
  workspacePathRef: MutableRefObject<string>;
}

export interface TaskRuntimeControls {
  task: TaskSnapshot;
  setTask: Dispatch<SetStateAction<TaskSnapshot>>;
  isTaskActive: boolean;
  setIsTaskActive(value: boolean): void;
  isTaskActiveRef: MutableRefObject<boolean>;
  activeScheduledTaskId: string | undefined;
  setActiveScheduledTaskId(value: string | undefined): void;
  pendingScheduledTaskIdRef: MutableRefObject<string | undefined>;
  clearQueuedTaskSnapshots(): void;
  enqueueTaskSnapshot(nextTask: TaskSnapshot): void;
}

export function useTaskRuntime({
  runtime,
  setHistory,
  setActiveHistoryEntryId,
  setScheduledTasks,
  persistWorkspaceForTask,
  persistDurableApprovalRecord,
  onTaskSnapshot,
  createInitialTask,
  taskHistoryRepoRef,
  scheduledTasksRepoRef,
  workspacePathRef,
}: UseTaskRuntimeOptions): TaskRuntimeControls {
  const [task, setTask] = useState(createInitialTask ?? createInitialTaskSnapshot);
  const [isTaskActive, setIsTaskActiveState] = useState(false);
  const isTaskActiveRef = useRef(false);
  const [activeScheduledTaskId, setActiveScheduledTaskId] = useState<string | undefined>();
  const taskQueueRef = useRef<TaskSnapshot[]>([]);
  const taskFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScheduledTaskIdRef = useRef<string | undefined>(undefined);
  const persistWorkspaceForTaskRef = useRef(persistWorkspaceForTask);
  const persistDurableApprovalRecordRef = useRef(persistDurableApprovalRecord);
  const onTaskSnapshotRef = useRef(onTaskSnapshot);

  persistWorkspaceForTaskRef.current = persistWorkspaceForTask;
  persistDurableApprovalRecordRef.current = persistDurableApprovalRecord;
  onTaskSnapshotRef.current = onTaskSnapshot;

  function setIsTaskActive(value: boolean) {
    isTaskActiveRef.current = value;
    setIsTaskActiveState(value);
  }

  function clearQueuedTaskSnapshots() {
    if (taskFlushTimerRef.current) {
      clearTimeout(taskFlushTimerRef.current);
      taskFlushTimerRef.current = null;
    }
    taskQueueRef.current = [];
  }

  function scheduleQueuedTaskSnapshot(delayMs = 0) {
    if (taskFlushTimerRef.current) {
      return;
    }

    taskFlushTimerRef.current = setTimeout(() => {
      taskFlushTimerRef.current = null;
      const nextTask = taskQueueRef.current.shift();
      if (!nextTask) {
        return;
      }
      setTask(nextTask);

      // If multiple snapshots piled up (e.g. parallel DAG steps completing),
      // drain the backlog rapidly so the user sees each state transition
      // without artificial pauses between them.
      if (taskQueueRef.current.length > 0) {
        scheduleQueuedTaskSnapshot(
          taskQueueRef.current.length > 2
            ? 0
            : isStreamingTaskSnapshot(nextTask)
              ? STREAMING_SNAPSHOT_REVEAL_DELAY_MS
              : TASK_SNAPSHOT_REVEAL_DELAY_MS,
        );
      }
    }, delayMs);
  }

  function enqueueTaskSnapshot(nextTask: TaskSnapshot) {
    const queue = taskQueueRef.current;
    const lastQueuedTask = queue[queue.length - 1];
    if (
      lastQueuedTask &&
      isStreamingTaskSnapshot(lastQueuedTask) &&
      isStreamingTaskSnapshot(nextTask) &&
      lastQueuedTask.id === nextTask.id
    ) {
      queue[queue.length - 1] = nextTask;
    } else {
      queue.push(nextTask);
    }
    scheduleQueuedTaskSnapshot();
  }

  useEffect(() => {
    const unsubscribe = runtime.subscribe((nextTask) => {
      const sid = pendingScheduledTaskIdRef.current;
      if (sid) {
        nextTask.scheduledTaskId = sid;
        pendingScheduledTaskIdRef.current = undefined;
      }

      enqueueTaskSnapshot(nextTask);
      onTaskSnapshotRef.current?.(nextTask);

      if (isArchivableTask(nextTask)) {
        setHistory((current) => {
          const updated = upsertTaskHistory(current, nextTask);
          const repository = taskHistoryRepoRef.current;
          if (repository) {
            void repository.upsert(nextTask);
          }
          setActiveHistoryEntryId?.(nextTask.id);
          return updated;
        });
      }
      persistDurableApprovalRecordRef.current(nextTask);
      if (nextTask.status === "completed") {
        persistWorkspaceForTaskRef.current(
          nextTask.status,
          getCompletedTaskWorkspacePath(nextTask) || workspacePathRef.current,
        );
        setIsTaskActive(false);
        setActiveScheduledTaskId(undefined);
        setScheduledTasks((current) => {
          const now = new Date().toISOString();
          const updated = current.map((t) =>
            t.lastRunStartedAt
              ? { ...t, lastRunAt: now, lastRunStartedAt: undefined }
              : t,
          );
          const repository = scheduledTasksRepoRef.current;
          if (repository) {
            void repository.save(updated);
          }
          return updated;
        });
      }
      if (nextTask.status === "failed" || nextTask.status === "cancelled") {
        setIsTaskActive(false);
        setActiveScheduledTaskId(undefined);
        setScheduledTasks((current) => {
          const now = new Date().toISOString();
          const updated = current.map((t) =>
            t.lastRunStartedAt
              ? { ...t, lastRunAt: now, lastRunStartedAt: undefined }
              : t,
          );
          const repository = scheduledTasksRepoRef.current;
          if (repository) {
            void repository.save(updated);
          }
          return updated;
        });
      }
    });

    return () => {
      clearQueuedTaskSnapshots();
      unsubscribe();
      // NOTE: Do NOT call runtime.dispose() here — it irreversibly
      // unregisters the eventBus handler, which breaks streaming.
      // React StrictMode double-invokes effects, so the cleanup runs
      // between mount/unmount, leaving the eventBus bridge broken.
    };
  }, [
    runtime,
    scheduledTasksRepoRef,
    setActiveHistoryEntryId,
    setHistory,
    setScheduledTasks,
    taskHistoryRepoRef,
    workspacePathRef,
  ]);

  return {
    task,
    setTask,
    isTaskActive,
    setIsTaskActive,
    isTaskActiveRef,
    activeScheduledTaskId,
    setActiveScheduledTaskId,
    pendingScheduledTaskIdRef,
    clearQueuedTaskSnapshots,
    enqueueTaskSnapshot,
  };
}

function isStreamingTaskSnapshot(task: TaskSnapshot): boolean {
  return Boolean(task.isStreaming || task.streamingText);
}
