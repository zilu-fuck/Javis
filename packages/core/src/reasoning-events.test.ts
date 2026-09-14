import { describe, expect, it } from "vitest";
import { createReasoningStreamForwarder } from "./reasoning-events";
import { createTaskEventBus } from "./task-event-bus";

function collectEvents() {
  const eventBus = createTaskEventBus();
  const seen: Array<{ kind: string; text?: string; fullText?: string }> = [];
  eventBus.on((event) => {
    if (event.kind.startsWith("agent.reasoning_chunk")) {
      seen.push({
        kind: event.kind,
        ...(event.kind === "agent.reasoning_chunk" ? { text: event.text } : {}),
        ...(event.kind === "agent.reasoning_chunk_end" ? { fullText: event.fullText } : {}),
      });
    }
  });
  return { eventBus, seen };
}

describe("reasoning stream forwarder", () => {
  it("emits start, one chunk per delta, and an end carrying the full text", () => {
    const { eventBus, seen } = collectEvents();
    const forwarder = createReasoningStreamForwarder({ eventBus, taskId: "task-1", agentKind: "commander" });

    forwarder.push({ reasoning: "先确认" });
    forwarder.push({ reasoning: "产物格式。" });
    forwarder.close();

    expect(seen).toEqual([
      { kind: "agent.reasoning_chunk_start" },
      { kind: "agent.reasoning_chunk", text: "先确认" },
      { kind: "agent.reasoning_chunk", text: "产物格式。" },
      { kind: "agent.reasoning_chunk_end", fullText: "先确认产物格式。" },
    ]);
  });

  it("ends the segment as soon as the answer starts", () => {
    const { eventBus, seen } = collectEvents();
    const forwarder = createReasoningStreamForwarder({ eventBus, taskId: "task-1", agentKind: "commander" });

    forwarder.push({ reasoning: "想一下" });
    forwarder.push({ text: "这是答案" });
    forwarder.close();

    expect(seen.map((event) => event.kind)).toEqual([
      "agent.reasoning_chunk_start",
      "agent.reasoning_chunk",
      "agent.reasoning_chunk_end",
    ]);
    expect(seen[2].fullText).toBe("想一下");
  });

  it("emits nothing when the provider streams no reasoning", () => {
    const { eventBus, seen } = collectEvents();
    const forwarder = createReasoningStreamForwarder({ eventBus, taskId: "task-1", agentKind: "commander" });

    forwarder.push({ text: "只有答案" });
    forwarder.close();

    expect(seen).toEqual([]);
  });

  it("closes a dangling segment with the error instead of dropping the text", () => {
    const { eventBus, seen } = collectEvents();
    const forwarder = createReasoningStreamForwarder({ eventBus, taskId: "task-1", agentKind: "commander" });

    forwarder.push({ reasoning: "中断前的思考" });
    forwarder.close("stream aborted");

    expect(seen[seen.length - 1]).toEqual({ kind: "agent.reasoning_chunk_end", fullText: "中断前的思考" });
    expect(seen).toHaveLength(3);
  });

  it("stays inert without an event bus", () => {
    const forwarder = createReasoningStreamForwarder({ taskId: "task-1", agentKind: "commander" });
    expect(() => {
      forwarder.push({ reasoning: "x" });
      forwarder.close();
    }).not.toThrow();
  });

  it("is safe to close twice", () => {
    const { eventBus, seen } = collectEvents();
    const forwarder = createReasoningStreamForwarder({ eventBus, taskId: "task-1", agentKind: "commander" });
    forwarder.push({ reasoning: "一次" });
    forwarder.close();
    forwarder.close();
    expect(seen.filter((event) => event.kind === "agent.reasoning_chunk_end")).toHaveLength(1);
  });
});
