import { describe, expect, it } from "vitest";
import type { RuntimeEventEnvelope, WorkflowCheckpoint } from "@javis/core";
import type { DurableApprovalRecord } from "./approval-records";
import {
  advanceRestoredApprovalResumeSeed,
  attachRestoredApprovalDurableResume,
  buildRestoredApprovalDurableResumeMetadata,
  buildRestoredApprovalResumeStartRequest,
  createRestoredApprovalResumeStore,
} from "./restored-approval-resume";

describe("restored approval resume", () => {
  it("waits for checkpoint linkage before allowing restored approval execution", async () => {
    const store = createRestoredApprovalResumeStore();
    let finishLoading: (() => void) | undefined;
    const loading = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    store.setLoading("approval-1", loading);
    let ready = false;

    const waiting = store.waitUntilReady("approval-1").then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    finishLoading?.();
    await waiting;
    expect(ready).toBe(true);
  });

  it("stores resume seeds for one-shot approval continuation", () => {
    const store = createRestoredApprovalResumeStore();
    const seed = createSeed();

    store.set("approval-1", seed);

    expect(store.get("approval-1")).toBe(seed);
    expect(store.consume("approval-1")).toBe(seed);
    expect(store.consume("approval-1")).toBeUndefined();
  });

  it("builds runtime.start options that resume the original task", () => {
    const record = createRecord();
    const seed = createSeed();

    const request = buildRestoredApprovalResumeStartRequest(record, seed, "fallback goal");

    expect(request.userGoal).toBe("original durable goal");
    expect(request.options).toEqual({
      taskId: "task-1",
      mode: "project",
      originMode: "project",
      workspacePath: "E:/Javis",
      appendUserMessage: false,
      resumeFromCheckpoint: seed,
    });
  });

  it("falls back to the current task goal when checkpoint goal is empty", () => {
    const baseSeed = createSeed();
    const seed = {
      ...baseSeed,
      checkpoint: {
        ...baseSeed.checkpoint,
        workflowSnapshot: {
          ...baseSeed.checkpoint.workflowSnapshot,
          goal: "",
        },
      },
    };

    const request = buildRestoredApprovalResumeStartRequest(createRecord(), seed, "fallback goal");

    expect(request.userGoal).toBe("fallback goal");
  });

  it("builds durable resume metadata for restored terminal tasks", () => {
    const seed = createSeed({
      completedStepIds: ["inspect"],
      pendingStepIds: ["summarize"],
      runningStepIds: ["write"],
    });

    const metadata = buildRestoredApprovalDurableResumeMetadata(seed);

    expect(metadata).toEqual({
      runId: "run-1",
      source: "checkpoint",
      checkpointEventSequence: 2,
      latestEventSequence: 2,
      completedStepIds: ["inspect"],
      retryStepIds: ["write", "summarize"],
      approvalRequestIds: ["approval-1"],
      rebuilt: false,
    });
  });

  it("attaches durable resume metadata to restored terminal tasks", () => {
    const seed = createSeed();
    const task = {
      id: "task-1",
      title: "Restored denied",
      userGoal: "goal",
      status: "completed" as const,
      commanderMessage: "Denied.",
      plan: [],
      agents: [],
      logs: [],
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    };

    const attached = attachRestoredApprovalDurableResume(task, seed);

    expect(attached.runId).toBe("run-1");
    expect(attached.durableResume?.runId).toBe("run-1");
    expect(attached.durableResume?.approvalRequestIds).toEqual(["approval-1"]);
  });

  it("advances a restored approval checkpoint past the approved running step", () => {
    const record = createRecord();
    const seed = createSeed({
      completedStepIds: ["inspect"],
      pendingStepIds: ["summarize"],
      runningStepIds: ["write"],
      steps: [createStep("inspect"), createStep("write", "patchResult"), createStep("summarize")],
    });

    const advanced = advanceRestoredApprovalResumeSeed(record, seed, {
      status: "applied",
      changedFiles: ["apps/desktop/src/App.tsx"],
    });

    expect(advanced?.checkpoint.completedStepIds).toEqual(["inspect", "write"]);
    expect(advanced?.checkpoint.runningStepIds).toEqual([]);
    expect(advanced?.checkpoint.pendingStepIds).toEqual(["summarize"]);
    expect(advanced?.checkpoint.waitingReason).toBeUndefined();
    expect(advanced?.checkpoint.contextSnapshot.patchResult?.payload).toEqual({
      status: "applied",
      changedFiles: ["apps/desktop/src/App.tsx"],
    });
    expect(advanced?.checkpoint.contextSnapshot["step:write"]?.payload).toEqual({
      status: "applied",
      changedFiles: ["apps/desktop/src/App.tsx"],
    });
    expect(advanced?.checkpoint.eventSequence).toBe(4);
    expect(advanced?.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(advanced?.events.map((event) => (event.payload as { kind?: string }).kind)).toEqual([
      "permission.resolved",
      "step.completed",
    ]);
    expect(advanced?.events[0]?.payload).toMatchObject({
      kind: "permission.resolved",
      requestId: record.approvalId,
      decision: "approved",
    });
    expect(advanced?.events[1]?.payload).toMatchObject({
      kind: "step.completed",
      stepId: "write",
    });
  });

  it("does not advance when the waiting approval step is ambiguous", () => {
    const seed = createSeed({
      runningStepIds: ["write-a", "write-b"],
      steps: [createStep("write-a"), createStep("write-b")],
    });

    expect(
      advanceRestoredApprovalResumeSeed(createRecord(), seed, { status: "applied" }),
    ).toBeUndefined();
  });
});

function createSeed(overrides: {
  completedStepIds?: string[];
  pendingStepIds?: string[];
  runningStepIds?: string[];
  steps?: WorkflowCheckpoint["workflowSnapshot"]["steps"];
} = {}): {
  checkpoint: WorkflowCheckpoint;
  events: RuntimeEventEnvelope[];
} {
  return {
    checkpoint: {
      taskId: "task-1",
      runId: "run-1",
      workflowId: "commander-dag",
      workflowVersion: 1,
      planHash: "plan-1",
      workflowSnapshot: {
        id: "commander-dag" as never,
        title: "Durable workflow",
        triggerExamples: [],
        goal: "original durable goal",
        coordinatorAgentKind: "commander",
        participatingAgentKinds: ["commander"],
        currentSupport: "partial",
        safetyNotes: [],
        steps: overrides.steps ?? [],
      },
      completedStepIds: overrides.completedStepIds ?? ["inspect"],
      abandonedStepIds: [],
      pendingStepIds: overrides.pendingStepIds ?? ["write"],
      runningStepIds: overrides.runningStepIds ?? [],
      contextSnapshot: {},
      approvalRequestIds: ["approval-1"],
      waitingReason: "human_approval",
      eventSequence: 2,
      createdAt: "2026-06-16T00:00:00.000Z",
    },
    events: [],
  };
}

function createStep(
  id: string,
  outputContextKey?: string,
): WorkflowCheckpoint["workflowSnapshot"]["steps"][number] {
  return {
    id,
    title: id,
    agentKind: "code",
    input: "input",
    output: "output",
    permissionLevel: "confirmed_write",
    dependsOn: [],
    canRunInParallel: false,
    outputContextKey,
  };
}

function createRecord(): DurableApprovalRecord {
  return {
    approvalId: "approval-1",
    taskId: "task-1",
    toolName: "code.applyProposedEdit",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: "hash",
    expiresAt: "2026-06-16T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-16T00:00:00.000Z",
    permissionRequest: {
      id: "approval-1",
      level: "confirmed_write",
      title: "Approve Code Agent patch application",
      reason: "Approval needed.",
      bindingHash: "hash",
      status: "pending",
      createdAt: "2026-06-16T00:00:00.000Z",
      dryRun: {
        operation: "Write",
        affectedPaths: [],
        riskSummary: "Preview",
        reversible: true,
      },
    },
  };
}
