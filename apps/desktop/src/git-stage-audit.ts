import type {
  GitStageExecutionQuickResult,
  GitStagePlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";
import { createDryRunBindingHash } from "@javis/core";
import type { PermissionRequest } from "@javis/tools";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export const GIT_STAGE_AUDIT_TOOL_NAME = "git.stageFiles";
export const GIT_STAGE_APPROVAL_TITLE = "Approve Git stage";

export function createGitStagePlanAuditRecord(
  session: WorkbenchAgentSessionContext,
  plan: GitStagePlanQuickResult,
  recordedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitStageAuditId(session, plan.approvalId, "plan"),
    taskId: auditTaskId(session),
    toolName: GIT_STAGE_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "waiting_permission",
    inputSummary: `Prepare Git stage for ${plan.preview.files.length} file(s)`,
    dryRunJson: JSON.stringify(plan.preview.dryRun),
    permissionRequestId: plan.approvalId,
    startedAt: recordedAt,
  };
}

export function createGitStagePermissionRequest(
  plan: GitStagePlanQuickResult,
  createdAt = new Date().toISOString(),
): PermissionRequest {
  return {
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: GIT_STAGE_APPROVAL_TITLE,
    reason: "Staging updates the Git index for selected workspace files.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
    bindingHash: createDryRunBindingHash(plan.preview.dryRun),
    status: "pending",
    createdAt,
  };
}

export function createGitStageExecutionAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  execution: GitStageExecutionQuickResult,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitStageAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_STAGE_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: `Execute approved Git stage for ${execution.fileCount} file(s)`,
    outputSummary: `Staged ${execution.fileCount} file(s)`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
  };
}

export function createGitStageFailedAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  error: unknown,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitStageAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_STAGE_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "failed",
    inputSummary: `Execute approved Git stage ${approvalId}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
    errorJson: JSON.stringify({ message: errorMessage(error) }),
  };
}

function createGitStageAuditId(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  phase: "plan" | "execute",
): string {
  return `${auditTaskId(session)}:${GIT_STAGE_AUDIT_TOOL_NAME}:${approvalId}:${phase}`;
}

function auditTaskId(session: WorkbenchAgentSessionContext): string {
  return session.taskId || session.sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
