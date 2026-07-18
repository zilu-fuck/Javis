import { describe, expect, it } from "vitest";
import { computePlanHash, createArtifactEnvelope, createDryRunBindingHash } from "@javis/core";
import type { RuntimeEventEnvelope, WorkflowCheckpoint } from "@javis/core";
import {
  resolveApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";
import {
  advanceRestoredApprovalResumeSeed,
  attachRestoredApprovalDurableResume,
  buildRestoredApprovalDurableResumeMetadata,
  buildRestoredApprovalResumeStartRequest,
  createRestoredApprovalResumeStore,
  persistRestoredApprovalResumeCheckpoint,
  persistRestoredApprovalResumeEvents,
  reconcileApprovalExecutionFromEventLog,
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

  it("tracks claims independently for multiple restored approvals", () => {
    const store = createRestoredApprovalResumeStore();

    expect(store.claim("approval-1")).toBe(true);
    expect(store.claim("approval-2")).toBe(true);
    expect(store.claim("approval-1")).toBe(false);

    store.release("approval-1");
    expect(store.claim("approval-1")).toBe(true);
    expect(store.isInFlight("approval-2")).toBe(true);
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
      events: [createDetailedRuntimeEvent(2, {
        kind: "permission.requested",
        approvalId: "approval-1",
        stepId: "write",
        toolName: "file.executePdfOrganization",
        previewHash: createRecord().previewHash,
      }, "write")],
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
    expect(advanced?.events.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(advanced?.events.map((event) => (event.payload as { kind?: string }).kind)).toEqual([
      "permission.requested",
      "permission.resolved",
      "step.completed",
    ]);
    expect(advanced?.events[1]?.payload).toMatchObject({
      kind: "permission.resolved",
      requestId: record.approvalId,
      decision: "approved",
      stepId: "write",
      toolName: record.toolName,
      previewHash: record.previewHash,
    });
    expect(advanced?.events[2]?.payload).toMatchObject({
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

  it("propagates restored approval event persistence failures", async () => {
    const previousEvents = [createRuntimeEvent(1, "task.created")];
    const advancedEvents = [
      ...previousEvents,
      createRuntimeEvent(2, "permission.resolved"),
      createRuntimeEvent(3, "step.completed"),
    ];
    const appendBatch = async () => {
      throw new Error("database unavailable");
    };

    await expect(persistRestoredApprovalResumeEvents(
      previousEvents,
      advancedEvents,
      { appendBatch },
    )).rejects.toThrow("Failed to persist restored approval completion events");
  });

  it("requires the advanced checkpoint to persist before continuation", async () => {
    const seed = createSeed();

    await expect(persistRestoredApprovalResumeCheckpoint(
      seed.checkpoint,
      { save: async () => { throw new Error("checkpoint unavailable"); } },
    )).rejects.toThrow("Failed to persist restored approval checkpoint");
    await expect(persistRestoredApprovalResumeCheckpoint(
      seed.checkpoint,
      undefined,
    )).rejects.toThrow("checkpoint store is unavailable");
  });

  it("reconstructs continuation state from a full approval completion replay", () => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = createCompletedWriteCheckpoint();
    const events = createApprovalCompletionEvents("approved");

    const reconciliation = reconcileApprovalExecutionFromEventLog(record, checkpoint, events);

    expect(
      reconciliation.status,
      reconciliation.status === "blocked" ? reconciliation.reason : undefined,
    ).toBe("continuation");
    if (reconciliation.status !== "continuation") return;
    expect(reconciliation.record.execution).toMatchObject({
      status: "continuation_pending",
      stepId: "write",
      output: { status: "applied", changedFiles: ["README.md"] },
    });
    expect(reconciliation.seed.events).toEqual(events);
  });

  it("reconciles a completed workflow run to a terminal approval record", () => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = createCompletedWriteCheckpoint();
    const events = [
      ...createApprovalCompletionEvents("approved"),
      createDetailedRuntimeEvent(4, { kind: "task.completed", taskId: "task-1" }),
    ];

    const reconciliation = reconcileApprovalExecutionFromEventLog(record, checkpoint, events);

    expect(
      reconciliation.status,
      reconciliation.status === "blocked" ? reconciliation.reason : undefined,
    ).toBe("terminal");
    if (reconciliation.status !== "terminal") return;
    expect(reconciliation.record.execution?.status).toBe("completed");
  });

  it("blocks a denied approval replay that lacks step completion evidence", () => {
    const record = createResolvedWorkflowRecord("denied");
    const checkpoint = createSeed({
      completedStepIds: ["inspect"],
      pendingStepIds: [],
      runningStepIds: ["write"],
      steps: [createStep("inspect"), createStep("write", "patchResult")],
    }).checkpoint;
    const events = createApprovalCompletionEvents("denied").slice(0, 2);

    const reconciliation = reconcileApprovalExecutionFromEventLog(record, {
      ...checkpoint,
      eventSequence: 2,
    }, events);

    expect(reconciliation).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("does not prove"),
    });
  });

  it.each([
    ["toolName", "file.otherWrite"],
    ["previewHash", "tampered-preview-hash"],
  ] as const)("blocks approval events with a tampered %s binding", (field, value) => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = createCompletedWriteCheckpoint();
    const events = createApprovalCompletionEvents("approved");
    const resolved = events[1];
    if (!resolved || typeof resolved.payload !== "object" || resolved.payload === null) {
      throw new Error("Missing resolved approval fixture.");
    }
    events[1] = {
      ...resolved,
      payload: { ...resolved.payload, [field]: value },
    };

    expect(reconcileApprovalExecutionFromEventLog(record, checkpoint, events)).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("step, tool, and preview bindings"),
    });
  });

  it("blocks a permission resolution that precedes its matching request", () => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = createCompletedWriteCheckpoint();
    const completion = createApprovalCompletionEvents("approved");
    const events = [
      { ...completion[1]!, eventId: "evt-run-1-1", sequence: 1 },
      { ...completion[0]!, eventId: "evt-run-1-2", sequence: 2 },
      completion[2]!,
    ];

    expect(reconcileApprovalExecutionFromEventLog(record, checkpoint, events)).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("step, tool, and preview bindings"),
    });
  });

  it("does not treat a terminal event before this approval as its completion", () => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = { ...createCompletedWriteCheckpoint(), eventSequence: 4 };
    const completion = createApprovalCompletionEvents("approved");
    const events = [
      createDetailedRuntimeEvent(1, { kind: "task.completed", taskId: "task-1" }),
      ...completion.map((event, index) => ({
        ...event,
        eventId: `evt-run-1-${index + 2}`,
        sequence: index + 2,
      })),
    ];

    expect(reconcileApprovalExecutionFromEventLog(record, checkpoint, events).status)
      .toBe("continuation");
  });

  it("reconciles task.failed after approval resolution as a failed terminal record", () => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = createCompletedWriteCheckpoint();
    const events = [
      ...createApprovalCompletionEvents("approved").slice(0, 2),
      createDetailedRuntimeEvent(3, { kind: "task.failed", taskId: "task-1", reason: "verify failed" }),
    ];

    const reconciliation = reconcileApprovalExecutionFromEventLog(record, checkpoint, events);

    expect(reconciliation.status).toBe("terminal");
    if (reconciliation.status !== "terminal") return;
    expect(reconciliation.record.execution).toMatchObject({
      status: "failed",
      error: expect.stringContaining("task.failed"),
    });
  });

  it("accepts a falsey checkpoint output only when its provenance is bound", () => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = createCompletedWriteCheckpoint(false);
    const reconciliation = reconcileApprovalExecutionFromEventLog(
      record,
      checkpoint,
      createApprovalCompletionEvents("approved"),
    );

    expect(reconciliation.status).toBe("continuation");
    if (reconciliation.status !== "continuation") return;
    expect(reconciliation.record.execution?.output).toBe(false);
  });

  it("rejects a checkpoint output produced by another step", () => {
    const record = createResolvedWorkflowRecord("approved");
    const checkpoint = createCompletedWriteCheckpoint();
    const output = checkpoint.contextSnapshot.patchResult;
    if (!output || typeof output !== "object") throw new Error("Missing output fixture.");
    checkpoint.contextSnapshot.patchResult = {
      ...output,
      producer: { ...output.producer, stepId: "other-step" },
    };

    expect(reconcileApprovalExecutionFromEventLog(
      record,
      checkpoint,
      createApprovalCompletionEvents("approved"),
    )).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("does not prove"),
    });
  });
});

