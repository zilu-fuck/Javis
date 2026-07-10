import { describe, expect, it } from "vitest";
import { createArtifactEnvelope } from "./artifact-envelope";
import { buildCheckpointFromDagState } from "./workflow-checkpoint";
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
