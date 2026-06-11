import type {
  GitCommentPullRequestExecutionQuickResult,
  GitCommentPullRequestPlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";
import { createDryRunBindingHash } from "@javis/core";
import type { PermissionRequest } from "@javis/tools";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export const GIT_COMMENT_PR_AUDIT_TOOL_NAME = "git.commentPullRequest";
export const GIT_COMMENT_PR_APPROVAL_TITLE = "Approve Git pull request comment";

export function createGitCommentPullRequestPlanAuditRecord(
  session: WorkbenchAgentSessionContext,
  plan: GitCommentPullRequestPlanQuickResult,
  recordedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCommentPullRequestAuditId(session, plan.approvalId, "plan"),
    taskId: auditTaskId(session),
    toolName: GIT_COMMENT_PR_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "waiting_permission",
    inputSummary: `Prepare Git pull request comment for ${plan.preview.pullRequest}`,
    dryRunJson: JSON.stringify(plan.preview.dryRun),
    permissionRequestId: plan.approvalId,
    startedAt: recordedAt,
  };
}

export function createGitCommentPullRequestPermissionRequest(
  plan: GitCommentPullRequestPlanQuickResult,
  createdAt = new Date().toISOString(),
): PermissionRequest {
  return {
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: GIT_COMMENT_PR_APPROVAL_TITLE,
    reason: "Posting a pull request comment sends text to the configured GitHub remote.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
    bindingHash: createDryRunBindingHash(plan.preview.dryRun),
    status: "pending",
    createdAt,
  };
}

export function createGitCommentPullRequestExecutionAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  execution: GitCommentPullRequestExecutionQuickResult,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCommentPullRequestAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_COMMENT_PR_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: `Execute approved Git pull request comment for ${execution.pullRequest}`,
    outputSummary: `Posted pull request comment on ${execution.pullRequest}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
  };
}

export function createGitCommentPullRequestFailedAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  error: unknown,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCommentPullRequestAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_COMMENT_PR_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "failed",
    inputSummary: `Execute approved Git pull request comment ${approvalId}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
    errorJson: JSON.stringify({ message: errorMessage(error) }),
  };
}

function createGitCommentPullRequestAuditId(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  phase: "plan" | "execute",
): string {
  return `${auditTaskId(session)}:${GIT_COMMENT_PR_AUDIT_TOOL_NAME}:${approvalId}:${phase}`;
}

function auditTaskId(session: WorkbenchAgentSessionContext): string {
  return session.taskId || session.sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
