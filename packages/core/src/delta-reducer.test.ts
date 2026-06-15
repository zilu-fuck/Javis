import { describe, expect, it } from "vitest";
import { createDeltaReducer, createInitialTaskSnapshot } from "./index";

describe("createDeltaReducer streaming metadata", () => {
  it("tracks the active streaming agent and clears it on completion", () => {
    const reducer = createDeltaReducer(createInitialTaskSnapshot());

    reducer.apply({
      kind: "agent.chunk_start",
      taskId: "task-1",
      agentKind: "verifier",
    });
    const streaming = reducer.apply({
      kind: "agent.chunk",
      taskId: "task-1",
      agentKind: "verifier",
      text: "checking",
    });

    expect(streaming.isStreaming).toBe(true);
    expect(streaming.streamingAgentKind).toBe("verifier");
    expect(streaming.streamingText).toBe("checking");

    const completed = reducer.apply({
      kind: "agent.chunk_end",
      taskId: "task-1",
      agentKind: "verifier",
      fullText: "verified",
    });

    expect(completed.isStreaming).toBe(false);
    expect(completed.streamingAgentKind).toBeUndefined();
    expect(completed.streamingText).toBeUndefined();
    expect(completed.verificationSummary).toBe("verified");
  });
});

describe("createDeltaReducer step.failed", () => {
  it("updates step status to failed when step.failed is applied", () => {
    const snapshot = createInitialTaskSnapshot();
    snapshot.plan = [
      {
        id: "step-1",
        title: "Read files",
        assignedAgentKind: "file",
        status: "completed",
      },
      {
        id: "step-2",
        title: "Run command",
        assignedAgentKind: "shell",
        status: "running",
      },
      {
        id: "step-3",
        title: "Verify",
        assignedAgentKind: "verifier",
        status: "pending",
      },
    ];
    const reducer = createDeltaReducer(snapshot);

    const result = reducer.apply({
      kind: "step.failed",
      taskId: "task-1",
      stepId: "step-2",
      error: "Command exited with code 1",
    });

    const step1 = result.plan.find((s) => s.id === "step-1");
    const step2 = result.plan.find((s) => s.id === "step-2");
    const step3 = result.plan.find((s) => s.id === "step-3");

    expect(step1?.status).toBe("completed");
    expect(step2?.status).toBe("failed");
    expect(step3?.status).toBe("pending");
  });

  it("adds a log entry for step.failed", () => {
    const snapshot = createInitialTaskSnapshot();
    snapshot.plan = [
      {
        id: "step-1",
        title: "Build",
        assignedAgentKind: "code",
        status: "running",
      },
    ];
    const reducer = createDeltaReducer(snapshot);

    const result = reducer.apply({
      kind: "step.failed",
      taskId: "task-1",
      stepId: "step-1",
      error: "Build failed: missing dependency",
    });

    const failedLog = result.logs.find((log) => log.title === "step.failed");
    expect(failedLog).toBeDefined();
    expect(failedLog?.stepId).toBe("step-1");
    expect(failedLog?.detail).toBe("Build failed: missing dependency");
  });

  it("does not affect other steps when one step fails", () => {
    const snapshot = createInitialTaskSnapshot();
    snapshot.plan = [
      {
        id: "step-a",
        title: "Step A",
        assignedAgentKind: "file",
        status: "completed",
      },
      {
        id: "step-b",
        title: "Step B",
        assignedAgentKind: "shell",
        status: "running",
      },
    ];
    const reducer = createDeltaReducer(snapshot);

    const result = reducer.apply({
      kind: "step.failed",
      taskId: "task-1",
      stepId: "step-b",
      error: "timeout",
    });

    expect(result.plan.find((s) => s.id === "step-a")?.status).toBe("completed");
    expect(result.plan.find((s) => s.id === "step-b")?.status).toBe("failed");
  });
});
