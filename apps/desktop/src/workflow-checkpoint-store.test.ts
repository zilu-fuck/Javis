import { describe, expect, it } from "vitest";
import { computeContentHash, computePlanHash, createArtifactEnvelope, type WorkflowCheckpoint } from "@javis/core";
import type { DesktopDatabase, DatabaseValue } from "./desktop-database";
import { createWorkflowCheckpointStore, sanitizeWorkflowCheckpoint } from "./workflow-checkpoint-store";

describe("workflow checkpoint store", () => {
  it("sanitizes artifact payloads before persisting checkpoint JSON", async () => {
    const writes: Array<{ sql: string; bindValues?: DatabaseValue[] }> = [];
    const database: DesktopDatabase = {
      async execute(sql, bindValues) {
        writes.push({ sql, bindValues });
      },
      async select<T extends Record<string, unknown>>() {
        return [] as T[];
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
      computeContentHash("[redacted:secret]"),
    );
    expect(persisted.contextSnapshot.secretResult?.sourceContentHash).toBe(
      checkpoint.contextSnapshot.secretResult?.contentHash,
    );
  });

  it("orders task checkpoints globally by creation time across runs", async () => {
    const older = {
      ...createCheckpoint({}),
      runId: "run-older",
      eventSequence: 99,
      createdAt: "2026-06-16T00:00:00.000Z",
    };
    const newer = {
      ...createCheckpoint({}),
      runId: "run-newer",
      eventSequence: 1,
      createdAt: "2026-06-16T00:01:00.000Z",
    };
    const selects: string[] = [];
    const deletes: string[] = [];
    const database: DesktopDatabase = {
      async execute(_sql, bindValues) {
        if (typeof bindValues?.[0] === "string") deletes.push(bindValues[0]);
      },
      async select<T extends Record<string, unknown>>(sql: string) {
        selects.push(sql);
        if (sql.startsWith("SELECT checkpoint_id")) {
          return [
            { checkpoint_id: "checkpoint-newer" },
            { checkpoint_id: "checkpoint-older" },
          ] as unknown as T[];
        }
        return [
          { checkpoint_json: JSON.stringify(newer) },
          { checkpoint_json: JSON.stringify(older) },
        ] as unknown as T[];
      },
    };

    const store = createWorkflowCheckpointStore(database);
    const loaded = await store.latestByTaskId("task-1");
    const listed = await store.listByTaskId("task-1", 10);
    const pruned = await store.pruneByTaskId("task-1", 1);

    expect(loaded?.runId).toBe("run-newer");
    expect(loaded?.eventSequence).toBe(1);
    expect(listed.map((checkpoint) => checkpoint.runId)).toEqual(["run-newer", "run-older"]);
    expect(pruned).toBe(1);
    expect(deletes).toEqual(["checkpoint-older"]);
    expect(selects).toEqual([
      "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      "SELECT checkpoint_id FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC",
    ]);
  });

  it("rejects unknown, overlapping, or omitted checkpoint step state", () => {
    const checkpoint = createCheckpoint({});

    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      completedStepIds: ["unknown-step"],
    })).toBeUndefined();
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      pendingStepIds: ["verify"],
    })).toBeUndefined();
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      completedStepIds: [],
    })).toBeUndefined();
  });
});

function createCheckpoint(
  contextSnapshot: WorkflowCheckpoint["contextSnapshot"],
): WorkflowCheckpoint {
  const steps: WorkflowCheckpoint["workflowSnapshot"]["steps"] = [{
    id: "verify",
    title: "Verify",
    agentKind: "verifier",
    input: "evidence",
    output: "verification",
    permissionLevel: "read",
    dependsOn: [],
    canRunInParallel: false,
  }];
  return {
    taskId: "task-1",
    runId: "run-1",
    workflowId: "commander-dag",
    workflowVersion: 1,
    planHash: computePlanHash(steps),
    workflowSnapshot: {
      id: "commander-dag" as never,
      title: "Commander DAG",
      triggerExamples: [],
      goal: "test",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander", "verifier"],
      currentSupport: "partial",
      safetyNotes: [],
      steps,
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
