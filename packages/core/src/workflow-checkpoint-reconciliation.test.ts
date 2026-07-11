import { describe, expect, it } from "vitest";
import { createArtifactEnvelope } from "./artifact-envelope";
import type { RuntimeEventEnvelope } from "./runtime-event-envelope";
import type { WorkflowCheckpoint } from "./workflow-checkpoint";
import {
  createWorkflowResumeStateFromReconciliation,
  reconcileCheckpointWithEventLog,
} from "./workflow-checkpoint-reconciliation";

describe("reconcileCheckpointWithEventLog", () => {
  it("returns resumable when checkpoint state is covered by matching events", () => {
    const checkpoint = createCheckpoint({
      completedStepIds: ["scan"],
      pendingStepIds: ["approve"],
      approvalRequestIds: ["approval-1"],
      eventSequence: 3,
    });
    const result = reconcileCheckpointWithEventLog(checkpoint, [
      event(1, { kind: "step.started", stepId: "scan" }),
      event(2, { kind: "step.completed", stepId: "scan" }),
      event(3, { kind: "permission.requested", request: { id: "approval-1" } }),
    ]);

    expect(result.status).toBe("resumable");
    expect(result.completedStepIds).toEqual(["scan"]);
    expect(result.approvalRequestIds).toEqual(["approval-1"]);
    expect(result.latestEventSequence).toBe(3);
  });

  it("collects approval evidence from flat permission event approvalId fields", () => {
    const result = reconcileCheckpointWithEventLog(
      createCheckpoint({ eventSequence: 1 }),
      [event(1, { kind: "permission.requested", approvalId: "approval-flat" })],
    );

    expect(result.status).toBe("resumable");
    expect(result.approvalRequestIds).toEqual(["approval-flat"]);
  });

  it("collects approval evidence from permission resolved request ids", () => {
    const result = reconcileCheckpointWithEventLog(
      createCheckpoint({ eventSequence: 1 }),
      [event(1, { kind: "permission.resolved", requestId: "approval-resolved", decision: "approved" })],
    );

    expect(result.status).toBe("resumable");
    expect(result.approvalRequestIds).toEqual(["approval-resolved"]);
  });

  it("blocks when no event log can validate a non-zero checkpoint sequence", () => {
    const result = reconcileCheckpointWithEventLog(createCheckpoint({ eventSequence: 2 }), []);

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("Event log is empty");
  });

  it("blocks when replayed events are older than the checkpoint sequence", () => {
    const result = reconcileCheckpointWithEventLog(
      createCheckpoint({ eventSequence: 5 }),
      [event(4, { kind: "step.completed", stepId: "scan" })],
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("does not cover");
  });

  it("blocks when events belong to a different task or run", () => {
    const result = reconcileCheckpointWithEventLog(
      createCheckpoint({ eventSequence: 1 }),
      [
        {
          ...event(1, { kind: "step.started", stepId: "scan" }),
          runId: "run-other",
        },
      ],
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("different task or run");
  });

  it("requires rebuild when checkpoint step state conflicts with event log", () => {
    const checkpoint = createCheckpoint({
      completedStepIds: ["scan"],
      eventSequence: 2,
    });
    const result = reconcileCheckpointWithEventLog(checkpoint, [
      event(1, { kind: "step.started", stepId: "scan" }),
      event(2, { kind: "step.failed", stepId: "scan", error: "scan failed" }),
    ]);

    expect(result.status).toBe("rebuild_required");
    expect(result.mismatchedStepIds).toEqual(["scan"]);
    expect(result.retryStepIds).toEqual(["scan"]);
  });

  it("requires rebuild when a checkpoint-completed step has no completion event", () => {
    const checkpoint = createCheckpoint({
      completedStepIds: ["scan"],
      eventSequence: 2,
    });
    const result = reconcileCheckpointWithEventLog(checkpoint, [
      event(1, { kind: "step.started", stepId: "scan" }),
      event(2, { kind: "task.waiting", taskId: "task-1" }),
    ]);

    expect(result.status).toBe("rebuild_required");
    expect(result.mismatchedStepIds).toEqual(["scan"]);
    expect(result.completedStepIds).toEqual([]);
  });

  it("builds resume state from event log when reconciliation requires rebuild", () => {
    const checkpoint = createCheckpoint({
      completedStepIds: ["scan"],
      eventSequence: 2,
    });
    const reconciliation = reconcileCheckpointWithEventLog(checkpoint, [
      event(1, { kind: "step.started", stepId: "scan" }),
      event(2, { kind: "step.failed", stepId: "scan", error: "scan failed" }),
    ]);

    const result = createWorkflowResumeStateFromReconciliation(reconciliation);

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.source).toBe("event-log");
      expect(result.resumeState.completedStepIds).toEqual([]);
      expect(result.resumeState.retryStepIds).toEqual(["scan"]);
    }
  });

  it("blocks resume when a confirmed-write step was running at checkpoint time", () => {
    const result = reconcileCheckpointWithEventLog(
      createCheckpoint({
        completedStepIds: ["scan"],
        pendingStepIds: [],
        runningStepIds: ["approve"],
        eventSequence: 3,
      }),
      [
        event(1, { kind: "step.started", stepId: "scan" }),
        event(2, { kind: "step.completed", stepId: "scan" }),
        event(3, { kind: "step.started", stepId: "approve" }),
      ],
    );
    const resume = createWorkflowResumeStateFromReconciliation(result);

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("confirmed-write");
    expect(result.retryStepIds).toEqual([]);
    expect(resume.status).toBe("blocked");
  });

  it("allows a restored approval checkpoint advanced after permission approval", () => {
    const checkpoint = createCheckpoint({
      completedStepIds: ["scan", "approve"],
      pendingStepIds: [],
      runningStepIds: [],
      approvalRequestIds: ["approval-1"],
      eventSequence: 4,
      contextSnapshot: {
        approvalResult: createArtifactEnvelope(
          { status: "applied" },
          {
            taskId: "task-1",
            runId: "run-1",
            type: "approvalResult",
            producer: { stepId: "approve", agentKind: "commander" },
          },
        ),
      },
    });

    const result = reconcileCheckpointWithEventLog(checkpoint, [
      event(1, { kind: "step.started", stepId: "scan" }),
      event(2, { kind: "step.completed", stepId: "scan" }),
      event(3, { kind: "permission.requested", request: { id: "approval-1" } }),
      event(4, { kind: "step.completed", stepId: "approve" }),
    ]);
    const resume = createWorkflowResumeStateFromReconciliation(result);

    expect(result.status).toBe("resumable");
    expect(result.completedStepIds).toEqual(["scan", "approve"]);
    expect(result.retryStepIds).toEqual([]);
    expect(resume.status).toBe("ready");
    if (resume.status === "ready") {
      expect(resume.resumeState.contextSnapshot?.approvalResult).toBe(
        checkpoint.contextSnapshot.approvalResult,
      );
      expect(checkpoint.contextSnapshot.approvalResult?.payload).toEqual({
        status: "applied",
      });
    }
  });

  it("builds executor resume state from a resumable checkpoint", () => {
    const checkpoint = createCheckpoint({
      completedStepIds: ["scan"],
      pendingStepIds: ["approve"],
      eventSequence: 2,
      contextSnapshot: {
        diffPreview: createArtifactEnvelope(
          { diff: "diff --git", changedFiles: ["src/app.ts"] },
          {
            taskId: "task-1",
            runId: "run-1",
            type: "diffPreview",
            producer: { stepId: "scan", agentKind: "code" },
          },
        ),
      },
    });
    const reconciliation = reconcileCheckpointWithEventLog(checkpoint, [
      event(1, { kind: "step.started", stepId: "scan" }),
      event(2, { kind: "step.completed", stepId: "scan" }),
    ]);

    const result = createWorkflowResumeStateFromReconciliation(reconciliation);

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.resumeState.completedStepIds).toEqual(["scan"]);
      expect(result.resumeState.contextSnapshot?.diffPreview).toEqual(
        checkpoint.contextSnapshot.diffPreview,
      );
    }
  });

  it("preserves artifact envelopes in executor resume state", () => {
    const envelope = createArtifactEnvelope(
      { diff: "diff --git", changedFiles: ["src/app.ts"] },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "scan", agentKind: "file" },
      },
    );
    const checkpoint = createCheckpoint({
      completedStepIds: ["scan"],
      pendingStepIds: ["approve"],
      eventSequence: 2,
      contextSnapshot: {
        diffPreview: envelope,
      },
    });
    const reconciliation = reconcileCheckpointWithEventLog(checkpoint, [
      event(1, { kind: "step.started", stepId: "scan" }),
      event(2, { kind: "step.completed", stepId: "scan" }),
    ]);

    const result = createWorkflowResumeStateFromReconciliation(reconciliation);

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.resumeState.contextSnapshot?.diffPreview).toBe(envelope);
    }
  });

  it("does not build executor resume state for blocked reconciliation", () => {
    const reconciliation = reconcileCheckpointWithEventLog(createCheckpoint({ eventSequence: 3 }), []);

    const result = createWorkflowResumeStateFromReconciliation(reconciliation);

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toContain("Event log is empty");
    }
  });
});

function createCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    taskId: "task-1",
    runId: "run-1",
    workflowId: "read-current-project",
    workflowVersion: 1,
    planHash: "plan-test",
    workflowSnapshot: {
      id: "read-current-project",
      title: "Read current project",
      triggerExamples: [],
      goal: "Read the project",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander", "file"],
      currentSupport: "partial",
      safetyNotes: [],
      steps: [
        {
          id: "scan",
          title: "Scan",
          agentKind: "file",
          input: "workspace",
          output: "files",
          permissionLevel: "read",
          dependsOn: [],
          canRunInParallel: false,
        },
        {
          id: "approve",
          title: "Approve",
          agentKind: "commander",
          input: "files",
          output: "approval",
          permissionLevel: "confirmed_write",
          dependsOn: ["scan"],
          canRunInParallel: false,
        },
      ],
    },
    completedStepIds: [],
    abandonedStepIds: [],
    pendingStepIds: ["scan", "approve"],
    runningStepIds: [],
    contextSnapshot: {},
    approvalRequestIds: [],
    waitingReason: "human_approval",
    eventSequence: 0,
    createdAt: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function event(sequence: number, payload: unknown): RuntimeEventEnvelope {
  return {
    eventId: `evt-run-1-${sequence}`,
    eventVersion: 1,
    sequence,
    taskId: "task-1",
    runId: "run-1",
    workflowId: "read-current-project",
    correlationId: "corr-1",
    occurredAt: "2026-06-16T00:00:00.000Z",
    recordedAt: "2026-06-16T00:00:00.001Z",
    payload,
  };
}
