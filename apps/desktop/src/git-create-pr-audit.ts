import type {
  GitCreatePullRequestExecutionQuickResult,
  GitCreatePullRequestPlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";
import { createDryRunBindingHash } from "@javis/core";
import type { PermissionRequest } from "@javis/tools";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export const GIT_CREATE_PR_AUDIT_TOOL_NAME = "git.createPullRequest";
export const GIT_CREATE_PR_APPROVAL_TITLE = "Approve Git pull request";

export function createGitCreatePullRequestPlanAuditRecord(
  session: WorkbenchAgentSessionContext,
  plan: GitCreatePullRequestPlanQuickResult,
  recordedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCreatePullRequestAuditId(session, plan.approvalId, "plan"),
    taskId: auditTaskId(session),
    toolName: GIT_CREATE_PR_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "waiting_permission",
    inputSummary: `Prepare Git pull request "${plan.preview.title}" (${plan.preview.headBranch} -> ${plan.preview.baseBranch})`,
    dryRunJson: JSON.stringify(plan.preview.dryRun),
    permissionRequestId: plan.approvalId,
    startedAt: recordedAt,
  };
}

export function createGitCreatePullRequestPermissionRequest(
  plan: GitCreatePullRequestPlanQuickResult,
  createdAt = new Date().toISOString(),
): PermissionRequest {
  return {
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: GIT_CREATE_PR_APPROVAL_TITLE,
    reason: "Creating a pull request sends branch metadata to the configured GitHub remote.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
    bindingHash: createDryRunBindingHash(plan.preview.dryRun),
    status: "pending",
    createdAt,
  };
}

export function createGitCreatePullRequestExecutionAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  execution: GitCreatePullRequestExecutionQuickResult,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCreatePullRequestAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_CREATE_PR_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: `Execute approved Git pull request "${execution.title}"`,
    outputSummary: `Created ${execution.draft ? "draft " : ""}pull request ${execution.url}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
  };
}

export function createGitCreatePullRequestFailedAuditRecord(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  error: unknown,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createGitCreatePullRequestAuditId(session, approvalId, "execute"),
    taskId: auditTaskId(session),
    toolName: GIT_CREATE_PR_AUDIT_TOOL_NAME,
    permissionLevel: "confirmed_write",
    status: "failed",
    inputSummary: `Execute approved Git pull request ${approvalId}`,
    permissionRequestId: approvalId,
    startedAt,
    endedAt,
    errorJson: JSON.stringify({ message: errorMessage(error) }),
  };
}

function createGitCreatePullRequestAuditId(
  session: WorkbenchAgentSessionContext,
  approvalId: string,
  phase: "plan" | "execute",
): string {
  return `${auditTaskId(session)}:${GIT_CREATE_PR_AUDIT_TOOL_NAME}:${approvalId}:${phase}`;
}

function auditTaskId(session: WorkbenchAgentSessionContext): string {
  return session.taskId || session.sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
