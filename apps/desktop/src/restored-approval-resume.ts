import {
  createArtifactEnvelope,
  type RuntimeEventEnvelope,
  type TaskSnapshot,
  type WorkflowCheckpoint,
} from "@javis/core";
import {
  markApprovalContinuationPending,
  markApprovalExecutionStarted,
  markApprovalExecutionSucceeded,
  markApprovalExecutionTerminal,
  sanitizeApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";

export interface RestoredApprovalResumeSeed {
  checkpoint: WorkflowCheckpoint;
  events: RuntimeEventEnvelope[];
}

export class RestoredApprovalResumePersistenceError extends Error {
  readonly cause: unknown;
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to persist restored approval ${operation}: ${detail}`);
    this.name = "RestoredApprovalResumePersistenceError";
    this.operation = operation;
    this.cause = cause;
  }
}

export function isRestoredApprovalResumePersistenceError(
  error: unknown,
): error is RestoredApprovalResumePersistenceError {
  return error instanceof RestoredApprovalResumePersistenceError;
}

export async function persistRestoredApprovalResumeEvents(
  previousEvents: RuntimeEventEnvelope[],
  advancedEvents: RuntimeEventEnvelope[],
  sink: { appendBatch(events: RuntimeEventEnvelope[]): Promise<void> } | null | undefined,
): Promise<void> {
  const resumedEvents = advancedEvents.filter((candidate) =>
    !previousEvents.some((existing) => existing.eventId === candidate.eventId)
  );
  if (resumedEvents.length === 0) return;
  if (!sink) {
    throw new RestoredApprovalResumePersistenceError(
      "completion events",
      new Error("runtime event store is unavailable"),
    );
  }
  try {
    await sink.appendBatch(resumedEvents);
  } catch (error) {
    throw new RestoredApprovalResumePersistenceError("completion events", error);
  }
}

export async function persistRestoredApprovalResumeCheckpoint(
  checkpoint: WorkflowCheckpoint,
  sink: { save(checkpoint: WorkflowCheckpoint): Promise<void> } | null | undefined,
): Promise<void> {
  if (!sink) {
    throw new RestoredApprovalResumePersistenceError(
      "checkpoint",
      new Error("checkpoint store is unavailable"),
    );
  }
  try {
    await sink.save(checkpoint);
  } catch (error) {
    throw new RestoredApprovalResumePersistenceError("checkpoint", error);
  }
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
  const inFlight = new Set<string>();
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
    claim(approvalId: string): boolean {
      if (inFlight.has(approvalId)) return false;
      inFlight.add(approvalId);
      return true;
    },
    release(approvalId: string): void {
      inFlight.delete(approvalId);
    },
    isInFlight(approvalId: string): boolean {
      return inFlight.has(approvalId);
    },
  };
}

export type RestoredApprovalEventReconciliation =
  | {
      status: "continuation";
      record: DurableApprovalRecord;
      seed: RestoredApprovalResumeSeed;
    }
  | {
      status: "terminal";
      record: DurableApprovalRecord;
    }
  | {
      status: "blocked";
      reason: string;
    };

/**
 * Rebuilds execution state only from a complete run replay and its latest
 * checkpoint. Approval events created before the explicit step/tool/preview
 * binding contract are not eligible for automatic continuation: a resolved
 * record without complete binding evidence must remain fail-closed because
 * the native side effect may already have happened.
 */
export function reconcileApprovalExecutionFromEventLog(
  record: DurableApprovalRecord,
  checkpoint: WorkflowCheckpoint | undefined,
  runtimeEvents: RuntimeEventEnvelope[],
): RestoredApprovalEventReconciliation {
  if (!record.workflowBound || !record.runId || record.execution) {
    return { status: "blocked", reason: "The approval is not an unresolved workflow execution." };
  }
  if (!checkpoint ||
    checkpoint.taskId !== record.taskId ||
    checkpoint.runId !== record.runId
  ) {
    return { status: "blocked", reason: "The latest workflow checkpoint is missing or does not match the approval." };
  }
  if (runtimeEvents.length === 0) {
    return { status: "blocked", reason: "The complete workflow event replay is empty." };
  }

  const ordered = [...runtimeEvents].sort((left, right) => left.sequence - right.sequence);
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  for (const event of ordered) {
    if (event.taskId !== record.taskId || event.runId !== record.runId ||
      event.workflowId !== undefined && event.workflowId !== checkpoint.workflowId ||
      !Number.isInteger(event.sequence) || event.sequence < 1 ||
      eventIds.has(event.eventId) || sequences.has(event.sequence)
    ) {
      return { status: "blocked", reason: "The workflow event replay contains conflicting approval-run evidence." };
    }
    eventIds.add(event.eventId);
    sequences.add(event.sequence);
  }
  if ((ordered[ordered.length - 1]?.sequence ?? 0) < checkpoint.eventSequence) {
    return { status: "blocked", reason: "The workflow event replay does not cover the latest checkpoint sequence." };
  }
  const checkpointTerminalEvent = findLatestRuntimeEvent(ordered, (event) =>
    event.sequence >= checkpoint.eventSequence &&
    (eventKind(event) === "task.completed" || eventKind(event) === "task.failed")
  );
  const createTerminalBlockedRecord = (event: RuntimeEventEnvelope, detail: string): DurableApprovalRecord | null => {
    try {
      return sanitizeApprovalRecord(markApprovalExecutionTerminal(
        record,
        "blocked",
        detail,
        event.occurredAt,
      ));
    } catch {
      return null;
    }
  };

  const requestedEvent = findLatestRuntimeEvent(ordered, (event) =>
    permissionRequestIdFromEvent(event) === record.approvalId
  );
  const resolvedEvent = findLatestRuntimeEvent(ordered, (event) =>
    requestedEvent !== undefined && event.sequence > requestedEvent.sequence &&
    permissionResolvedIdFromEvent(event) === record.approvalId
  );
  const requestedBinding = requestedEvent ? approvalEventBinding(requestedEvent) : undefined;
  const resolvedBinding = resolvedEvent ? approvalEventBinding(resolvedEvent) : undefined;
  if (!requestedEvent || !resolvedEvent ||
    !requestedBinding || !resolvedBinding ||
    requestedBinding.stepId !== resolvedBinding.stepId ||
    requestedBinding.toolName !== record.toolName ||
    resolvedBinding.toolName !== record.toolName ||
    requestedBinding.previewHash !== record.previewHash ||
    resolvedBinding.previewHash !== record.previewHash
  ) {
    const terminalRecord = checkpointTerminalEvent
      ? createTerminalBlockedRecord(
          checkpointTerminalEvent,
          "The workflow is terminal, but the approval bindings are incomplete.",
        )
      : null;
    if (terminalRecord) return { status: "terminal", record: terminalRecord };
    return {
      status: "blocked",
      reason: "The permission events do not contain matching step, tool, and preview bindings.",
    };
  }
  const expectedDecision = record.decision ?? (record.status === "denied" ? "denied" : "approved");
  const resolvedDecision = permissionDecisionFromEvent(resolvedEvent);
  if (resolvedDecision !== expectedDecision) {
    return { status: "blocked", reason: "The durable permission decision conflicts with the approval record." };
  }

  const stepId = requestedBinding.stepId;
  const completedEvent = findLatestRuntimeEvent(ordered, (event) =>
    event.sequence > resolvedEvent.sequence &&
    eventKind(event) === "step.completed" &&
    eventStepId(event) === stepId
  );
  const terminalEvent = findLatestRuntimeEvent(ordered, (event) =>
    event.sequence > resolvedEvent.sequence &&
    (eventKind(event) === "task.completed" || eventKind(event) === "task.failed")
  );
  const step = checkpoint.workflowSnapshot.steps.find((candidate) => candidate.id === stepId);
  const stepToolName = (step as (typeof step & { toolName?: string }) | undefined)?.toolName;
  if (!step || stepToolName !== undefined && stepToolName !== record.toolName) {
    return { status: "blocked", reason: "The permission event binding does not match the checkpoint step." };
  }
  const outputKey = step.outputContextKey ?? `step:${step.id}`;
  const hasOutput = outputKey !== undefined &&
    Object.prototype.hasOwnProperty.call(checkpoint.contextSnapshot, outputKey);
  const outputArtifact = hasOutput && outputKey
    ? checkpoint.contextSnapshot[outputKey]
    : undefined;
  const output = isRecord(outputArtifact) && Object.prototype.hasOwnProperty.call(outputArtifact, "payload")
    ? outputArtifact.payload
    : outputArtifact;
  const outputProducer = isRecord(outputArtifact) && isRecord(outputArtifact.producer)
    ? outputArtifact.producer
    : undefined;
  const outputProvenanceMatches = Boolean(
    outputProducer &&
    outputProducer.stepId === stepId &&
    outputProducer.toolName === record.toolName,
  );
  const completionEvidenceIsBound = Boolean(
    completedEvent && hasOutput && outputProvenanceMatches &&
    checkpoint.completedStepIds.includes(step.id) &&
    (!terminalEvent || eventKind(terminalEvent) === "task.failed" || terminalEvent.sequence > completedEvent.sequence),
  );

  const waitingContext = { ...checkpoint.contextSnapshot };
  delete waitingContext[outputKey];
  delete waitingContext[`step:${stepId}`];
  const waitingCheckpoint: WorkflowCheckpoint = {
    ...checkpoint,
    completedStepIds: checkpoint.completedStepIds.filter((id) => id !== stepId),
    pendingStepIds: checkpoint.pendingStepIds.filter((id) => id !== stepId),
    runningStepIds: [stepId],
    contextSnapshot: waitingContext,
    approvalRequestIds: [...new Set([...checkpoint.approvalRequestIds, record.approvalId])],
    waitingReason: "human_approval",
    eventSequence: requestedEvent.sequence,
  };
  const waitingSeed: RestoredApprovalResumeSeed = {
    checkpoint: waitingCheckpoint,
    events: ordered.filter((event) => event.sequence <= requestedEvent.sequence),
  };

  if (terminalEvent && eventKind(terminalEvent) === "task.failed") {
    let failed: DurableApprovalRecord | null = null;
    try {
      failed = sanitizeApprovalRecord(markApprovalExecutionTerminal(
        markApprovalExecutionStarted(record, waitingSeed, requestedEvent.occurredAt),
        "failed",
        "The durable workflow event log records task.failed.",
        terminalEvent.occurredAt,
      ));
    } catch {
      failed = null;
    }
    return failed
      ? { status: "terminal", record: failed }
      : { status: "blocked", reason: "The terminal workflow evidence could not be persisted safely." };
  }

  if (!completionEvidenceIsBound || !completedEvent) {
    if (terminalEvent) {
      const terminalRecord = createTerminalBlockedRecord(
        terminalEvent,
        "The workflow is terminal, but the approved step completion evidence is incomplete.",
      );
      if (terminalRecord) return { status: "terminal", record: terminalRecord };
    }
    return {
      status: "blocked",
      reason: "The event log does not prove a matching permission resolution, step completion, and checkpoint output.",
    };
  }

  const seed: RestoredApprovalResumeSeed = { checkpoint, events: ordered };
  let candidate: DurableApprovalRecord | null = null;
  try {
    const started = markApprovalExecutionStarted(record, waitingSeed, requestedEvent.occurredAt);
    if (!sanitizeApprovalRecord(started)) {
      return { status: "blocked", reason: "The reconstructed execution intent failed durable validation." };
    }
    const succeeded = markApprovalExecutionSucceeded(started, output, completedEvent.occurredAt);
    if (!sanitizeApprovalRecord(succeeded)) {
      return { status: "blocked", reason: "The reconstructed execution result failed durable validation." };
    }
    const continuation = markApprovalContinuationPending(succeeded, seed, completedEvent.occurredAt);
    candidate = sanitizeApprovalRecord(terminalEvent
      ? markApprovalExecutionTerminal(continuation, "completed", undefined, terminalEvent.occurredAt)
      : continuation);
  } catch (error) {
    return {
      status: "blocked",
      reason: `The reconstructed workflow execution state failed durable validation: ${String(error)}`,
    };
  }
  if (!candidate) {
    return { status: "blocked", reason: "The reconstructed workflow execution state failed durable validation." };
  }
  return terminalEvent
    ? { status: "terminal", record: candidate }
    : { status: "continuation", record: candidate, seed };
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
  if (
    (approvedStep as typeof approvedStep & { toolName?: string }).toolName &&
    (approvedStep as typeof approvedStep & { toolName?: string }).toolName !== record.toolName
  ) {
    return undefined;
  }
  if (!hasApprovalEvidenceForStep(record, seed, approvedStepId)) {
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
  if (!nextEvents) return undefined;
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
      approvalRequestIds: seed.checkpoint.approvalRequestIds.filter(
        (approvalId) => approvalId !== record.approvalId,
      ),
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
}): RuntimeEventEnvelope[] | undefined {
  const firstSequence = latestEventSequence(input.seed) + 1;
  const resolvedAt = input.record.resolvedAt ?? new Date().toISOString();
  const ordered = [...input.seed.events].sort((left, right) => left.sequence - right.sequence);
  const requestSequence = ordered
    .filter((event) => permissionRequestIdFromEvent(event) === input.record.approvalId)
    .map((event) => event.sequence)
    .pop() ?? input.seed.checkpoint.eventSequence;
  const resolved = ordered.filter((event) =>
    event.sequence > requestSequence &&
    permissionResolvedIdFromEvent(event) === input.record.approvalId,
  );
  const expectedDecision = input.record.decision ?? "approved";
  if (resolved.some((event) => {
    const binding = approvalEventBinding(event);
    return !binding ||
      binding.stepId !== input.approvedStepId ||
      binding.toolName !== input.record.toolName ||
      binding.previewHash !== input.record.previewHash ||
      permissionDecisionFromEvent(event) !== expectedDecision;
  })) {
    return undefined;
  }
  const completed = ordered.some((event) =>
    event.sequence > requestSequence &&
    eventKind(event) === "step.completed" &&
    eventStepId(event) === input.approvedStepId,
  );
  if (completed && resolved.length === 0) return undefined;
  const nextEvents = [...input.seed.events];
  if (resolved.length === 0) {
    nextEvents.push(createResumeEnvelope(input.seed, firstSequence, {
      kind: "permission.resolved",
      taskId: input.seed.checkpoint.taskId,
      requestId: input.record.approvalId,
      decision: input.record.decision ?? "approved",
      stepId: input.approvedStepId,
      toolName: input.record.toolName,
      previewHash: input.record.previewHash,
    }, resolvedAt, input.approvedStepId));
  }
  if (!completed) {
    nextEvents.push(createResumeEnvelope(input.seed, firstSequence + (resolved.length === 0 ? 1 : 0), {
      kind: "step.completed",
      taskId: input.seed.checkpoint.taskId,
      stepId: input.approvedStepId,
      summary: `Restored approval ${input.record.approvalId} completed ${input.record.toolName}.`,
      agentKind: input.agentKind,
    }, resolvedAt, input.approvedStepId, input.agentKind));
  }
  return nextEvents;
}

function hasApprovalEvidenceForStep(
  record: DurableApprovalRecord,
  seed: RestoredApprovalResumeSeed,
  stepId: string,
): boolean {
  const requests = [...seed.events]
    .filter((event) => permissionRequestIdFromEvent(event) === record.approvalId)
    .sort((left, right) => left.sequence - right.sequence);
  if (requests.length === 0) return false;
  const request = requests[requests.length - 1];
  if (!request) return false;
  const binding = approvalEventBinding(request);
  if (!binding || binding.stepId !== stepId ||
    binding.toolName !== record.toolName ||
    binding.previewHash !== record.previewHash
  ) return false;
  const latestStarted = [...seed.events]
    .filter((event) => event.sequence <= request.sequence && eventKind(event) === "step.started")
    .sort((left, right) => left.sequence - right.sequence)
    .pop();
  return !latestStarted || eventStepId(latestStarted) === stepId;
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

function eventKind(event: RuntimeEventEnvelope): string | undefined {
  return isRecord(event.payload) && typeof event.payload.kind === "string"
    ? event.payload.kind
    : undefined;
}

function eventStepId(event: RuntimeEventEnvelope | undefined): string | undefined {
  if (!event) return undefined;
  if (typeof event.stepId === "string") return event.stepId;
  return isRecord(event.payload) && typeof event.payload.stepId === "string"
    ? event.payload.stepId
    : undefined;
}

function permissionDecisionFromEvent(event: RuntimeEventEnvelope): "approved" | "denied" | undefined {
  const payload = event.payload;
  if (!isRecord(payload)) return undefined;
  return payload.decision === "approved" || payload.decision === "denied"
    ? payload.decision
    : undefined;
}

function approvalEventBinding(event: RuntimeEventEnvelope): {
  stepId: string;
  toolName: string;
  previewHash: string;
} | undefined {
  const payload = event.payload;
  const stepId = eventStepId(event);
  if (!isRecord(payload) || !stepId ||
    typeof payload.toolName !== "string" ||
    typeof payload.previewHash !== "string"
  ) {
    return undefined;
  }
  return {
    stepId,
    toolName: payload.toolName,
    previewHash: payload.previewHash,
  };
}

function findLatestRuntimeEvent(
  events: RuntimeEventEnvelope[],
  predicate: (event: RuntimeEventEnvelope) => boolean,
): RuntimeEventEnvelope | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) return event;
  }
  return undefined;
}

function permissionRequestIdFromEvent(event: RuntimeEventEnvelope): string | undefined {
  const payload = event.payload;
  if (!isRecord(payload) || payload.kind !== "permission.requested") return undefined;
  if (typeof payload.approvalId === "string") return payload.approvalId;
  const request = payload.request;
  return isRecord(request) && typeof request.id === "string" ? request.id : undefined;
}

function permissionResolvedIdFromEvent(event: RuntimeEventEnvelope): string | undefined {
  const payload = event.payload;
  if (!isRecord(payload) || payload.kind !== "permission.resolved") return undefined;
  if (typeof payload.requestId === "string") return payload.requestId;
  return typeof payload.approvalId === "string" ? payload.approvalId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
