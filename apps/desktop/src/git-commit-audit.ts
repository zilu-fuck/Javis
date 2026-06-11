import { createDryRunBindingHash } from "@javis/core";
import type {
  GitCommitExecutionQuickResult,
  GitCommitPlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";
import type { PermissionRequest } from "@javis/tools";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export const GIT_COMMIT_AUDIT_TOOL_NAME = "git.createCommit";
export const GIT_COMMIT_APPROVAL_TITLE = "Approve Git commit";

export function createGitCommitPlanAuditRecord(
  session: WorkbenchAgentSessionContext,
  plan: GitCommitPlanQuickResult,
  recordedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCommitAuditId(session, plan.approvalId, "plan"),
    taskId: auditTaskId(session),
    toolName: GIT_COMMIT_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "waiting_permission",
    inputSummary: `Prepare Git commit "${plan.preview.message}" (${plan.preview.files.length} file(s))`,
    dryRunJson: JSON.stringify(plan.preview.dryRun),
    permissionRequestId: plan.approvalId,
    startedAt: recordedAt,
  };
}

export function createGitCommitPermissionRequest(
  plan: GitCommitPlanQuickResult,
  createdAt = new Date().toISOString(),
): PermissionRequest {
  return {
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: GIT_COMMIT_APPROVAL_TITLE,
    reason: "Committing stages current workspace changes and writes a local Git commit.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
    bindingHash: createDryRunBindingHash(plan.preview.dryRun),
    status: "pending",
    createdAt,
  };
}

export function createGitCommitExecutionAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  execution: GitCommitExecutionQuickResult,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCommitAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_COMMIT_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: `Execute approved Git commit "${execution.subject}"`,
    outputSummary: `Created commit ${execution.commitHash.slice(0, 12)} for ${execution.fileCount} file(s)`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
  };
}

export function createGitCommitFailedAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  error: unknown,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCommitAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_COMMIT_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "failed",
    inputSummary: `Execute approved Git commit ${approvalId}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
    errorJson: JSON.stringify({ message: errorMessage(error) }),
  };
}

function createGitCommitAuditId(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  phase: "plan" | "execute",
): string {
  return `${auditTaskId(session)}:${GIT_COMMIT_AUDIT_TOOL_NAME}:${approvalId}:${phase}`;
}

function auditTaskId(session: WorkbenchAgentSessionContext): string {
  return session.taskId || session.sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
