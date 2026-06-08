import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_EVENT_KINDS,
  isAgentRunEvent,
  taskEventToLogEntry,
  type TaskRuntimeEvent,
} from "./task-event-bus";

describe("taskEventToLogEntry", () => {
  it("returns product text and developer detail for step events", () => {
    const log = taskEventToLogEntry({
      kind: "step.completed",
      taskId: "task-1",
      stepId: "step-a",
      summary: "Step completed in 24ms",
    });

    expect(log.userMessage).toBe("step-a 完成");
    expect(log.devDetail).toBe("Step completed in 24ms");
    expect(log.stepId).toBe("step-a");
  });

  it("links agent events to explicit agent ids", () => {
    const log = taskEventToLogEntry({
      kind: "agent.status",
      taskId: "task-1",
      agentKind: "code",
      status: "running",
      message: "Applying patch",
    });

    expect(log.agentId).toBe("agent-code");
  });

  it("links step events to explicit step and agent ids when agent kind is available", () => {
    const log = taskEventToLogEntry({
      kind: "step.started",
      taskId: "task-1",
      stepId: "inspect-project",
      agentKind: "shell",
    });

    expect(log.stepId).toBe("inspect-project");
    expect(log.agentId).toBe("agent-shell");
  });

  it("keeps raw errors in developer detail while shortening user text", () => {
    const log = taskEventToLogEntry({
      kind: "task.failed",
      taskId: "task-1",
      error: "first line\nstack trace line",
    });

    expect(log.userMessage).toBe("出错: first line");
    expect(log.devDetail).toBe("first line\nstack trace line");
  });

  it("identifies the full agent run event family for UI consumers", () => {
    const events: TaskRuntimeEvent[] = [
      { kind: "task.created", taskId: "task-1" },
      { kind: "agent.status", taskId: "task-1", agentKind: "commander", status: "running", message: "Planning" },
      { kind: "agent.chunk_start", taskId: "task-1", agentKind: "commander" },
      { kind: "agent.chunk", taskId: "task-1", agentKind: "commander", text: "Hello" },
      { kind: "agent.chunk_end", taskId: "task-1", agentKind: "commander", fullText: "Hello" },
      { kind: "step.started", taskId: "task-1", stepId: "step-1" },
      { kind: "step.progress", taskId: "task-1", stepId: "step-1", percent: 50, detail: "Halfway" },
      { kind: "step.completed", taskId: "task-1", stepId: "step-1", summary: "Done" },
      { kind: "tool.planned", taskId: "task-1", toolName: "file.scanMarkdownDocuments", detail: "Scan" },
      { kind: "tool.completed", taskId: "task-1", toolName: "file.scanMarkdownDocuments", detail: "Scanned" },
      { kind: "tool.partial", taskId: "task-1", toolCallId: "tool-1", partialOutput: "partial" },
      {
        kind: "permission.requested",
        taskId: "task-1",
        request: {
          id: "permission-1",
          level: "confirmed_write",
          title: "Approve",
          reason: "Needs confirmation.",
          dryRun: {
            operation: "test",
            affectedPaths: [],
            riskSummary: "No write in test.",
            reversible: true,
          },
          status: "pending",
          createdAt: "2026-06-07T00:00:00.000Z",
        },
      },
      { kind: "permission.resolved", taskId: "task-1", requestId: "permission-1", decision: "approved" },
      {
        kind: "ask_user.requested",
        taskId: "task-1",
        question: {
          id: "ask-1",
          question: "Pick one",
          status: "pending",
          createdAt: "2026-06-07T00:00:00.000Z",
        },
      },
      { kind: "ask_user.responded", taskId: "task-1", requestId: "ask-1", answer: "A" },
      { kind: "task.completed", taskId: "task-1", detail: "Done" },
      { kind: "task.failed", taskId: "task-1", error: "Failed" },
    ];

    expect(AGENT_RUN_EVENT_KINDS).toHaveLength(events.length);
    expect(events.every(isAgentRunEvent)).toBe(true);
  });
});
