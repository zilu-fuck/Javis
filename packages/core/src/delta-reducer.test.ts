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
