import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_CONTEXT_REFERENCES, type TaskSnapshot } from "@javis/core";
import {
  extractAtReferences,
  resolveContinuationTask,
  resolveVisionBridgeRuntimeMode,
} from "./submission-routing";

describe("extractAtReferences", () => {
  it("combines bracket and bare references while deduplicating normalized paths", () => {
    expect(extractAtReferences("Use @[docs/My Report.md], @docs/other.md and @DOCS\\OTHER.MD"))
      .toEqual([
        { raw: "@[docs/My Report.md]", path: "docs/My Report.md" },
        { raw: "@docs/other.md", path: "docs/other.md" },
      ]);
  });

  it("bounds the number of files read for one submission", () => {
    const goal = Array.from(
      { length: MAX_DOCUMENT_CONTEXT_REFERENCES + 3 },
      (_, index) => `@docs/${index}.md`,
    ).join(" ");

    expect(extractAtReferences(goal)).toHaveLength(MAX_DOCUMENT_CONTEXT_REFERENCES);
  });
});

describe("resolveVisionBridgeRuntimeMode", () => {
  it("keeps project mode on Commander even when Vision Bridge runs", () => {
    expect(resolveVisionBridgeRuntimeMode("project", true)).toBe("project");
  });

  it("keeps chat bridge behavior outside project mode", () => {
    expect(resolveVisionBridgeRuntimeMode("chat", true)).toBe("chat");
    expect(resolveVisionBridgeRuntimeMode(undefined, true)).toBe("chat");
    expect(resolveVisionBridgeRuntimeMode("project", false)).toBe("project");
    expect(resolveVisionBridgeRuntimeMode(undefined, false)).toBeUndefined();
  });
});

describe("resolveContinuationTask", () => {
  it("prefers the current complete task over a truncated history mirror", () => {
    const currentTask = createContinuationTask(
      "task-long-conversation",
      Array.from({ length: 202 }, (_, index) => `current-${index}`),
    );
    const historyTask = createContinuationTask(
      "task-long-conversation",
      Array.from({ length: 200 }, (_, index) => `history-${index}`),
    );

    const continuationTask = resolveContinuationTask({
      activeHistoryEntryId: currentTask.id,
      canContinueHistory: true,
      currentTask,
      history: [historyTask],
    });

    expect(continuationTask).toBe(currentTask);
    expect(continuationTask?.conversationMessages?.[201]?.content).toBe("current-201");
  });

  it("uses queued or separately selected history tasks when appropriate", () => {
    const currentTask = createContinuationTask("task-current", ["current"]);
    const selectedHistoryTask = createContinuationTask("task-history", ["history"]);
    const queuedTask = createContinuationTask("task-queued", ["queued"]);

    expect(resolveContinuationTask({
      activeHistoryEntryId: selectedHistoryTask.id,
      canContinueHistory: true,
      currentTask,
      history: [selectedHistoryTask],
    })).toBe(selectedHistoryTask);
    expect(resolveContinuationTask({
      activeHistoryEntryId: selectedHistoryTask.id,
      canContinueHistory: true,
      currentTask,
      history: [selectedHistoryTask],
      queuedContinuationTask: queuedTask,
    })).toBe(queuedTask);
    expect(resolveContinuationTask({
      canContinueHistory: false,
      currentTask,
      history: [selectedHistoryTask],
    })).toBeUndefined();
  });
});

function createContinuationTask(id: string, contents: string[]): TaskSnapshot {
  return {
    id,
    title: "Conversation",
    userGoal: contents[contents.length - 1] ?? "Continue",
    status: "completed",
    commanderMessage: "Done.",
    plan: [],
    agents: [],
    logs: [],
    conversationMessages: contents.map((content, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content,
    })),
  };
}
