import { describe, expect, it } from "vitest";
import {
  TERMINAL_CREATE_AUDIT_TOOL_NAME,
  TERMINAL_INPUT_AUDIT_TOOL_NAME,
  createTerminalCreateExecutionAuditRecord,
  createTerminalFailedAuditRecord,
  createTerminalInputExecutionAuditRecord,
  createTerminalPlanAuditRecord,
  type TerminalPlanResult,
} from "./terminal-audit";
import type { WorkbenchAgentSessionContext } from "@javis/ui";

describe("terminal audit records", () => {
  it("records terminal create plan and execution events", () => {
    const plan = terminalCreatePlan();
    const planRecord = createTerminalPlanAuditRecord(session(), plan, "2026-06-10T00:00:00.000Z");
    const executionRecord = createTerminalCreateExecutionAuditRecord(
      session(),
      plan.approvalId,
      { terminalId: "term-1", cwd: "E:\\Javis", shell: "powershell" },
      "2026-06-10T00:00:01.000Z",
      "2026-06-10T00:00:02.000Z",
    );

    expect(planRecord).toMatchObject({
      toolName: TERMINAL_CREATE_AUDIT_TOOL_NAME,
      permissionLevel: "confirmed_write",
      status: "waiting_permission",
      permissionRequestId: "approval-terminal-create",
    });
    expect(executionRecord).toMatchObject({
      toolName: TERMINAL_CREATE_AUDIT_TOOL_NAME,
      status: "succeeded",
      outputSummary: "Created terminal in E:\\Javis using powershell",
    });
  });

  it("records terminal input by byte count and hash without raw input text", () => {
    const plan = terminalInputPlan();
    const planRecord = createTerminalPlanAuditRecord(session(), plan, "2026-06-10T00:00:00.000Z");
    const executionRecord = createTerminalInputExecutionAuditRecord(
      session(),
      plan.approvalId,
      plan,
      "2026-06-10T00:00:01.000Z",
      "2026-06-10T00:00:02.000Z",
    );
    const serialized = JSON.stringify([planRecord, executionRecord]);

    expect(planRecord.toolName).toBe(TERMINAL_INPUT_AUDIT_TOOL_NAME);
    expect(planRecord.inputSummary).toContain("12 byte(s)");
    expect(planRecord.inputSummary).toContain("hash fnv-secret");
    expect(executionRecord.outputSummary).toContain("Sent 12 byte(s)");
    expect(serialized).not.toContain("SECRET_COMMAND");
  });

  it("records terminal failures against the approved tool", () => {
    const record = createTerminalFailedAuditRecord(
      session(),
      "approval-terminal-input",
      TERMINAL_INPUT_AUDIT_TOOL_NAME,
      new Error("write failed"),
      "2026-06-10T00:00:01.000Z",
      "2026-06-10T00:00:02.000Z",
    );

    expect(record).toMatchObject({
      toolName: TERMINAL_INPUT_AUDIT_TOOL_NAME,
      status: "failed",
      permissionRequestId: "approval-terminal-input",
    });
    expect(record.errorJson).toContain("write failed");
  });
});

function session(): WorkbenchAgentSessionContext {
  return {
    sessionId: "session-1",
    taskId: "task-1",
    workspaceRoot: "E:\\Javis",
    threadId: "thread-1",
    permissionMode: "confirmed_write",
    activeModel: "test-model",
  };
}

function terminalCreatePlan(): TerminalPlanResult {
  return {
    approvalId: "approval-terminal-create",
    toolName: TERMINAL_CREATE_AUDIT_TOOL_NAME,
    action: "create",
    previewHash: "hash-create",
    preview: {
      terminalId: "term-1",
      workspaceRoot: "E:\\Javis",
      shell: "powershell",
    },
  };
}

function terminalInputPlan(): TerminalPlanResult {
  return {
    approvalId: "approval-terminal-input",
    toolName: TERMINAL_INPUT_AUDIT_TOOL_NAME,
    action: "input",
    previewHash: "hash-input",
    preview: {
      terminalId: "term-1",
      inputBytes: 12,
      inputHash: "fnv-secret",
      sendsEnter: true,
    },
  };
}
