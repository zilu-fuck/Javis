import { describe, expect, it } from "vitest";
import { createArtifactEnvelope, type WorkflowCheckpoint } from "@javis/core";
import type { DesktopDatabase, DatabaseValue } from "./desktop-database";
import { createWorkflowCheckpointStore } from "./workflow-checkpoint-store";

describe("workflow checkpoint store", () => {
  it("sanitizes artifact payloads before persisting checkpoint JSON", async () => {
    const writes: Array<{ sql: string; bindValues?: DatabaseValue[] }> = [];
    const database: DesktopDatabase = {
      async execute(sql, bindValues) {
        writes.push({ sql, bindValues });
      },
      async select() {
        return [];
      },
    };
    const checkpoint = createCheckpoint({
      secretResult: createArtifactEnvelope(
        { apiKey: "sk-live-secret", nested: { password: "hunter2" } },
        {
          taskId: "task-1",
          runId: "run-1",
          type: "verificationResult",
          producer: { stepId: "verify", agentKind: "verifier" },
          sensitivity: "secret",
        },
      ),
    });

    await createWorkflowCheckpointStore(database).save(checkpoint);

    const checkpointJson = writes[0]?.bindValues?.[9];
    expect(typeof checkpointJson).toBe("string");
    expect(checkpointJson).not.toContain("sk-live-secret");
    expect(checkpointJson).not.toContain("hunter2");
    const persisted = JSON.parse(checkpointJson as string) as WorkflowCheckpoint;
    expect(persisted.contextSnapshot.secretResult?.payload).toBe("[redacted:secret]");
    expect(persisted.contextSnapshot.secretResult?.contentHash).toBe(
      checkpoint.contextSnapshot.secretResult?.contentHash,
    );
  });
});

function createCheckpoint(
  contextSnapshot: WorkflowCheckpoint["contextSnapshot"],
): WorkflowCheckpoint {
  return {
    taskId: "task-1",
    runId: "run-1",
    workflowId: "commander-dag",
    workflowVersion: 1,
    planHash: "plan-test",
    workflowSnapshot: {
      id: "commander-dag" as never,
      title: "Commander DAG",
      triggerExamples: [],
      goal: "test",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander", "verifier"],
      currentSupport: "partial",
      safetyNotes: [],
      steps: [],
    },
    completedStepIds: ["verify"],
    abandonedStepIds: [],
    pendingStepIds: [],
    runningStepIds: [],
    contextSnapshot,
    approvalRequestIds: [],
    eventSequence: 3,
    createdAt: "2026-06-16T00:00:00.000Z",
  };
}
