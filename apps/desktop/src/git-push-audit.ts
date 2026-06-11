import type {
  GitPushExecutionQuickResult,
  GitPushPlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";
import { createDryRunBindingHash } from "@javis/core";
import type { PermissionRequest } from "@javis/tools";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export const GIT_PUSH_AUDIT_TOOL_NAME = "git.pushBranch";
export const GIT_PUSH_APPROVAL_TITLE = "Approve Git push";

export function createGitPushPlanAuditRecord(
  session: WorkbenchAgentSessionContext,
  plan: GitPushPlanQuickResult,
  recordedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitPushAuditId(session, plan.approvalId, "plan"),
    taskId: auditTaskId(session),
    toolName: GIT_PUSH_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "waiting_permission",
    inputSummary: `Prepare Git push ${plan.preview.branch} -> ${plan.preview.upstream} (${plan.preview.commits.length} commit(s))`,
    dryRunJson: JSON.stringify(plan.preview.dryRun),
    permissionRequestId: plan.approvalId,
    startedAt: recordedAt,
  };
}

export function createGitPushPermissionRequest(
  plan: GitPushPlanQuickResult,
  createdAt = new Date().toISOString(),
): PermissionRequest {
  return {
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: GIT_PUSH_APPROVAL_TITLE,
    reason: "Pushing sends local commits to the configured remote.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
    bindingHash: createDryRunBindingHash(plan.preview.dryRun),
    status: "pending",
    createdAt,
  };
}

export function createGitPushExecutionAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  execution: GitPushExecutionQuickResult,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitPushAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_PUSH_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: `Execute approved Git push ${execution.branch} -> ${execution.upstream}`,
    outputSummary: `Pushed ${execution.commitCount} commit(s) to ${execution.remoteName}/${execution.remoteBranch}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
  };
}

export function createGitPushFailedAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  error: unknown,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitPushAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_PUSH_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "failed",
    inputSummary: `Execute approved Git push ${approvalId}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
    errorJson: JSON.stringify({ message: errorMessage(error) }),
  };
}

function createGitPushAuditId(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  phase: "plan" | "execute",
): string {
  return `${auditTaskId(session)}:${GIT_PUSH_AUDIT_TOOL_NAME}:${approvalId}:${phase}`;
}

function auditTaskId(session: WorkbenchAgentSessionContext): string {
  return session.taskId || session.sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
