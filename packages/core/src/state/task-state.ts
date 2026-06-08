import type { ISODateTime, TaskSnapshot, TaskStatus } from "../index";

export const TASK_STATUSES = [
  "created",
  "planning",
  "waiting_info",
  "waiting_permission",
  "running",
  "generating",
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
    to: "waiting_info",
    reason: "A plan can pause for missing user information before execution.",
  },
  {
    from: "waiting_info",
    to: "planning",
    reason: "User clarification resumes planning.",
  },
  {
    from: "waiting_info",
    to: "running",
    reason: "User clarification can directly resume active work.",
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
    to: "generating",
    reason: "Executed work moves into final response generation.",
  },
  {
    from: "generating",
    to: "completed",
    reason: "Successful final response generation completes the task.",
  },
  {
    from: "generating",
    to: "failed",
    reason: "Final response generation can fail after execution.",
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

/**
 * Progress percentage per task status.
 * Used by the UI to show meaningful progress instead of always showing 0%.
 */
export const TASK_STATUS_PROGRESS: Record<TaskStatus, number> = {
  created: 10,
  planning: 20,
  waiting_info: 35,
  waiting_permission: 40,
  running: 50,
  generating: 75,
  verifying: 75,
  retrying: 45,
  completed: 100,
  failed: 100,
  cancelled: 100,
};

export function getTaskProgress(status: TaskStatus): number {
  return TASK_STATUS_PROGRESS[status] ?? 0;
}

export interface TaskTransitionDetails {
  updatedAt?: ISODateTime;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

const LEGAL_TASK_TRANSITION_KEYS = new Set(
  DOCUMENTED_TASK_TRANSITIONS.map((transition) => `${transition.from}->${transition.to}`),
);

export function isLegalTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || LEGAL_TASK_TRANSITION_KEYS.has(`${from}->${to}`);
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
  if (!isLegalTaskTransition(snapshot.status, nextStatus)) {
    console.warn(
      `[Javis] Undocumented task transition ${snapshot.id}: ${snapshot.status} -> ${nextStatus}`,
    );
  }

  return {
    ...snapshot,
    status: nextStatus,
    ...(details.updatedAt === undefined ? {} : { updatedAt: details.updatedAt }),
  };
}
