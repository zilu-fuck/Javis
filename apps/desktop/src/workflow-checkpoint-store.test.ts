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
    const checkpoint: WorkflowCheckpoint = {
      ...createCheckpoint({
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
      }),
      agentRuntimeMetrics: [{
        backend: "langchain",
        runCount: 1,
        completedRunCount: 1,
        successRate: 1,
        totalDurationMs: 20,
        averageDurationMs: 20,
        modelCalls: 2,
        toolCalls: 1,
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      }, {
        backend: "opencode",
        runCount: 1,
        completedRunCount: 1,
        successRate: 1,
        totalDurationMs: 10,
        averageDurationMs: 10,
        modelCalls: 1,
        toolCalls: 1,
      }],
      agentRuntimeRoutingMetrics: [{
        providerId: "openai",
        agentKind: "research",
        taskType: "read",
        routeCount: 3,
        rolloutTargetCount: 3,
        langchainRouteCount: 1,
        opencodeRouteCount: 1,
        legacyRouteCount: 1,
        unavailableRouteCount: 0,
        fallbackCount: 1,
        fallbackRate: 1 / 3,
        fallbackReasons: [{ reason: "native_tool_call_unavailable", count: 1 }],
        observationIds: ["run-1:step-1", "run-1:step-2", "run-1:step-3"],
      }],
      tokenUsage: {
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
        peakContextTokens: 11,
        modelCalls: 2,
        byAgentKind: [{
          agentKind: "research",
          inputTokens: 13,
          outputTokens: 5,
          totalTokens: 18,
          modelCalls: 2,
        }],
      },
    };

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
    expect(persisted.agentRuntimeMetrics).toEqual(checkpoint.agentRuntimeMetrics);
    expect(persisted.agentRuntimeRoutingMetrics).toEqual(
      checkpoint.agentRuntimeRoutingMetrics,
    );
    expect(persisted.tokenUsage).toEqual(checkpoint.tokenUsage);
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

  it("rejects malformed or duplicate durable Agent runtime metrics", () => {
    const checkpoint = createCheckpoint({});
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      agentRuntimeMetrics: [{
        backend: "langchain",
        runCount: -1,
        completedRunCount: 0,
        successRate: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        modelCalls: 0,
        toolCalls: 0,
      }],
    })).toBeUndefined();
    const validMetrics = {
      backend: "legacy",
      runCount: 1,
      completedRunCount: 1,
      successRate: 1,
      totalDurationMs: 10,
      averageDurationMs: 10,
      modelCalls: 2,
      toolCalls: 1,
    };
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      agentRuntimeMetrics: [validMetrics, validMetrics],
    })).toBeUndefined();
  });

  it("rejects malformed or duplicate durable Agent runtime routing metrics", () => {
    const checkpoint = createCheckpoint({});
    const validMetrics = {
      providerId: "openai",
      agentKind: "research",
      taskType: "read",
      routeCount: 2,
      rolloutTargetCount: 2,
      langchainRouteCount: 1,
      legacyRouteCount: 1,
      unavailableRouteCount: 0,
      fallbackCount: 1,
      fallbackRate: 0.5,
      fallbackReasons: [{ reason: "native_tool_call_unavailable", count: 1 }],
      observationIds: ["run-1:step-1", "run-1:step-2"],
    };
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      agentRuntimeRoutingMetrics: [{
        ...validMetrics,
        fallbackRate: 0.25,
      }],
    })).toBeUndefined();
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      agentRuntimeRoutingMetrics: [validMetrics, validMetrics],
    })).toBeUndefined();
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      agentRuntimeRoutingMetrics: [{
        ...validMetrics,
        providerId: " openai",
      }],
    })).toBeUndefined();
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      agentRuntimeRoutingMetrics: [{
        ...validMetrics,
        observationIds: ["run-1:step-1", " run-1:step-1"],
      }],
    })).toBeUndefined();
  });

  it("rejects malformed or duplicate durable token usage", () => {
    const checkpoint = createCheckpoint({});
    const validUsage = {
      agentKind: "research",
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      modelCalls: 1,
    };
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      tokenUsage: {
        inputTokens: -1,
        outputTokens: 2,
        totalTokens: 1,
        modelCalls: 1,
        byAgentKind: [validUsage],
      },
    })).toBeUndefined();
    expect(sanitizeWorkflowCheckpoint({
      ...checkpoint,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        modelCalls: 2,
        byAgentKind: [validUsage, validUsage],
      },
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
