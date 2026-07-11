import { describe, expect, it } from "vitest";
import { createArtifactEnvelope } from "./artifact-envelope";
import { buildCheckpointFromDagState, computePlanHash } from "./workflow-checkpoint";
import type { WorkbenchWorkflow } from "./workflows";

const workflow: WorkbenchWorkflow = {
  id: "code-review",
  title: "Review",
  triggerExamples: [],
  goal: "Review code",
  coordinatorAgentKind: "commander",
  participatingAgentKinds: ["commander", "code", "verifier"],
  currentSupport: "implemented",
  safetyNotes: [],
  steps: [
    {
      id: "scan",
      title: "Scan repository",
      agentKind: "code",
      input: "repo",
      output: "evidence",
      permissionLevel: "read",
      dependsOn: [],
      canRunInParallel: false,
      outputContextKey: "repoEvidence",
    },
  ],
};

describe("buildCheckpointFromDagState", () => {
  it("persists ordinary shared context values as restorable envelopes", () => {
    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow,
      completedStepIds: ["scan"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: {
        repoEvidence: { files: ["src/index.ts"] },
      },
      eventSequence: 7,
    });

    expect(checkpoint.contextSnapshot.repoEvidence.payload).toEqual({
      files: ["src/index.ts"],
    });
    expect(checkpoint.contextSnapshot.repoEvidence.producer).toMatchObject({
      stepId: "scan",
      agentKind: "code",
    });
  });

  it("prefers existing artifact envelopes over raw context payloads", () => {
    const envelope = createArtifactEnvelope({ files: ["README.md"] }, {
      taskId: "task-1",
      runId: "run-1",
      type: "repoEvidence",
      producer: { stepId: "scan", agentKind: "code" },
    });
    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow,
      completedStepIds: ["scan"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: {
        repoEvidence: { files: ["src/index.ts"] },
      },
      envelopes: {
        repoEvidence: envelope,
      },
      eventSequence: 8,
    });

    expect(checkpoint.contextSnapshot.repoEvidence.artifactId).toBe(envelope.artifactId);
    expect(checkpoint.contextSnapshot.repoEvidence.payload).toEqual({
      files: ["README.md"],
    });
  });
});

function testWorkflow(): WorkbenchWorkflow {
  return {
    id: "read-current-project",
    title: "Test workflow",
    triggerExamples: [],
    goal: "Test durable checkpoints",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "code"],
    currentSupport: "partial",
    safetyNotes: [],
    steps: [
      {
        id: "inspect",
        title: "Inspect",
        agentKind: "code",
        input: "workspace",
        output: "diff preview",
        permissionLevel: "read",
        dependsOn: [],
        canRunInParallel: false,
      },
    ],
  };
}

describe("buildCheckpointFromDagState", () => {
  it("builds a stable plan hash for semantically identical step orderings", () => {
    const stepsA = testWorkflow().steps;
    const stepsB = [
      { ...stepsA[0], dependsOn: [...(stepsA[0]?.dependsOn ?? [])] },
    ];

    expect(computePlanHash(stepsA)).toBe(computePlanHash(stepsB));
  });

  it("changes the plan hash when execution-significant fields change", () => {
    const [baseStep] = testWorkflow().steps;
    const baseHash = computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "read",
      canRunInParallel: false,
    }]);

    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "diffPreview",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "read",
      canRunInParallel: false,
    }])).not.toBe(baseHash);
    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "confirmed_write",
      canRunInParallel: false,
    }])).not.toBe(baseHash);
    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["diffPreview"],
      permissionLevel: "read",
      canRunInParallel: false,
    }])).not.toBe(baseHash);
    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "read",
      canRunInParallel: true,
    }])).not.toBe(baseHash);
  });

  it("preserves artifact envelopes supplied through contextSnapshot", () => {
    const envelope = createArtifactEnvelope(
      { changedFiles: ["src/a.ts"], diff: "patch" },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "inspect", agentKind: "code" },
        sensitivity: "workspace",
      },
    );

    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow: testWorkflow(),
      completedStepIds: ["inspect"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: {
        diffPreview: envelope,
        legacyRawValue: { omitted: true },
      },
      eventSequence: 5,
    });

    expect(checkpoint.contextSnapshot.diffPreview).toBe(envelope);
    expect(checkpoint.contextSnapshot.legacyRawValue?.payload).toEqual({ omitted: true });
  });

  it("lets explicit envelopes override matching contextSnapshot envelopes", () => {
    const original = createArtifactEnvelope(
      { diff: "old" },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "inspect" },
      },
    );
    const replacement = createArtifactEnvelope(
      { diff: "new" },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "inspect-retry" },
      },
    );

    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow: testWorkflow(),
      completedStepIds: ["inspect"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: { diffPreview: original },
      envelopes: { diffPreview: replacement },
      eventSequence: 6,
    });

    expect(checkpoint.contextSnapshot.diffPreview).toEqual(replacement);
  });
});
