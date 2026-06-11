import { describe, expect, it } from "vitest";
import type { TaskSnapshot } from "@javis/core";
import { createCanonicalWorkspaceId } from "./agent-memory";
import { createAgentSessionSummaryFromTask } from "./agent-session-summary";

describe("agent session summary", () => {
  it("creates a compact summary for terminal tasks without tool log details", () => {
    const summary = createAgentSessionSummaryFromTask({
      ...createTask("task-1000", "completed"),
      userGoal: "对照文档实现 Javis Agent memory",
      commanderMessage: "已完成数据库和只读检索。",
      workspacePath: "E:/Javis",
      verificationSummary: "verified: tests passed",
      logs: [{
        id: "log-1",
        kind: "tool",
        title: "tool_call.updated",
        detail: "SECRET_TOOL_OUTPUT should not be summarized",
      }],
      commands: [{
        command: "git diff",
        cwd: "E:/Javis",
        exitCode: 0,
        stdout: "SECRET_COMMAND_STDOUT",
        stderr: "",
      }],
      conversationMessages: [
        { role: "user", content: "对照文档实现 Javis Agent memory" },
        { role: "assistant", content: "已完成数据库和只读检索。" },
      ],
    }, "E:/Fallback");

    expect(summary).toMatchObject({
      id: "summary:task-1000",
      sessionId: "task-1000",
      workspaceId: createCanonicalWorkspaceId("E:/Javis"),
      importantPoints: [
        "User goal: 对照文档实现 Javis Agent memory",
        "Verification: verified: tests passed",
      ],
    });
    expect(summary?.summary).toContain("对照文档实现 Javis Agent memory");
    expect(summary?.summary).toContain("已完成数据库和只读检索。");
    expect(JSON.stringify(summary)).not.toContain("SECRET_TOOL_OUTPUT");
    expect(JSON.stringify(summary)).not.toContain("SECRET_COMMAND_STDOUT");
  });

  it("does not summarize non-terminal tasks", () => {
    expect(createAgentSessionSummaryFromTask(createTask("task-1", "running"), "E:/Javis")).toBeNull();
  });

  it("records failed task open threads without copying logs", () => {
    const summary = createAgentSessionSummaryFromTask({
      ...createTask("task-failed", "failed"),
      userGoal: "继续实现记忆功能",
      commanderMessage: "任务失败。",
      userFacingError: "需要重新运行数据库迁移",
      logs: [{
        id: "log-1",
        kind: "tool",
        title: "migration",
        detail: "FULL_MIGRATION_LOG_SHOULD_NOT_APPEAR",
      }],
    }, "E:/Javis");

    expect(summary?.openThreads).toEqual(["Error to revisit: 需要重新运行数据库迁移"]);
    expect(JSON.stringify(summary)).not.toContain("FULL_MIGRATION_LOG_SHOULD_NOT_APPEAR");
  });
});

function createTask(id: string, status: TaskSnapshot["status"]): TaskSnapshot {
  return {
    id,
    title: "Task",
    userGoal: "User goal",
    status,
    commanderMessage: "Assistant response",
    plan: [],
    agents: [],
    logs: [],
  };
}
