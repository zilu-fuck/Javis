import type { WorkbenchWorkflow, WorkbenchWorkflowStep } from "./workflows";
import type { ArtifactEnvelope } from "./artifact-envelope";

export interface WorkflowCheckpoint {
  taskId: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  planHash: string;
  workflowSnapshot: WorkbenchWorkflow;

  completedStepIds: string[];
  abandonedStepIds: string[];
  pendingStepIds: string[];
  runningStepIds: string[];

  contextSnapshot: Record<string, ArtifactEnvelope>;
  approvalRequestIds: string[];

  waitingReason?:
    | "human_approval"
    | "user_input"
    | "tool_result"
    | "retry_delay";

  eventSequence: number;
  createdAt: string;
}

export type CheckpointTrigger =
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "permission.requested"
  | "task.replan_started"
  | "task.replan_failed"
  | "task.waiting"
  | "task.completed"
  | "task.failed"
  | "task.cancelled";

export const CHECKPOINT_TRIGGERS: ReadonlySet<CheckpointTrigger> = new Set([
  "step.started",
  "step.completed",
  "step.failed",
  "permission.requested",
  "task.replan_started",
  "task.replan_failed",
  "task.waiting",
  "task.completed",
  "task.failed",
  "task.cancelled",
]);

export function isCheckpointTrigger(kind: string): kind is CheckpointTrigger {
  return CHECKPOINT_TRIGGERS.has(kind as CheckpointTrigger);
}

export function computePlanHash(steps: WorkbenchWorkflowStep[]): string {
  const normalized = steps
    .map((s) => ({
      id: s.id,
      deps: [...(s.dependsOn ?? [])].sort(),
      agent: s.agentKind,
      cap: [...(s.requiredCapabilities ?? [])].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const canonical = JSON.stringify(normalized);
  let hash = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  }
  return `plan-${(hash >>> 0).toString(16).padStart(8, "0")}-${steps.length}`;
}

export function buildCheckpointFromDagState(input: {
  taskId: string;
  runId: string;
  workflow: WorkbenchWorkflow;
  completedStepIds: string[];
  abandonedStepIds: string[];
  runningStepIds: string[];
  contextSnapshot: Record<string, unknown>;
  approvalRequestIds?: string[];
  waitingReason?: WorkflowCheckpoint["waitingReason"];
  eventSequence: number;
  envelopes?: Record<string, ArtifactEnvelope>;
}): WorkflowCheckpoint {
  const allStepIds = new Set(input.workflow.steps.map((s) => s.id));
  const doneOrAbandoned = new Set([...input.completedStepIds, ...input.abandonedStepIds]);
  const pendingStepIds = [...allStepIds].filter(
    (id) => !doneOrAbandoned.has(id) && !input.runningStepIds.includes(id),
  );

  const contextSnapshot: Record<string, ArtifactEnvelope> = {};
  if (input.envelopes) {
    for (const [key, envelope] of Object.entries(input.envelopes)) {
      contextSnapshot[key] = envelope;
    }
  }

  return {
    taskId: input.taskId,
    runId: input.runId,
    workflowId: input.workflow.id,
    workflowVersion: 1,
    planHash: computePlanHash(input.workflow.steps),
    workflowSnapshot: input.workflow,
    completedStepIds: [...input.completedStepIds],
    abandonedStepIds: [...input.abandonedStepIds],
    pendingStepIds,
    runningStepIds: [...input.runningStepIds],
    contextSnapshot,
    approvalRequestIds: input.approvalRequestIds ?? [],
    waitingReason: input.waitingReason,
    eventSequence: input.eventSequence,
    createdAt: new Date().toISOString(),
  };
}

export function isCheckpointResumeCompatible(
  checkpoint: WorkflowCheckpoint,
  currentWorkflow: WorkbenchWorkflow,
): boolean {
  const currentHash = computePlanHash(currentWorkflow.steps);
  if (checkpoint.planHash !== currentHash) return false;
  if (checkpoint.workflowId !== currentWorkflow.id) return false;
  return true;
}

export function getResumableStepIds(checkpoint: WorkflowCheckpoint): {
  skip: string[];
  retry: string[];
  pending: string[];
} {
  return {
    skip: [...checkpoint.completedStepIds],
    retry: [...checkpoint.runningStepIds],
    pending: [...checkpoint.pendingStepIds],
  };
}
