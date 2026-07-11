import {
  createArtifactEnvelope,
  type RuntimeEventEnvelope,
  type TaskSnapshot,
  type WorkflowCheckpoint,
} from "@javis/core";
import type { DurableApprovalRecord } from "./approval-records";

export interface RestoredApprovalResumeSeed {
  checkpoint: WorkflowCheckpoint;
  events: RuntimeEventEnvelope[];
}

export interface RestoredApprovalResumeStartRequest {
  userGoal: string;
  options: {
    taskId: string;
    mode: "project";
    originMode: "project";
    workspacePath: string;
    appendUserMessage: false;
    resumeFromCheckpoint: RestoredApprovalResumeSeed;
  };
}

export function createRestoredApprovalResumeStore() {
  const seeds = new Map<string, RestoredApprovalResumeSeed>();
  const loading = new Map<string, Promise<void>>();
  return {
    setLoading(approvalId: string, promise: Promise<void>): void {
      loading.set(approvalId, promise);
      const clear = () => {
        if (loading.get(approvalId) === promise) {
          loading.delete(approvalId);
        }
      };
      void promise.then(clear, clear);
    },
    async waitUntilReady(approvalId: string): Promise<void> {
      await loading.get(approvalId);
    },
    set(approvalId: string, seed: RestoredApprovalResumeSeed): void {
      seeds.set(approvalId, seed);
    },
    delete(approvalId: string): void {
      seeds.delete(approvalId);
    },
    get(approvalId: string): RestoredApprovalResumeSeed | undefined {
      return seeds.get(approvalId);
    },
    consume(approvalId: string): RestoredApprovalResumeSeed | undefined {
      const seed = seeds.get(approvalId);
      seeds.delete(approvalId);
      return seed;
    },
  };
}

export function buildRestoredApprovalResumeStartRequest(
  record: DurableApprovalRecord,
  seed: RestoredApprovalResumeSeed,
  fallbackGoal: string,
): RestoredApprovalResumeStartRequest {
  return {
    userGoal: seed.checkpoint.workflowSnapshot.goal || fallbackGoal,
    options: {
      taskId: record.taskId,
      mode: "project",
      originMode: "project",
      workspacePath: record.workspacePath,
      appendUserMessage: false,
      resumeFromCheckpoint: seed,
    },
  };
}

export function buildRestoredApprovalDurableResumeMetadata(
  seed: RestoredApprovalResumeSeed,
): NonNullable<TaskSnapshot["durableResume"]> {
  return {
    runId: seed.checkpoint.runId,
    source: "checkpoint",
    checkpointEventSequence: seed.checkpoint.eventSequence,
    latestEventSequence: latestEventSequence(seed),
    completedStepIds: seed.checkpoint.completedStepIds,
    retryStepIds: [...seed.checkpoint.runningStepIds, ...seed.checkpoint.pendingStepIds],
    approvalRequestIds: seed.checkpoint.approvalRequestIds,
    rebuilt: false,
  };
}

export function attachRestoredApprovalDurableResume(
  task: TaskSnapshot,
  seed: RestoredApprovalResumeSeed | undefined,
): TaskSnapshot {
  if (!seed) {
    return task;
  }
  return {
    ...task,
    runId: seed.checkpoint.runId,
    durableResume: buildRestoredApprovalDurableResumeMetadata(seed),
  };
}

