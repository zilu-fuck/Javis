import type {
  WorkbenchAgentSessionContext,
  WorkbenchTerminalSession,
} from "@javis/ui";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export const TERMINAL_CREATE_AUDIT_TOOL_NAME = "terminal.create";
export const TERMINAL_INPUT_AUDIT_TOOL_NAME = "terminal.input";

export interface TerminalApprovalPreview {
  terminalId?: string;
  workspaceRoot?: string;
  shell?: string;
  inputBytes?: number;
  inputHash?: string;
  sendsEnter?: boolean;
}

export interface TerminalPlanResult {
  approvalId: string;
  toolName: string;
  action: "create" | "input";
  previewHash: string;
  preview: TerminalApprovalPreview;
}

export function createTerminalPlanAuditRecord(
  session: WorkbenchAgentSessionContext,
  plan: TerminalPlanResult,
  recordedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createTerminalAuditId(session, plan.approvalId, "plan"),
    taskId: auditTaskId(session),
    toolName: plan.toolName,
    permissionLevel: "confirmed_write",
    status: "waiting_permission",
    inputSummary: terminalPlanSummary(plan),
    dryRunJson: JSON.stringify({
      action: plan.action,
      previewHash: plan.previewHash,
      preview: plan.preview,
    }),
    permissionRequestId: plan.approvalId,
    startedAt: recordedAt,
  };
}

export function createTerminalCreateExecutionAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  result: WorkbenchTerminalSession,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createTerminalAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: TERMINAL_CREATE_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: `Execute approved terminal.create for ${result.terminalId}`,
    outputSummary: `Created terminal in ${result.cwd} using ${result.shell}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
  };
}

export function createTerminalInputExecutionAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  plan: TerminalPlanResult,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createTerminalAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: TERMINAL_INPUT_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: terminalPlanSummary(plan),
    outputSummary: `Sent ${plan.preview.inputBytes ?? 0} byte(s) to terminal ${plan.preview.terminalId ?? "(unknown)"}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
  };
}

export function createTerminalFailedAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  toolName: string,
  error: unknown,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createTerminalAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName,
    permissionLevel: "confirmed_write",
    status: "failed",
    inputSummary: `Execute approved ${toolName} ${approvalId}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
    errorJson: JSON.stringify({ message: errorMessage(error) }),
  };
}

function terminalPlanSummary(plan: TerminalPlanResult): string {
  if (plan.action === "create") {
    return `Prepare terminal.create for ${plan.preview.terminalId ?? "(new terminal)"} in ${plan.preview.workspaceRoot ?? "(unknown workspace)"}`;
  }
  return [
    `Prepare terminal.input for ${plan.preview.terminalId ?? "(unknown terminal)"}`,
    `${plan.preview.inputBytes ?? 0} byte(s)`,
    `hash ${plan.preview.inputHash ?? "(unknown)"}`,
    plan.preview.sendsEnter ? "sends enter" : "no enter",
  ].join(", ");
}

function createTerminalAuditId(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  phase: "plan" | "execute",
): string {
  return `${auditTaskId(session)}:terminal:${approvalId}:${phase}`;
}

function auditTaskId(session: WorkbenchAgentSessionContext): string {
  return session.taskId || session.sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
