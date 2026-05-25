import type { ISODateTime, TaskSnapshot, TaskStatus } from "../index";

export const TASK_STATUSES = [
  "created",
  "planning",
  "running",
  "waiting_permission",
  "verifying",
  "retrying",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskStatus[];

export const DOCUMENTED_TASK_TRANSITIONS = [
  {
    from: "created",
    to: "planning",
    reason: "A newly created task starts by building a plan.",
  },
  {
    from: "planning",
    to: "running",
    reason: "Planned work moves into the active task flow.",
  },
  {
    from: "running",
    to: "waiting_permission",
    reason: "Confirmed writes pause active work for user approval.",
  },
  {
    from: "waiting_permission",
    to: "running",
    reason: "Approved writes resume active work before verification.",
  },
  {
    from: "running",
    to: "verifying",
    reason: "Read and write flows verify results before completion.",
  },
  {
    from: "verifying",
    to: "completed",
    reason: "Successful verification completes the task.",
  },
  {
    from: "running",
    to: "completed",
    reason: "Some no-op or denied-write flows complete without a verification phase.",
  },
  {
    from: "waiting_permission",
    to: "completed",
    reason: "Denied writes complete safely without executing the write.",
  },
  {
    from: "waiting_permission",
    to: "failed",
    reason: "Restored approval execution can fail after permission resumes.",
  },
  {
    from: "running",
    to: "failed",
    reason: "Runtime, tool, or route failures fail active work.",
  },
  {
    from: "verifying",
    to: "failed",
    reason: "Verification failures fail the task.",
  },
] as const satisfies ReadonlyArray<{
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}>;

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export interface TaskTransitionDetails {
  updatedAt?: ISODateTime;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function transitionTask(
  snapshot: TaskSnapshot,
  nextStatus: TaskStatus,
  details: TaskTransitionDetails = {},
): TaskSnapshot {
  if (isTerminalTaskStatus(snapshot.status) && snapshot.status !== nextStatus) {
    throw new Error(
      `Cannot transition terminal task ${snapshot.id} from ${snapshot.status} to ${nextStatus}.`,
    );
  }

  return {
    ...snapshot,
    status: nextStatus,
    ...(details.updatedAt === undefined ? {} : { updatedAt: details.updatedAt }),
  };
}
