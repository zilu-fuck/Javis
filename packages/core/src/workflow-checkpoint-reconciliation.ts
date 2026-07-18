import type { RuntimeEventEnvelope } from "./runtime-event-envelope";
import { extractEventKind, extractStepId, isStreamingEvent } from "./runtime-event-envelope";
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
  replanAttemptCount: number;
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
  const checkpointStateError = validateCheckpointStepPartition(checkpoint);
  if (checkpointStateError) {
    return {
      ...base,
      status: "blocked",
      reason: checkpointStateError,
    };
  }
  const eventState = deriveEventState(events);
  if (events.length === 0) {
    const incompleteArtifactResult = reconcileIncompleteArtifactState(
      checkpoint,
      eventState,
      base,
      0,
    );
    if (incompleteArtifactResult) return incompleteArtifactResult;
    const unsafeRunningWriteStepIds = findUnsafeRunningWriteStepIds(checkpoint, eventState);
    if (unsafeRunningWriteStepIds.length > 0) {
      return {
        ...base,
        status: "blocked",
        reason:
          "Checkpoint has running confirmed-write step(s) that cannot be reconciled without an event log.",
        retryStepIds: checkpoint.runningStepIds.filter(
          (stepId) => !unsafeRunningWriteStepIds.includes(stepId),
        ),
      };
    }
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
    (event) => event.taskId !== checkpoint.taskId ||
      event.runId !== checkpoint.runId ||
      event.workflowId !== checkpoint.workflowId,
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

  const sequenceError = validateEventSequenceCoverage(events);
  if (sequenceError) {
    return {
      ...base,
      status: "blocked",
      latestEventSequence,
      reason: sequenceError,
    };
  }

  const unsafeRunningWriteStepIds = findUnsafeRunningWriteStepIds(checkpoint, eventState);
  if (unsafeRunningWriteStepIds.length > 0) {
    return {
      ...base,
      status: "blocked",
      latestEventSequence,
      reason:
        "Checkpoint has running confirmed-write step(s) that require explicit reconciliation before resume.",
      retryStepIds: mergeRetryStepIds(checkpoint.runningStepIds, eventState.retryStepIds)
        .filter((stepId) => !checkpoint.abandonedStepIds.includes(stepId))
        .filter((stepId) => !unsafeRunningWriteStepIds.includes(stepId)),
    };
  }
  const incompleteArtifactResult = reconcileIncompleteArtifactState(
    checkpoint,
    eventState,
    base,
    latestEventSequence,
  );
  if (incompleteArtifactResult) return incompleteArtifactResult;
  const mismatchedStepIds = findMismatchedStepIds(checkpoint, eventState);
  if (mismatchedStepIds.length > 0) {
    return {
      ...base,
      status: "rebuild_required",
      latestEventSequence,
      reason: "Checkpoint step state conflicts with the event log.",
      completedStepIds: [...eventState.completedStepIds],
      retryStepIds: eventState.retryStepIds.filter(
        (stepId) => !checkpoint.abandonedStepIds.includes(stepId),
      ),
      pendingStepIds: checkpoint.pendingStepIds.filter((stepId) =>
        !eventState.completedStepIds.includes(stepId) && !eventState.retryStepIds.includes(stepId),
      ),
      approvalRequestIds: mergeUnique(checkpoint.approvalRequestIds, eventState.approvalRequestIds),
      mismatchedStepIds,
      replanAttemptCount: eventState.replanAttemptCount,
    };
  }

  return {
    ...base,
    status: "resumable",
    latestEventSequence,
    reason: "Checkpoint is consistent with the event log.",
    completedStepIds: mergeUnique(checkpoint.completedStepIds, eventState.completedStepIds),
    retryStepIds: mergeRetryStepIds(checkpoint.runningStepIds, eventState.retryStepIds)
      .filter((stepId) => !checkpoint.abandonedStepIds.includes(stepId)),
    pendingStepIds: checkpoint.pendingStepIds.filter((stepId) =>
      !eventState.completedStepIds.includes(stepId) && !eventState.retryStepIds.includes(stepId),
    ),
    approvalRequestIds: mergeUnique(checkpoint.approvalRequestIds, eventState.approvalRequestIds),
    replanAttemptCount: eventState.replanAttemptCount,
  };
}

function findUnsafeRunningWriteStepIds(
  checkpoint: WorkflowCheckpoint,
  eventState: ReturnType<typeof deriveEventState>,
): string[] {
  const completed = new Set(eventState.completedStepIds);
  const inFlightStepIds = new Set([
    ...checkpoint.runningStepIds,
    ...eventState.retryStepIds,
  ]);
  return [...inFlightStepIds].filter((stepId) => {
    if (completed.has(stepId)) {
      return false;
    }
    const step = checkpoint.workflowSnapshot.steps.find((candidate) => candidate.id === stepId);
    return step?.permissionLevel === "confirmed_write" || step?.permissionLevel === "dangerous";
  });
}

