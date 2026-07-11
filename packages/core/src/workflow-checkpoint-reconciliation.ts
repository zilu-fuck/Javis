import type { RuntimeEventEnvelope } from "./runtime-event-envelope";
import { extractEventKind, extractStepId } from "./runtime-event-envelope";
import type { WorkflowResumeState } from "./workflow-dag-executor";
import type { WorkflowCheckpoint } from "./workflow-checkpoint";

export type CheckpointReconciliationStatus =
  | "resumable"
  | "rebuild_required"
  | "blocked";

export interface CheckpointReconciliationResult {
  status: CheckpointReconciliationStatus;
  checkpoint: WorkflowCheckpoint;
  reason: string;
  latestEventSequence: number;
  completedStepIds: string[];
  retryStepIds: string[];
  pendingStepIds: string[];
  approvalRequestIds: string[];
  mismatchedStepIds: string[];
}

export type WorkflowResumeStateBuildResult =
  | {
      status: "ready";
      source: "checkpoint" | "event-log";
      resumeState: WorkflowResumeState;
    }
  | {
      status: "blocked";
      reason: string;
      reconciliation: CheckpointReconciliationResult;
    };

export function reconcileCheckpointWithEventLog(
  checkpoint: WorkflowCheckpoint,
  events: RuntimeEventEnvelope[],
): CheckpointReconciliationResult {
  const base = createBaseResult(checkpoint, events);
  if (events.length === 0) {
    return checkpoint.eventSequence === 0
      ? {
          ...base,
          status: "resumable",
          reason: "Checkpoint has no required event coverage.",
        }
      : {
          ...base,
          status: "blocked",
          reason: "Event log is empty and cannot validate the checkpoint sequence.",
        };
  }

  const conflictingEvent = events.find(
    (event) => event.taskId !== checkpoint.taskId || event.runId !== checkpoint.runId,
  );
  if (conflictingEvent) {
    return {
      ...base,
      status: "blocked",
      reason: "Event log contains entries for a different task or run.",
    };
  }

  const latestEventSequence = latestSequence(events);
  if (latestEventSequence < checkpoint.eventSequence) {
    return {
      ...base,
      status: "blocked",
      latestEventSequence,
      reason: "Event log does not cover the checkpoint sequence.",
    };
  }

  const eventState = deriveEventState(events);
  const unsafeRunningWriteStepIds = findUnsafeRunningWriteStepIds(checkpoint, eventState);
  if (unsafeRunningWriteStepIds.length > 0) {
    return {
      ...base,
      status: "blocked",
      latestEventSequence,
      reason:
        "Checkpoint has running confirmed-write step(s) that require explicit reconciliation before resume.",
      retryStepIds: checkpoint.runningStepIds.filter(
        (stepId) => !unsafeRunningWriteStepIds.includes(stepId),
      ),
    };
  }
  const mismatchedStepIds = findMismatchedStepIds(checkpoint, eventState);
  if (mismatchedStepIds.length > 0) {
    return {
      ...base,
      status: "rebuild_required",
      latestEventSequence,
      reason: "Checkpoint step state conflicts with the event log.",
      completedStepIds: [...eventState.completedStepIds],
      retryStepIds: [...eventState.retryStepIds],
      pendingStepIds: checkpoint.pendingStepIds.filter((stepId) => !eventState.completedStepIds.includes(stepId)),
      approvalRequestIds: mergeUnique(checkpoint.approvalRequestIds, eventState.approvalRequestIds),
      mismatchedStepIds,
    };
  }

  return {
    ...base,
    status: "resumable",
    latestEventSequence,
    reason: "Checkpoint is consistent with the event log.",
    approvalRequestIds: mergeUnique(checkpoint.approvalRequestIds, eventState.approvalRequestIds),
  };
}

function findUnsafeRunningWriteStepIds(
  checkpoint: WorkflowCheckpoint,
  eventState: ReturnType<typeof deriveEventState>,
): string[] {
  const completed = new Set(eventState.completedStepIds);
  return checkpoint.runningStepIds.filter((stepId) => {
    if (completed.has(stepId)) {
      return false;
    }
    const step = checkpoint.workflowSnapshot.steps.find((candidate) => candidate.id === stepId);
    return step?.permissionLevel === "confirmed_write" || step?.permissionLevel === "dangerous";
  });
}

