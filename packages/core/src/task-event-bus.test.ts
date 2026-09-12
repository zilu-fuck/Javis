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

    expect(log.userMessage).toBe("这一步已完成。");
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

  it("maps task.diagnostic events to inspector log entries", () => {
    const log = taskEventToLogEntry({
      kind: "task.diagnostic",
      taskId: "task-1",
      code: "cache.prefix_broken",
      label: "Cache prefix broken",
      detail: "scope=chat:task-1; item 1 changed",
      agentKind: "commander",
    });

    expect(log.kind).toBe("event");
    expect(log.title).toBe("cache.prefix_broken");
    expect(log.userMessage).toBe("Cache prefix broken: scope=chat:task-1; item 1 changed");
    expect(log.detail).toContain("scope=chat:task-1");
    expect(log.agentId).toBe("agent-commander");
  });

  it("does not call an empty or failed stream a completed reply", () => {
    const empty = taskEventToLogEntry({
      kind: "agent.chunk_end",
      taskId: "task-1",
      agentKind: "commander",
      fullText: "",
    });
    const failed = taskEventToLogEntry({
      kind: "agent.chunk_end",
      taskId: "task-1",
      agentKind: "commander",
      fullText: "partial",
      error: "provider unavailable",
    });

    expect(empty.userMessage).toBe("回复生成结束（无正文）");
    expect(empty.userMessage).not.toBe("回复生成完成");
    expect(failed.userMessage).toContain("回复生成失败");
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

  it("omits absent optional ownership fields from lifecycle logs", () => {
    const events = [
      {
        kind: "task.waiting",
        taskId: "task-1",
        phase: "waiting_model",
        label: "Commander plan",
        detail: "Waiting for Commander to generate a DAG plan.",
      },
      {
        kind: "task.timeout",
        taskId: "task-1",
        phase: "waiting_model",
        label: "Commander plan",
        timeoutMs: 90_000,
        detail: "Commander planning timed out.",
      },
      {
        kind: "task.cancelled",
        taskId: "task-1",
        label: "Commander plan",
        detail: "Commander planning was cancelled.",
      },
    ] satisfies TaskRuntimeEvent[];

    for (const event of events) {
      const log = taskEventToLogEntry(event);
      expect(Object.prototype.hasOwnProperty.call(log, "agentId")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(log, "stepId")).toBe(false);
    }
  });

  it("links permission logs to explicit step and tool owners without changing detail", () => {
    const requested = taskEventToLogEntry({
      kind: "permission.requested",
      taskId: "task-1",
      stepId: "write-report",
      toolName: "file.writeText",
      previewHash: "dryrun-fnv1a-12345678",
      request: {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve",
        reason: "Needs confirmation.",
        dryRun: {
          operation: "file.writeText",
          affectedPaths: [],
          riskSummary: "Writes a report.",
          reversible: true,
        },
        status: "pending",
        createdAt: "2026-06-07T00:00:00.000Z",
      },
    });
    const resolved = taskEventToLogEntry({
      kind: "permission.resolved",
      taskId: "task-1",
      stepId: "write-report",
      toolName: "file.writeText",
      previewHash: "dryrun-fnv1a-12345678",
      requestId: "permission-1",
      decision: "approved",
    });

    expect(requested).toMatchObject({
      stepId: "write-report",
      agentId: "agent-file",
    });
    expect(requested.devDetail).toBe("Needs confirmation.");
    expect(resolved).toMatchObject({
      stepId: "write-report",
      agentId: "agent-file",
    });
    expect(resolved.devDetail).toBe("Permission permission-1 was approved.");
  });

  it("keeps tool lifecycle identity and failure state in Inspector logs", () => {
    const started = taskEventToLogEntry({
      kind: "tool.started",
      taskId: "task-1",
      toolName: "grep",
      toolCallId: "call-1",
      stepId: "inspect-code",
      agentKind: "code",
      agentRunId: "agent-run-1",
      attempt: 2,
      backendSessionId: "opencode-session-1",
      detail: "Started grep (call-1).",
    });
    const failed = taskEventToLogEntry({
      kind: "tool.failed",
      taskId: "task-1",
      toolName: "grep",
      toolCallId: "call-1",
      stepId: "inspect-code",
      agentKind: "code",
      reason: "No matches.",
      detail: "grep (call-1) failed: No matches.",
    });

    expect(started).toMatchObject({
      id: "task-1-tool-grep-call-1-started",
      title: "tool_call.started",
      agentId: "agent-code",
      stepId: "inspect-code",
    });
    expect(failed).toMatchObject({
      id: "task-1-tool-grep-call-1-failed",
      title: "tool_call.failed",
      agentId: "agent-code",
      stepId: "inspect-code",
    });
  });

  it("keeps raw errors in developer detail without exposing multiline internals", () => {
    const log = taskEventToLogEntry({
      kind: "task.failed",
      taskId: "task-1",
      error: "first line\nstack trace line",
    });

    expect(log.userMessage).toBe("出错: first line");
    expect(log.devDetail).toBe("first line\nstack trace line");
  });

  it("surfaces a safe rate-limit reason for multiline Commander compilation failures", () => {
    const error = [
      "Commander plan compilation failed:",
      "ERROR INVALID_EXECUTION_MODE: Repair model call failed with API rate limit 429. Bearer sk-secret-value",
      "at C:/internal/provider.ts:42:7",
    ].join("\n");
    const log = taskEventToLogEntry({
      kind: "task.failed",
      taskId: "task-1",
      error,
    });

    expect(log.userMessage).toBe("出错: Commander 计划编译失败：请求频率过高，请稍后重试。");
    expect(log.userMessage).not.toContain("C:/internal");
    expect(log.userMessage).not.toContain("sk-secret-value");
    expect(log.detail).not.toContain("sk-secret-value");
    expect(log.devDetail).not.toContain("sk-secret-value");
    expect(log.devDetail).toContain("[redacted:secret]");
  });

  it("surfaces an actionable reason for an unrepairable incomplete Commander plan", () => {
    const error = [
      "Commander plan compilation failed:",
      "ERROR MISSING_APPROVAL_TOOL_SELECTION [step=write-file]: no explicit toolName was provided.",
      "ERROR MISSING_TOOL_INPUT [step=write-file]: toolInput is incomplete.",
      "ERROR MISSING_VERIFIER [step=summary]: verifier is missing.",
    ].join("\n");
    const log = taskEventToLogEntry({
      kind: "task.failed",
      taskId: "task-1",
      error,
    });

    expect(log.userMessage).toBe(
      "出错: Commander 计划中的工具或必要输入不完整，自动修复未成功，请重试。",
    );
  });

  it("redacts credentials from replan and step failure logs", () => {
    const events: TaskRuntimeEvent[] = [
      {
        kind: "task.replan_started",
        taskId: "task-1",
        failedStepId: "step-1",
        error: "Authorization: Bearer sk-replan-secret",
      },
      {
        kind: "task.replan_failed",
        taskId: "task-1",
        failedStepId: "step-1",
        error: "api_key=sk-replan-secret",
      },
      {
        kind: "step.failed",
        taskId: "task-1",
        stepId: "step-1",
        error: "password=hunter2-secret",
      },
    ];

    for (const event of events) {
      const serialized = JSON.stringify(taskEventToLogEntry(event));
      expect(serialized).not.toContain("sk-replan-secret");
      expect(serialized).not.toContain("hunter2-secret");
      expect(serialized).toContain("[redacted:secret]");
    }
  });

  it("identifies the full agent run event family for UI consumers", () => {
    const events: TaskRuntimeEvent[] = [
      { kind: "task.created", taskId: "task-1" },
      {
        kind: "task.waiting",
        taskId: "task-1",
        phase: "waiting_model",
        label: "commander.plan",
        detail: "Waiting for Commander plan.",
      },
      {
        kind: "task.timeout",
        taskId: "task-1",
        phase: "waiting_tool",
        label: "tool dispatch step-1",
        timeoutMs: 90_000,
        detail: "Tool dispatch timed out.",
      },
      {
        kind: "task.cancelled",
        taskId: "task-1",
        label: "askUser ask-1",
        detail: "askUser cancelled.",
      },
      {
        kind: "task.replan_started",
        taskId: "task-1",
        failedStepId: "step-1",
        error: "Timed out",
      },
      {
        kind: "task.replan_failed",
        taskId: "task-1",
        failedStepId: "step-1",
        error: "Replan timed out",
      },
      { kind: "agent.status", taskId: "task-1", agentKind: "commander", status: "running", message: "Planning" },
      { kind: "agent.chunk_start", taskId: "task-1", agentKind: "commander" },
      { kind: "agent.chunk", taskId: "task-1", agentKind: "commander", text: "Hello" },
      { kind: "agent.chunk_end", taskId: "task-1", agentKind: "commander", fullText: "Hello" },
      { kind: "step.started", taskId: "task-1", stepId: "step-1" },
      { kind: "step.progress", taskId: "task-1", stepId: "step-1", percent: 50, detail: "Halfway" },
      { kind: "step.completed", taskId: "task-1", stepId: "step-1", summary: "Done" },
      { kind: "step.failed", taskId: "task-1", stepId: "step-2", error: "Build failed" },
      { kind: "tool.planned", taskId: "task-1", toolName: "file.scanMarkdownDocuments", detail: "Scan" },
      { kind: "tool.started", taskId: "task-1", toolName: "file.scanMarkdownDocuments", detail: "Scanning" },
      { kind: "tool.completed", taskId: "task-1", toolName: "file.scanMarkdownDocuments", detail: "Scanned" },
      {
        kind: "tool.failed",
        taskId: "task-1",
        toolName: "file.scanMarkdownDocuments",
        detail: "Scan failed",
        reason: "Unavailable",
      },
      { kind: "tool.partial", taskId: "task-1", toolCallId: "tool-1", partialOutput: "partial" },
      {
        kind: "permission.requested",
        taskId: "task-1",
        stepId: "step-1",
        toolName: "file.writeText",
        previewHash: "dryrun-fnv1a-12345678",
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
      {
        kind: "permission.resolved",
        taskId: "task-1",
        stepId: "step-1",
        toolName: "file.writeText",
        previewHash: "dryrun-fnv1a-12345678",
        requestId: "permission-1",
        decision: "approved",
      },
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

  it("uses stable structured titles for wait diagnostics", () => {
    expect(taskEventToLogEntry({
      kind: "task.waiting",
      taskId: "task-1",
      phase: "waiting_model",
      label: "commander.plan",
      detail: "Waiting for Commander plan.",
    }).title).toBe("waiting_model");
    expect(taskEventToLogEntry({
      kind: "task.timeout",
      taskId: "task-1",
      phase: "waiting_tool",
      label: "tool dispatch scan",
      timeoutMs: 90_000,
      detail: "Tool dispatch timed out.",
    }).title).toBe("timeout");
    expect(taskEventToLogEntry({
      kind: "task.replan_started",
      taskId: "task-1",
      failedStepId: "scan",
      error: "scan timed out",
    }).title).toBe("replan_started");
    expect(taskEventToLogEntry({
      kind: "task.replan_failed",
      taskId: "task-1",
      failedStepId: "scan",
      error: "model timed out",
    }).title).toBe("replan_failed");
  });
});
