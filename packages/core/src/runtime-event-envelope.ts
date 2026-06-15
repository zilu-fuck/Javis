export interface RuntimeEventEnvelope<T = unknown> {
  eventId: string;
  eventVersion: number;
  sequence: number;

  taskId: string;
  runId: string;
  workflowId?: string;
  stepId?: string;
  agentId?: string;

  correlationId: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;

  occurredAt: string;
  recordedAt: string;
  payload: T;
}

export type RuntimeEventKind =
  | "task.created"
  | "task.waiting"
  | "task.timeout"
  | "task.cancelled"
  | "task.replan_started"
  | "task.replan_failed"
  | "task.completed"
  | "task.failed"
  | "agent.status"
  | "agent.chunk_start"
  | "agent.chunk"
  | "agent.chunk_end"
  | "step.started"
  | "step.progress"
  | "step.completed"
  | "step.failed"
  | "tool.planned"
  | "tool.completed"
  | "tool.partial"
  | "permission.requested"
  | "permission.resolved"
  | "ask_user.requested"
  | "ask_user.responded";

export const STRUCTURAL_EVENT_KINDS: ReadonlySet<RuntimeEventKind> = new Set([
  "task.created",
  "task.waiting",
  "task.timeout",
  "task.cancelled",
  "task.replan_started",
  "task.replan_failed",
  "task.completed",
  "task.failed",
  "step.started",
  "step.completed",
  "step.failed",
  "permission.requested",
  "permission.resolved",
  "ask_user.requested",
  "ask_user.responded",
  "tool.planned",
  "tool.completed",
]);

export const STREAMING_EVENT_KINDS: ReadonlySet<RuntimeEventKind> = new Set([
  "agent.chunk_start",
  "agent.chunk",
  "agent.chunk_end",
  "tool.partial",
]);

export function isStructuralEvent(kind: RuntimeEventKind): boolean {
  return STRUCTURAL_EVENT_KINDS.has(kind);
}

export function isStreamingEvent(kind: RuntimeEventKind): boolean {
  return STREAMING_EVENT_KINDS.has(kind);
}

export function extractEventKind(envelope: RuntimeEventEnvelope): RuntimeEventKind {
  return (envelope.payload as { kind: RuntimeEventKind }).kind;
}

export function extractStepId(envelope: RuntimeEventEnvelope): string | undefined {
  if (envelope.stepId) return envelope.stepId;
  const payload = envelope.payload as Record<string, unknown>;
  return typeof payload === "object" && payload !== null && typeof payload.stepId === "string"
    ? payload.stepId
    : undefined;
}

export function extractAgentKind(envelope: RuntimeEventEnvelope): string | undefined {
  const payload = envelope.payload as Record<string, unknown>;
  if (typeof payload === "object" && payload !== null && typeof payload.agentKind === "string") {
    return payload.agentKind;
  }
  return undefined;
}

let envelopeSequenceCounter = new Map<string, number>();

export function resetEnvelopeSequence(runId: string): void {
  envelopeSequenceCounter.delete(runId);
}

export function nextEnvelopeSequence(runId: string): number {
  const current = envelopeSequenceCounter.get(runId) ?? 0;
  const next = current + 1;
  envelopeSequenceCounter.set(runId, next);
  return next;
}

export function currentEnvelopeSequence(runId: string): number {
  return envelopeSequenceCounter.get(runId) ?? 0;
}

export function createRuntimeEventEnvelope<T>(
  payload: T,
  context: {
    taskId: string;
    runId: string;
    workflowId?: string;
    stepId?: string;
    agentId?: string;
    correlationId?: string;
    causationId?: string;
  },
): RuntimeEventEnvelope<T> {
  const now = new Date().toISOString();
  return {
    eventId: `evt-${context.runId}-${nextEnvelopeSequence(context.runId)}-${Date.now()}`,
    eventVersion: 1,
    sequence: envelopeSequenceCounter.get(context.runId) ?? 0,
    taskId: context.taskId,
    runId: context.runId,
    workflowId: context.workflowId,
    stepId: context.stepId ?? extractStepIdFromPayload(payload),
    agentId: context.agentId ?? extractAgentKindFromPayload(payload),
    correlationId: context.correlationId ?? context.runId,
    causationId: context.causationId,
    occurredAt: now,
    recordedAt: now,
    payload,
  };
}

function extractStepIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null && "stepId" in payload) {
    const value = (payload as Record<string, unknown>).stepId;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function extractAgentKindFromPayload(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null && "agentKind" in payload) {
    const value = (payload as Record<string, unknown>).agentKind;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