function createResolvedWorkflowRecord(decision: "approved" | "denied"): DurableApprovalRecord {
  return resolveApprovalRecord({
    ...createRecord(),
    runId: "run-1",
    workflowBound: true,
  }, decision, "2026-06-16T00:01:00.000Z");
}

function createCompletedWriteCheckpoint(output: unknown = { status: "applied", changedFiles: ["README.md"] }): WorkflowCheckpoint {
  const base = createSeed({
    completedStepIds: ["inspect", "write"],
    pendingStepIds: ["summarize"],
    runningStepIds: [],
    steps: [createStep("inspect"), createStep("write", "patchResult"), createStep("summarize")],
  }).checkpoint;
  const envelope = createArtifactEnvelope(output, {
    taskId: "task-1",
    runId: "run-1",
    type: "patchResult",
    producer: { stepId: "write", agentKind: "code", toolName: "file.executePdfOrganization" },
    sensitivity: "workspace",
  });
  return {
    ...base,
    contextSnapshot: {
      patchResult: envelope,
      "step:write": createArtifactEnvelope(output, {
        taskId: "task-1",
        runId: "run-1",
        type: "step:write",
        producer: { stepId: "write", agentKind: "code", toolName: "file.executePdfOrganization" },
        sensitivity: "workspace",
      }),
    },
    approvalRequestIds: [],
    waitingReason: undefined,
    eventSequence: 3,
  };
}