function reconcileIncompleteArtifactState(
  checkpoint: WorkflowCheckpoint,
  eventState: ReturnType<typeof deriveEventState>,
  base: CheckpointReconciliationResult,
  latestEventSequence: number,
): CheckpointReconciliationResult | undefined {
  const completedStepIds = mergeUnique(checkpoint.completedStepIds, eventState.completedStepIds);
  const affectedStepIds = findIncompleteArtifactAffectedStepIds(checkpoint, completedStepIds);
  if (affectedStepIds.length === 0) return undefined;

  const unsafeStepIds = affectedStepIds.filter((stepId) => {
    const step = checkpoint.workflowSnapshot.steps.find((candidate) => candidate.id === stepId);
    return step?.permissionLevel === "confirmed_write" || step?.permissionLevel === "dangerous";
  });
  if (unsafeStepIds.length > 0) {
    return {
      ...base,
      status: "blocked",
      latestEventSequence,
      reason:
        "Checkpoint persistence removed artifact data required by a completed write step; automatic replay is unsafe.",
      retryStepIds: mergeRetryStepIds(checkpoint.runningStepIds, eventState.retryStepIds)
        .filter((stepId) => !checkpoint.abandonedStepIds.includes(stepId))
        .filter((stepId) => !unsafeStepIds.includes(stepId)),
      mismatchedStepIds: affectedStepIds,
      replanAttemptCount: eventState.replanAttemptCount,
    };
  }

  const affected = new Set(affectedStepIds);
  return {
    ...base,
    status: "rebuild_required",
    latestEventSequence,
    reason:
      "Checkpoint persistence removed or truncated artifact data; affected read steps must be replayed.",
    completedStepIds: completedStepIds.filter((stepId) => !affected.has(stepId)),
    retryStepIds: mergeRetryStepIds(
      mergeRetryStepIds(checkpoint.runningStepIds, eventState.retryStepIds),
      affectedStepIds,
    ).filter((stepId) => !checkpoint.abandonedStepIds.includes(stepId)),
    pendingStepIds: checkpoint.pendingStepIds.filter((stepId) => !affected.has(stepId)),
    approvalRequestIds: mergeUnique(checkpoint.approvalRequestIds, eventState.approvalRequestIds),
    mismatchedStepIds: affectedStepIds,
    replanAttemptCount: eventState.replanAttemptCount,
  };
}

function findIncompleteArtifactAffectedStepIds(
  checkpoint: WorkflowCheckpoint,
  completedStepIds: string[],
): string[] {
  const completed = new Set(completedStepIds);
  const affected = new Set<string>();
  const incompleteContextKeys = new Set<string>();
  for (const [key, envelope] of Object.entries(checkpoint.contextSnapshot)) {
    if (!envelope.sourceContentHash) continue;
    incompleteContextKeys.add(key);
    if (completed.has(envelope.producer.stepId)) {
      affected.add(envelope.producer.stepId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of checkpoint.workflowSnapshot.steps) {
      if (!completed.has(step.id) || affected.has(step.id)) continue;
      if (
        step.dependsOn.some((stepId) => affected.has(stepId)) ||
        step.inputContextKeys?.some((key) => incompleteContextKeys.has(key))
      ) {
        affected.add(step.id);
        changed = true;
      }
    }
  }
  return [...affected].sort();
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
    replanAttemptCount: 0,
  };
}

function checkpointContextSnapshot(
  contextSnapshot: WorkflowCheckpoint["contextSnapshot"],
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [key, envelope] of Object.entries(contextSnapshot)) {
    if (envelope.sourceContentHash) continue;
    context[key] = envelope;
  }
  return context;
}

