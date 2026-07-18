import type { WorkbenchWorkflow, WorkbenchWorkflowStep } from "./workflows";
import {
  computeContentHash,
  createArtifactEnvelope,
  isArtifactEnvelope,
  sanitizeArtifactForPersistence,
  type ArtifactEnvelope,
} from "./artifact-envelope";

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

/**
 * Execution fields carried by a Commander plan but not required by the
 * historical WorkbenchWorkflowStep interface.  Checkpoint snapshots retain
 * these fields at runtime so a restored plan cannot silently swap tools or
 * inputs while keeping the same workflow-level shape.
 */
type ExecutionPlanStep = WorkbenchWorkflowStep & {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  executionMode?: string;
  capability?: string;
  choices?: unknown[];
  successCriteria?: string;
};

export function computePlanHash(steps: WorkbenchWorkflowStep[]): string {
  const normalized = steps
    .map((step) => {
      const s = step as ExecutionPlanStep;
      return {
        id: s.id,
        title: s.title,
        input: s.input,
        output: s.output,
        deps: [...(s.dependsOn ?? [])].sort(),
        agent: s.agentKind,
        cap: [...(s.requiredCapabilities ?? [])].sort(),
        inputContextKeys: [...(s.inputContextKeys ?? [])].sort(),
        outputContextKey: s.outputContextKey ?? "",
        permissionLevel: s.permissionLevel,
        canRunInParallel: s.canRunInParallel,
        // These fields determine the concrete operation performed after a
        // checkpoint is restored. Empty sentinels preserve a stable distinction
        // between an omitted legacy field and a populated value.
        toolName: s.toolName ?? "",
        toolInput: s.toolInput ?? null,
        executionMode: s.executionMode ?? "",
        capability: s.capability ?? "",
        choices: s.choices ?? [],
        successCriteria: s.successCriteria ?? "",
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return `plan-sha256-v2-${computeContentHash(normalized)}-${steps.length}`;
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
  for (const [key, value] of Object.entries(input.contextSnapshot)) {
    if (isArtifactEnvelope(value)) {
      contextSnapshot[key] = value;
    }
  }
  if (input.envelopes) {
    for (const [key, envelope] of Object.entries(input.envelopes)) {
      contextSnapshot[key] = sanitizeArtifactForPersistence(envelope);
    }
  }
  for (const [key, value] of Object.entries(input.contextSnapshot)) {
    if (value === undefined || contextSnapshot[key]) {
      continue;
    }
    if (isArtifactEnvelope(value)) {
      contextSnapshot[key] = sanitizeArtifactForPersistence(value);
      continue;
    }
    const producerStep = input.workflow.steps
      .find((step) => step.outputContextKey === key) as ExecutionPlanStep | undefined;
    contextSnapshot[key] = sanitizeArtifactForPersistence(createArtifactEnvelope(value, {
      taskId: input.taskId,
      runId: input.runId,
      type: `sharedContext.${key}`,
      producer: {
        workflowId: input.workflow.id,
        stepId: producerStep?.id ?? "checkpoint",
        agentKind: producerStep?.agentKind,
        toolName: producerStep?.toolName,
      },
      sensitivity: "workspace",
    }));
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