function createApprovalCompletionEvents(
  decision: "approved" | "denied",
): RuntimeEventEnvelope[] {
  const binding = createRecord();
  return [
    createDetailedRuntimeEvent(1, {
      kind: "permission.requested",
      approvalId: "approval-1",
      stepId: "write",
      toolName: binding.toolName,
      previewHash: binding.previewHash,
    }, "write"),
    createDetailedRuntimeEvent(2, {
      kind: "permission.resolved",
      requestId: "approval-1",
      decision,
      stepId: "write",
      toolName: binding.toolName,
      previewHash: binding.previewHash,
    }, "write"),
    createDetailedRuntimeEvent(3, {
      kind: "step.completed",
      taskId: "task-1",
      stepId: "write",
    }, "write"),
  ];
}

function createDetailedRuntimeEvent(
  sequence: number,
  payload: Record<string, unknown>,
  stepId?: string,
): RuntimeEventEnvelope {
  return {
    ...createRuntimeEvent(sequence, String(payload.kind ?? "unknown")),
    ...(stepId ? { stepId } : {}),
    payload,
  };
}

function createRuntimeEvent(sequence: number, kind: string): RuntimeEventEnvelope {
  return {
    eventId: `evt-run-1-${sequence}`,
    eventVersion: 1,
    sequence,
    taskId: "task-1",
    runId: "run-1",
    workflowId: "commander-dag",
    correlationId: "run-1",
    occurredAt: "2026-06-16T00:00:00.000Z",
    recordedAt: "2026-06-16T00:00:00.000Z",
    payload: { kind, taskId: "task-1" },
  };
}

function createSeed(overrides: {
  completedStepIds?: string[];
  pendingStepIds?: string[];
  runningStepIds?: string[];
  steps?: WorkflowCheckpoint["workflowSnapshot"]["steps"];
  events?: RuntimeEventEnvelope[];
} = {}): {
  checkpoint: WorkflowCheckpoint;
  events: RuntimeEventEnvelope[];
} {
  const steps = overrides.steps ?? [];
  return {
    checkpoint: {
      taskId: "task-1",
      runId: "run-1",
      workflowId: "commander-dag",
      workflowVersion: 1,
      planHash: computePlanHash(steps),
      workflowSnapshot: {
        id: "commander-dag" as never,
        title: "Durable workflow",
        triggerExamples: [],
        goal: "original durable goal",
        coordinatorAgentKind: "commander",
        participatingAgentKinds: ["commander"],
        currentSupport: "partial",
        safetyNotes: [],
        steps,
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
    events: overrides.events ?? [],
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
    ...(outputContextKey ? { outputContextKey } : {}),
    toolName: "file.executePdfOrganization",
  } as WorkflowCheckpoint["workflowSnapshot"]["steps"][number];
}

function createRecord(): DurableApprovalRecord {
  const dryRun: DurableApprovalRecord["permissionRequest"]["dryRun"] = {
    operation: "Write",
    affectedPaths: [],
    riskSummary: "Preview",
    reversible: true,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "approval-1",
    taskId: "task-1",
    toolName: "file.executePdfOrganization",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-06-16T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-16T00:00:00.000Z",
    permissionRequest: {
      id: "approval-1",
      level: "confirmed_write",
      title: "Approve PDF move plan",
      reason: "Approval needed.",
      bindingHash,
      status: "pending",
      createdAt: "2026-06-16T00:00:00.000Z",
      dryRun,
    },
  };
}