export function createWorkflowResumeStateFromReconciliation(
  reconciliation: CheckpointReconciliationResult,
): WorkflowResumeStateBuildResult {
  if (reconciliation.status === "rebuild_required") {
    return {
      status: "ready",
      source: "event-log",
      resumeState: {
        completedStepIds: reconciliation.completedStepIds,
        abandonedStepIds: reconciliation.checkpoint.abandonedStepIds,
        retryStepIds: reconciliation.retryStepIds,
        contextSnapshot: checkpointContextSnapshot(reconciliation.checkpoint.contextSnapshot),
      },
    };
  }

  if (reconciliation.status !== "resumable") {
    return {
      status: "blocked",
      reason: reconciliation.reason,
      reconciliation,
    };
  }

  return {
    status: "ready",
    source: "checkpoint",
    resumeState: {
      completedStepIds: reconciliation.completedStepIds,
      abandonedStepIds: reconciliation.checkpoint.abandonedStepIds,
      retryStepIds: reconciliation.retryStepIds,
      contextSnapshot: checkpointContextSnapshot(reconciliation.checkpoint.contextSnapshot),
    },
  };
}

function createBaseResult(
  checkpoint: WorkflowCheckpoint,
  events: RuntimeEventEnvelope[],
): CheckpointReconciliationResult {
  return {
    status: "blocked",
    checkpoint,
    reason: "Checkpoint has not been reconciled.",
    latestEventSequence: latestSequence(events),
    completedStepIds: [...checkpoint.completedStepIds],
    retryStepIds: [...checkpoint.runningStepIds],
    pendingStepIds: [...checkpoint.pendingStepIds],
    approvalRequestIds: [...checkpoint.approvalRequestIds],
    mismatchedStepIds: [],
  };
}

function checkpointContextSnapshot(
  contextSnapshot: WorkflowCheckpoint["contextSnapshot"],
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [key, envelope] of Object.entries(contextSnapshot)) {
    context[key] = envelope;
  }
  return context;
}

function deriveEventState(events: RuntimeEventEnvelope[]): {
  completedStepIds: string[];
  failedStepIds: string[];
  retryStepIds: string[];
  approvalRequestIds: string[];
} {
  const completedStepIds = new Set<string>();
  const failedStepIds = new Set<string>();
  const retryStepIds = new Set<string>();
  const approvalRequestIds = new Set<string>();

  for (const event of events) {
    const kind = extractEventKind(event);
    const stepId = extractStepId(event);
    if (kind === "step.completed" && stepId) {
      completedStepIds.add(stepId);
      retryStepIds.delete(stepId);
      failedStepIds.delete(stepId);
    } else if (kind === "step.failed" && stepId) {
      failedStepIds.add(stepId);
      completedStepIds.delete(stepId);
      retryStepIds.add(stepId);
    } else if (kind === "step.started" && stepId && !completedStepIds.has(stepId)) {
      retryStepIds.add(stepId);
    } else if (kind === "permission.requested" || kind === "permission.resolved") {
      const approvalId = permissionRequestIdFromEvent(event);
      if (approvalId) {
        approvalRequestIds.add(approvalId);
      }
    }
  }

  return {
    completedStepIds: [...completedStepIds],
    failedStepIds: [...failedStepIds],
    retryStepIds: [...retryStepIds],
    approvalRequestIds: [...approvalRequestIds],
  };
}

function findMismatchedStepIds(
  checkpoint: WorkflowCheckpoint,
  eventState: ReturnType<typeof deriveEventState>,
): string[] {
  const mismatches = new Set<string>();
  for (const stepId of checkpoint.completedStepIds) {
    if (
      eventState.failedStepIds.includes(stepId) ||
      !eventState.completedStepIds.includes(stepId)
    ) {
      mismatches.add(stepId);
    }
  }
  for (const stepId of eventState.completedStepIds) {
    if (checkpoint.abandonedStepIds.includes(stepId)) {
      mismatches.add(stepId);
    }
  }
  return [...mismatches].sort();
}

function permissionRequestIdFromEvent(event: RuntimeEventEnvelope): string | undefined {
  const payload = event.payload;
  if (!isRecord(payload)) {
    return undefined;
  }
  if (typeof payload.approvalId === "string") {
    return payload.approvalId;
  }
  if (typeof payload.requestId === "string") {
    return payload.requestId;
  }
  const request = payload.request;
  if (!isRecord(request) || typeof request.id !== "string") {
    return undefined;
  }
  return request.id;
}

function latestSequence(events: RuntimeEventEnvelope[]): number {
  if (events.length === 0) {
    return 0;
  }
  return Math.max(...events.map((event) => event.sequence));
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