function deriveEventState(events: RuntimeEventEnvelope[]): {
  completedStepIds: string[];
  failedStepIds: string[];
  retryStepIds: string[];
  approvalRequestIds: string[];
  replanAttemptCount: number;
} {
  const completedStepIds = new Set<string>();
  const failedStepIds = new Set<string>();
  const retryStepIds = new Set<string>();
  const approvalRequestIds = new Set<string>();
  let replanAttemptCount = 0;

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
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
    } else if (kind === "step.started" && stepId) {
      completedStepIds.delete(stepId);
      failedStepIds.delete(stepId);
      retryStepIds.add(stepId);
    } else if (kind === "permission.requested" || kind === "permission.resolved") {
      const approvalId = permissionRequestIdFromEvent(event);
      if (approvalId) {
        approvalRequestIds.add(approvalId);
      }
    } else if (kind === "task.replan_started") {
      replanAttemptCount += 1;
    }
  }

  return {
    completedStepIds: [...completedStepIds],
    failedStepIds: [...failedStepIds],
    retryStepIds: [...retryStepIds],
    approvalRequestIds: [...approvalRequestIds],
    replanAttemptCount,
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

function mergeRetryStepIds(left: string[], right: string[]): string[] {
  return mergeUnique(left, right);
}

function validateCheckpointStepPartition(checkpoint: WorkflowCheckpoint): string | undefined {
  const workflowStepIds = checkpoint.workflowSnapshot.steps.map((step) => step.id);
  const knownStepIds = new Set(workflowStepIds);
  if (knownStepIds.size !== workflowStepIds.length) {
    return "Checkpoint workflow contains duplicate step ids.";
  }

  const seenState = new Map<string, string>();
  const groups: Array<[string, string[]]> = [
    ["completed", checkpoint.completedStepIds],
    ["abandoned", checkpoint.abandonedStepIds],
    ["pending", checkpoint.pendingStepIds],
    ["running", checkpoint.runningStepIds],
  ];
  for (const [state, stepIds] of groups) {
    const withinState = new Set<string>();
    for (const stepId of stepIds) {
      if (!knownStepIds.has(stepId)) {
        return `Checkpoint ${state} state references unknown step ${stepId}.`;
      }
      if (withinState.has(stepId)) {
        return `Checkpoint ${state} state contains duplicate step ${stepId}.`;
      }
      withinState.add(stepId);
      const previousState = seenState.get(stepId);
      if (previousState) {
        return `Checkpoint step ${stepId} appears in both ${previousState} and ${state} state.`;
      }
      seenState.set(stepId, state);
    }
  }

  const missingStepIds = workflowStepIds.filter((stepId) => !seenState.has(stepId));
  if (missingStepIds.length > 0) {
    return `Checkpoint omits state for workflow step(s): ${missingStepIds.join(", ")}.`;
  }
  return undefined;
}

/** Validate contiguous event coverage while allowing explicit stream compaction ranges. */
function validateEventSequenceCoverage(events: RuntimeEventEnvelope[]): string | undefined {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const bySequence = new Map<number, RuntimeEventEnvelope>();
  for (const event of ordered) {
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
      return "Event log contains an invalid sequence number.";
    }
    if (bySequence.has(event.sequence)) {
      return `Event log contains duplicate sequence ${event.sequence}.`;
    }
    bySequence.set(event.sequence, event);
  }

  const covered = new Set<number>(bySequence.keys());
  for (const event of ordered) {
    const payload = event.payload;
    if (!isCompactedStreamPayload(payload)) continue;
    const { first, last } = payload.originalSequenceRange;
    if (event.sequence <= last) {
      return "Compacted event sequence must be after its original sequence range.";
    }
    const presentOriginalEvents = ordered.filter((candidate) =>
      candidate.sequence >= first && candidate.sequence <= last,
    );
    if (presentOriginalEvents.some((candidate) => isStreamingEvent(extractEventKind(candidate)))) {
      return "Compacted range still contains streaming events.";
    }
    const missingCount = last - first + 1 - presentOriginalEvents.length;
    if (missingCount !== payload.compactedEventCount) {
      return "Compacted event range does not account for the declared streaming event count.";
    }
    for (let sequence = first; sequence <= last; sequence += 1) {
      covered.add(sequence);
    }
  }

  const latest = latestSequence(ordered);
  for (let sequence = 1; sequence <= latest; sequence += 1) {
    if (!covered.has(sequence)) {
      return `Event log has a sequence gap at ${sequence}.`;
    }
  }
  return undefined;
}

function isCompactedStreamPayload(value: unknown): value is {
  kind: "runtime.compacted";
  compactedEventCount: number;
  originalSequenceRange: { first: number; last: number };
} {
  if (!isRecord(value) || value.kind !== "runtime.compacted") return false;
  const range = value.originalSequenceRange;
  const compactedEventCount = value.compactedEventCount;
  if (typeof compactedEventCount !== "number" || !Number.isInteger(compactedEventCount) || compactedEventCount <= 0) {
    return false;
  }
  if (!isRecord(range)) return false;
  const first = range.first;
  const last = range.last;
  return typeof first === "number" && Number.isInteger(first) &&
    typeof last === "number" && Number.isInteger(last) &&
    first >= 1 && last >= first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