export function advanceRestoredApprovalResumeSeed(
  record: DurableApprovalRecord,
  seed: RestoredApprovalResumeSeed,
  approvalStepOutput: unknown,
): RestoredApprovalResumeSeed | undefined {
  if (!seed.checkpoint.approvalRequestIds.includes(record.approvalId)) {
    return undefined;
  }
  if (seed.checkpoint.runningStepIds.length !== 1) {
    return undefined;
  }

  const approvedStepId = seed.checkpoint.runningStepIds[0];
  const approvedStep = seed.checkpoint.workflowSnapshot.steps.find(
    (step) => step.id === approvedStepId,
  );
  if (!approvedStep) {
    return undefined;
  }

  const output = approvalStepOutput ?? {
    approvalId: record.approvalId,
    status: "approved",
    toolName: record.toolName,
  };
  const outputKey = approvedStep.outputContextKey ?? `step:${approvedStepId}`;
  const outputEnvelope = createArtifactEnvelope(output, {
    taskId: seed.checkpoint.taskId,
    runId: seed.checkpoint.runId,
    type: outputKey,
    producer: {
      stepId: approvedStepId,
      agentKind: approvedStep.agentKind,
      toolName: record.toolName,
    },
    sensitivity: "workspace",
  });
  const stepEnvelope = outputKey === `step:${approvedStepId}`
    ? outputEnvelope
    : createArtifactEnvelope(output, {
      taskId: seed.checkpoint.taskId,
      runId: seed.checkpoint.runId,
      type: `step:${approvedStepId}`,
      producer: {
        stepId: approvedStepId,
        agentKind: approvedStep.agentKind,
        toolName: record.toolName,
      },
      sensitivity: "workspace",
    });
  const nextEvents = appendApprovalResumeEvents({
    seed,
    record,
    approvedStepId,
    agentKind: approvedStep.agentKind,
  });
  const eventSequence = latestEventSequence(nextEvents);

  return {
    ...seed,
    events: nextEvents,
    checkpoint: {
      ...seed.checkpoint,
      completedStepIds: uniqueIds([...seed.checkpoint.completedStepIds, approvedStepId]),
      pendingStepIds: seed.checkpoint.pendingStepIds.filter((id) => id !== approvedStepId),
      runningStepIds: seed.checkpoint.runningStepIds.filter((id) => id !== approvedStepId),
      contextSnapshot: {
        ...seed.checkpoint.contextSnapshot,
        [outputKey]: outputEnvelope,
        [`step:${approvedStepId}`]: stepEnvelope,
      },
      waitingReason: undefined,
      eventSequence,
    },
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function appendApprovalResumeEvents(input: {
  seed: RestoredApprovalResumeSeed;
  record: DurableApprovalRecord;
  approvedStepId: string;
  agentKind: string;
}): RuntimeEventEnvelope[] {
  const firstSequence = latestEventSequence(input.seed) + 1;
  const resolvedAt = input.record.resolvedAt ?? new Date().toISOString();
  return [
    ...input.seed.events,
    createResumeEnvelope(input.seed, firstSequence, {
      kind: "permission.resolved",
      taskId: input.seed.checkpoint.taskId,
      requestId: input.record.approvalId,
      decision: input.record.decision ?? "approved",
    }, resolvedAt),
    createResumeEnvelope(input.seed, firstSequence + 1, {
      kind: "step.completed",
      taskId: input.seed.checkpoint.taskId,
      stepId: input.approvedStepId,
      summary: `Restored approval ${input.record.approvalId} completed ${input.record.toolName}.`,
      agentKind: input.agentKind,
    }, resolvedAt, input.approvedStepId, input.agentKind),
  ];
}

function createResumeEnvelope(
  seed: RestoredApprovalResumeSeed,
  sequence: number,
  payload: Record<string, unknown>,
  occurredAt: string,
  stepId?: string,
  agentId?: string,
): RuntimeEventEnvelope {
  return {
    eventId: `evt-${seed.checkpoint.runId}-restored-approval-${sequence}`,
    eventVersion: 1,
    sequence,
    taskId: seed.checkpoint.taskId,
    runId: seed.checkpoint.runId,
    workflowId: seed.checkpoint.workflowId,
    ...(stepId ? { stepId } : {}),
    ...(agentId ? { agentId: `agent-${agentId}` } : {}),
    correlationId: seed.checkpoint.runId,
    occurredAt,
    recordedAt: new Date().toISOString(),
    payload,
  };
}

function latestEventSequence(seedOrEvents: RestoredApprovalResumeSeed | RuntimeEventEnvelope[]): number {
  if (Array.isArray(seedOrEvents)) {
    return seedOrEvents.reduce((latest, event) => Math.max(latest, event.sequence), 0);
  }
  return Math.max(
    seedOrEvents.checkpoint.eventSequence,
    latestEventSequence(seedOrEvents.events),
  );
}
