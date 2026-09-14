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

  it("does not overwrite an existing reply with an empty chunk end", () => {
    const initial = createInitialTaskSnapshot();
    initial.commanderMessage = "已有回复";
    const reducer = createDeltaReducer(initial);

    const result = reducer.apply({
      kind: "agent.chunk_end",
      taskId: "task-1",
      agentKind: "commander",
      fullText: "",
    });

    expect(result.commanderMessage).toBe("已有回复");
    expect(result.isStreaming).toBe(false);
  });

  it("preserves an in-flight agent runtime stream across full snapshot emits", () => {
    const reducer = createDeltaReducer(createInitialTaskSnapshot());
    reducer.apply({
      kind: "agent.chunk_start",
      taskId: "task-1",
      agentKind: "research",
    });
    reducer.apply({
      kind: "agent.chunk",
      taskId: "task-1",
      agentKind: "research",
      text: "partial ",
    });

    // Executor full snapshot emits never carry agent runtime streaming state.
    reducer.syncFrom(createInitialTaskSnapshot());

    const synced = reducer.apply({
      kind: "agent.chunk",
      taskId: "task-1",
      agentKind: "research",
      text: "thought",
    });
    expect(synced.isStreaming).toBe(true);
    expect(synced.streamingAgentKind).toBe("research");
    expect(synced.streamingText).toBe("partial thought");

    const ended = reducer.apply({
      kind: "agent.chunk_end",
      taskId: "task-1",
      agentKind: "research",
      fullText: "partial thought",
    });
    expect(ended.isStreaming).toBe(false);
    expect(ended.streamingAgentKind).toBeUndefined();
    expect(ended.streamingText).toBeUndefined();
  });

  it("tracks reasoning segments separately from answer text", () => {
    const reducer = createDeltaReducer(createInitialTaskSnapshot());

    reducer.apply({
      kind: "agent.reasoning_chunk_start",
      taskId: "task-1",
      agentKind: "research",
    });
    const thinking = reducer.apply({
      kind: "agent.reasoning_chunk",
      taskId: "task-1",
      agentKind: "research",
      text: "pondering",
    });
    expect(thinking.streamingReasoningText).toBe("pondering");
    expect(thinking.streamingReasoningAgentKind).toBe("research");
    expect(thinking.isStreaming).toBe(true);

    const answering = reducer.apply({
      kind: "agent.chunk",
      taskId: "task-1",
      agentKind: "research",
      text: "answer",
    });
    expect(answering.streamingText).toBe("answer");
    expect(answering.streamingReasoningText).toBe("pondering");

    const reasoningEnded = reducer.apply({
      kind: "agent.reasoning_chunk_end",
      taskId: "task-1",
      agentKind: "research",
      fullText: "pondering",
    });
    expect(reasoningEnded.streamingReasoningText).toBeUndefined();
    expect(reasoningEnded.streamingReasoningAgentKind).toBeUndefined();
    expect(reasoningEnded.streamingText).toBe("answer");

    const answerEnded = reducer.apply({
      kind: "agent.chunk_end",
      taskId: "task-1",
      agentKind: "research",
      fullText: "answer",
    });
    expect(answerEnded.isStreaming).toBe(false);
    expect(answerEnded.streamingText).toBeUndefined();
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

describe("reasoning digest durability", () => {
  function applyReasoning(reducer: ReturnType<typeof createDeltaReducer>, text: string) {
    reducer.apply({ kind: "agent.reasoning_chunk_start", taskId: "task-r", agentKind: "commander" });
    reducer.apply({ kind: "agent.reasoning_chunk", taskId: "task-r", agentKind: "commander", text });
    return reducer.apply({ kind: "agent.reasoning_chunk_end", taskId: "task-r", agentKind: "commander", fullText: text });
  }

  it("keeps a redacted digest after the live stream is gone", () => {
    const reducer = createDeltaReducer(createInitialTaskSnapshot());
    const snapshot = applyReasoning(reducer, "先确认格式，再看文件名。api_key: sk-abcdefgh12345678 不该留存。");
    expect(snapshot.streamingReasoningText).toBeUndefined();
    expect(snapshot.reasoningDigest).toContain("先确认格式");
    expect(snapshot.reasoningDigest).not.toContain("sk-abcdefgh12345678");
    expect(snapshot.reasoningDigestAgentKind).toBe("commander");
  });

  it("exposes the digest as a readable log line", () => {
    const reducer = createDeltaReducer(createInitialTaskSnapshot());
    const snapshot = applyReasoning(reducer, "需要先读目录结构。");
    expect(snapshot.logs.some((log) => log.userMessage?.includes("需要先读目录结构"))).toBe(true);
  });

  it("keeps the previous digest when a stream produced nothing usable", () => {
    const reducer = createDeltaReducer(createInitialTaskSnapshot());
    applyReasoning(reducer, "第一段思考。");
    const snapshot = applyReasoning(reducer, "   ");
    expect(snapshot.reasoningDigest).toBe("第一段思考。");
  });
});
