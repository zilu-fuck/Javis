import { invoke } from "@tauri-apps/api/core";
import {
  createInitialTaskSnapshot,
  reconcileCheckpointWithEventLog,
  type RuntimeEventEnvelope,
  validateCodeApplyResult,
  validateCodeProposal,
  type TaskSnapshot,
  type WorkflowCheckpoint,
} from "@javis/core";
import type { CodeApplyResult, FileOrganizationExecution, ShellCommandOutput } from "@javis/tools";
import type { VerifierCheckResult } from "@javis/tools";
import type {
  GitCommitExecutionQuickResult,
  GitCommentPullRequestExecutionQuickResult,
  GitCreatePullRequestExecutionQuickResult,
  GitPushExecutionQuickResult,
  GitStageExecutionQuickResult,
} from "@javis/ui";
import {
  findPendingApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";
import {
  GIT_PUSH_APPROVAL_TITLE as GIT_PUSH_AUDIT_APPROVAL_TITLE,
  GIT_PUSH_AUDIT_TOOL_NAME,
} from "./git-push-audit";
import {
  GIT_COMMIT_APPROVAL_TITLE as GIT_COMMIT_AUDIT_APPROVAL_TITLE,
  GIT_COMMIT_AUDIT_TOOL_NAME,
} from "./git-commit-audit";
import {
  GIT_STAGE_APPROVAL_TITLE as GIT_STAGE_AUDIT_APPROVAL_TITLE,
  GIT_STAGE_AUDIT_TOOL_NAME,
} from "./git-stage-audit";
import {
  GIT_CREATE_PR_APPROVAL_TITLE as GIT_CREATE_PR_AUDIT_APPROVAL_TITLE,
  GIT_CREATE_PR_AUDIT_TOOL_NAME,
} from "./git-create-pr-audit";
import {
  GIT_COMMENT_PR_APPROVAL_TITLE as GIT_COMMENT_PR_AUDIT_APPROVAL_TITLE,
  GIT_COMMENT_PR_AUDIT_TOOL_NAME,
} from "./git-comment-pr-audit";

export const PDF_APPROVAL_TOOL_NAME = "file.executePdfOrganization";
export const PDF_APPROVAL_TITLE = "Approve PDF move plan";
export const CODE_PATCH_APPROVAL_TOOL_NAME = "code.applyProposedEdit";
export const CODE_PATCH_APPROVAL_TITLE = "Approve Code Agent patch application";
export const GIT_PUSH_APPROVAL_TOOL_NAME = GIT_PUSH_AUDIT_TOOL_NAME;
export const GIT_PUSH_APPROVAL_TITLE = GIT_PUSH_AUDIT_APPROVAL_TITLE;
export const GIT_COMMIT_APPROVAL_TOOL_NAME = GIT_COMMIT_AUDIT_TOOL_NAME;
export const GIT_COMMIT_APPROVAL_TITLE = GIT_COMMIT_AUDIT_APPROVAL_TITLE;
export const GIT_STAGE_APPROVAL_TOOL_NAME = GIT_STAGE_AUDIT_TOOL_NAME;
export const GIT_STAGE_APPROVAL_TITLE = GIT_STAGE_AUDIT_APPROVAL_TITLE;
export const GIT_CREATE_PR_APPROVAL_TOOL_NAME = GIT_CREATE_PR_AUDIT_TOOL_NAME;
export const GIT_CREATE_PR_APPROVAL_TITLE = GIT_CREATE_PR_AUDIT_APPROVAL_TITLE;
export const GIT_COMMENT_PR_APPROVAL_TOOL_NAME = GIT_COMMENT_PR_AUDIT_TOOL_NAME;
export const GIT_COMMENT_PR_APPROVAL_TITLE = GIT_COMMENT_PR_AUDIT_APPROVAL_TITLE;

export function findRestorableApprovalRecord(
  approvalRecords: DurableApprovalRecord[],
): DurableApprovalRecord | undefined {
  return (
    findPendingApprovalRecord(approvalRecords, PDF_APPROVAL_TOOL_NAME) ??
    findPendingApprovalRecord(approvalRecords, CODE_PATCH_APPROVAL_TOOL_NAME) ??
    findPendingApprovalRecord(approvalRecords, GIT_PUSH_APPROVAL_TOOL_NAME) ??
    findPendingApprovalRecord(approvalRecords, GIT_COMMIT_APPROVAL_TOOL_NAME) ??
    findPendingApprovalRecord(approvalRecords, GIT_STAGE_APPROVAL_TOOL_NAME) ??
    findPendingApprovalRecord(approvalRecords, GIT_CREATE_PR_APPROVAL_TOOL_NAME) ??
    findPendingApprovalRecord(approvalRecords, GIT_COMMENT_PR_APPROVAL_TOOL_NAME)
  );
}

export function isDurableApprovalRequestTitle(title: string): boolean {
  return title === PDF_APPROVAL_TITLE || title === CODE_PATCH_APPROVAL_TITLE || title === GIT_PUSH_APPROVAL_TITLE || title === GIT_COMMIT_APPROVAL_TITLE || title === GIT_STAGE_APPROVAL_TITLE || title === GIT_CREATE_PR_APPROVAL_TITLE || title === GIT_COMMENT_PR_APPROVAL_TITLE;
}

export function getDurableApprovalToolName(title: string): string | undefined {
  if (title === PDF_APPROVAL_TITLE) {
    return PDF_APPROVAL_TOOL_NAME;
  }
  if (title === CODE_PATCH_APPROVAL_TITLE) {
    return CODE_PATCH_APPROVAL_TOOL_NAME;
  }
  if (title === GIT_PUSH_APPROVAL_TITLE) {
    return GIT_PUSH_APPROVAL_TOOL_NAME;
  }
  if (title === GIT_COMMIT_APPROVAL_TITLE) {
    return GIT_COMMIT_APPROVAL_TOOL_NAME;
  }
  if (title === GIT_STAGE_APPROVAL_TITLE) {
    return GIT_STAGE_APPROVAL_TOOL_NAME;
  }
  if (title === GIT_CREATE_PR_APPROVAL_TITLE) {
    return GIT_CREATE_PR_APPROVAL_TOOL_NAME;
  }
  if (title === GIT_COMMENT_PR_APPROVAL_TITLE) {
    return GIT_COMMENT_PR_APPROVAL_TOOL_NAME;
  }
  return undefined;
}

export function getDurableApprovalWorkspacePath(
  task: TaskSnapshot,
  title: string,
): string {
  if (title === PDF_APPROVAL_TITLE) {
    return task.fileOrganizationPlan?.directoryPath ?? "";
  }
  if (title === CODE_PATCH_APPROVAL_TITLE) {
    return task.codeProposedEdit?.workspacePath ?? task.codeReviewPreview?.workspacePath ?? "";
  }
  const plan = task.durableApprovalPlan?.payload;
  if (typeof plan === "object" && plan !== null) {
    const preview = (plan as { preview?: { workspaceRoot?: unknown } }).preview;
    if (typeof preview?.workspaceRoot === "string") return preview.workspaceRoot;
  }
  return "";
}

export type RestoredApprovalCheckpointLinkStatus =
  | "linked"
  | "blocked"
  | "unlinked";

export interface RestoredApprovalCheckpointLinkResult {
  status: RestoredApprovalCheckpointLinkStatus;
  linkedTask: TaskSnapshot;
  reason?: string;
}

export function reconcileRestoredApprovalTaskToCheckpoint(
  task: TaskSnapshot,
  checkpoint: WorkflowCheckpoint | undefined,
  runtimeEvents: RuntimeEventEnvelope[] = [],
): RestoredApprovalCheckpointLinkResult {
  const approvalId = task.permissionRequest?.id;
  if (!approvalId || !checkpoint) {
    return { status: "unlinked", linkedTask: task };
  }

  const orderedApprovalEvents = [...runtimeEvents].sort((left, right) => left.sequence - right.sequence);
  const requestedEvent = findLatestEvent(orderedApprovalEvents, (event) =>
    permissionRequestIdFromEvent(event) === approvalId
  );
  const expectedToolName = task.permissionRequest
    ? getDurableApprovalToolName(task.permissionRequest.title)
    : undefined;
  const expectedPreviewHash = task.permissionRequest?.bindingHash;
  const requestedBinding = requestedEvent ? permissionEventBinding(requestedEvent) : undefined;
  const boundStepId = requestedBinding?.stepId;
  const boundStep = boundStepId
    ? checkpoint.workflowSnapshot.steps.find((step) => step.id === boundStepId)
    : undefined;
  const boundStepToolName = (boundStep as (typeof boundStep & { toolName?: string }) | undefined)?.toolName;
  if (!requestedEvent || !requestedBinding || !expectedToolName || !expectedPreviewHash ||
    requestedBinding.toolName !== expectedToolName ||
    requestedBinding.previewHash !== expectedPreviewHash ||
    !boundStep || boundStepToolName !== undefined && boundStepToolName !== expectedToolName
  ) {
    const reason = `Approval ${approvalId} does not have matching step, tool, and preview bindings in the durable event log.`;
    return {
      status: "blocked",
      reason,
      linkedTask: {
        ...task,
        logs: [
          ...task.logs,
          {
            id: `${task.id}-workflow-approval-binding-mismatch-${checkpoint.runId}`,
            kind: "event",
            title: "workflow.approval.binding_mismatch",
            detail: reason,
          },
        ],
        verificationSummary: appendVerificationSummaryLine(
          task.verificationSummary,
          `blocked: ${reason}`,
        ),
      },
    };
  }
  const alreadyResolved = runtimeEvents.some((event) =>
    permissionResolvedIdFromEvent(event) === approvalId
  );
  const boundStepAlreadyTerminal = Boolean(requestedEvent && boundStepId && runtimeEvents.some((event) =>
    event.sequence > requestedEvent.sequence &&
    eventStepId(event) === boundStepId &&
    (eventKind(event) === "step.completed" || eventKind(event) === "step.failed")
  ));
  if (alreadyResolved || boundStepAlreadyTerminal) {
    const reason = alreadyResolved
      ? `Approval ${approvalId} is already resolved in the durable event log.`
      : `Approval ${approvalId} already has a terminal event for step ${boundStepId}.`;
    return {
      status: "blocked",
      reason,
      linkedTask: {
        ...task,
        logs: [
          ...task.logs,
          {
            id: `${task.id}-workflow-approval-already-resolved-${checkpoint.runId}`,
            kind: "event",
            title: "workflow.approval.already_resolved",
            detail: reason,
          },
        ],
        verificationSummary: appendVerificationSummaryLine(
          task.verificationSummary,
          `blocked: ${reason}`,
        ),
      },
    };
  }

  const reconciliation = reconcileCheckpointWithEventLog(checkpoint, runtimeEvents);
  const safelyWaitingForThisApproval = isSafelyWaitingForRestoredApproval(
    approvalId,
    checkpoint,
    runtimeEvents,
    reconciliation.reason,
    expectedToolName,
    expectedPreviewHash,
  );
  if (reconciliation.status === "blocked" && !safelyWaitingForThisApproval) {
    return {
      status: "blocked",
      reason: reconciliation.reason,
      linkedTask: {
        ...task,
        logs: [
          ...task.logs,
          {
            id: `${task.id}-workflow-checkpoint-reconciliation-blocked-${checkpoint.runId}`,
            kind: "event",
            title: "workflow.checkpoint.reconciliation_blocked",
            detail: `Restored approval ${approvalId} cannot auto-resume from run ${checkpoint.runId}: ${reconciliation.reason}`,
          },
        ],
        verificationSummary: appendVerificationSummaryLine(
          task.verificationSummary,
          `blocked: restored approval cannot auto-resume from durable run ${checkpoint.runId}; ${reconciliation.reason}`,
        ),
      },
    };
  }

  if (
    reconciliation.status !== "resumable" && !safelyWaitingForThisApproval
  ) {
    return { status: "unlinked", linkedTask: task };
  }

  const completedCount = safelyWaitingForThisApproval
    ? checkpoint.completedStepIds.length
    : reconciliation.completedStepIds.length;
  const pendingCount = safelyWaitingForThisApproval
    ? checkpoint.pendingStepIds.length + checkpoint.runningStepIds.length
    : reconciliation.pendingStepIds.length + reconciliation.retryStepIds.length;
  return {
    status: "linked",
    linkedTask: {
      ...task,
      logs: [
        ...task.logs,
        {
          id: `${task.id}-workflow-checkpoint-linked-${checkpoint.runId}`,
          kind: "event",
          title: "workflow.checkpoint.linked",
          detail:
            `Restored approval ${approvalId} is linked to run ${checkpoint.runId} ` +
            `at event sequence ${checkpoint.eventSequence}.`,
        },
      ],
      verificationSummary: appendVerificationSummaryLine(
        task.verificationSummary,
        `pending: restored approval is linked to durable run ${checkpoint.runId}; ${completedCount} step(s) completed and ${pendingCount} step(s) resumable after approval.`,
      ),
    },
  };
}

const RUNNING_WRITE_RECONCILIATION_REASON =
  "Checkpoint has running confirmed-write step(s) that require explicit reconciliation before resume.";

/**
 * A confirmed-write step is normally unsafe to retry. The one safe exception
 * is a durable log proving that the step stopped at its approval request and
 * never received a resolution or terminal step event. In that state the UI
 * may restore the approval card; the native approval binding still gates the
 * eventual side effect.
 */
function isSafelyWaitingForRestoredApproval(
  approvalId: string,
  checkpoint: WorkflowCheckpoint,
  runtimeEvents: RuntimeEventEnvelope[],
  reconciliationReason: string,
  expectedToolName?: string,
  expectedPreviewHash?: string,
): boolean {
  if (
    reconciliationReason !== RUNNING_WRITE_RECONCILIATION_REASON ||
    checkpoint.waitingReason !== "human_approval" ||
    checkpoint.runningStepIds.length !== 1
  ) {
    return false;
  }
  const runningStepId = checkpoint.runningStepIds[0];
  const runningStep = checkpoint.workflowSnapshot.steps.find((step) => step.id === runningStepId);
  if (
    !runningStep ||
    runningStep.permissionLevel !== "confirmed_write" && runningStep.permissionLevel !== "dangerous"
  ) {
    return false;
  }
  const runningStepToolName = (runningStep as typeof runningStep & { toolName?: string }).toolName;
  if (expectedToolName && runningStepToolName && expectedToolName !== runningStepToolName) {
    return false;
  }

  const ordered = [...runtimeEvents].sort((left, right) => left.sequence - right.sequence);
  const started = findLatestEvent(ordered, (event) =>
    eventKind(event) === "step.started" && eventStepId(event) === runningStepId
  );
  const requested = findLatestEvent(ordered, (event) =>
    eventKind(event) === "permission.requested" && permissionRequestIdFromEvent(event) === approvalId
  );
  if (!started || !requested || requested.sequence < started.sequence) return false;
  const requestedBinding = permissionEventBinding(requested);
  if (!requestedBinding ||
    requestedBinding.stepId !== runningStepId ||
    requestedBinding.toolName !== expectedToolName ||
    requestedBinding.previewHash !== expectedPreviewHash
  ) {
    return false;
  }
  const latestStartedBeforeRequest = findLatestEvent(ordered, (event) =>
    event.sequence <= requested.sequence && eventKind(event) === "step.started"
  );
  if (!latestStartedBeforeRequest || eventStepId(latestStartedBeforeRequest) !== runningStepId) {
    return false;
  }

  return !ordered.some((event) =>
    event.sequence > requested.sequence && (
      eventKind(event) === "permission.resolved" && permissionResolvedIdFromEvent(event) === approvalId ||
      eventStepId(event) === runningStepId &&
        (eventKind(event) === "step.completed" || eventKind(event) === "step.failed")
    )
  );
}

export function linkRestoredApprovalTaskToCheckpoint(
  task: TaskSnapshot,
  checkpoint: WorkflowCheckpoint | undefined,
  runtimeEvents: RuntimeEventEnvelope[] = [],
): TaskSnapshot {
  return reconcileRestoredApprovalTaskToCheckpoint(task, checkpoint, runtimeEvents).linkedTask;
}

function permissionRequestIdFromEvent(event: RuntimeEventEnvelope): string | undefined {
  const payload = event.payload;
  if (!isRecord(payload) || payload.kind !== "permission.requested") {
    return undefined;
  }
  if (typeof payload.approvalId === "string") {
    return payload.approvalId;
  }
  const request = payload.request;
  if (!isRecord(request) || typeof request.id !== "string") {
    return undefined;
  }
  return request.id;
}

function permissionResolvedIdFromEvent(event: RuntimeEventEnvelope): string | undefined {
  const payload = event.payload;
  if (!isRecord(payload) || payload.kind !== "permission.resolved") return undefined;
  if (typeof payload.requestId === "string") return payload.requestId;
  return typeof payload.approvalId === "string" ? payload.approvalId : undefined;
}

function eventKind(event: RuntimeEventEnvelope): string | undefined {
  return isRecord(event.payload) && typeof event.payload.kind === "string"
    ? event.payload.kind
    : undefined;
}

function eventStepId(event: RuntimeEventEnvelope): string | undefined {
  if (typeof event.stepId === "string") return event.stepId;
  return isRecord(event.payload) && typeof event.payload.stepId === "string"
    ? event.payload.stepId
    : undefined;
}

function permissionEventBinding(event: RuntimeEventEnvelope): {
  stepId: string;
  toolName: string;
  previewHash: string;
} | undefined {
  const payload = event.payload;
  const stepId = eventStepId(event);
  if (!isRecord(payload) || !stepId ||
    typeof payload.toolName !== "string" ||
    typeof payload.previewHash !== "string"
  ) {
    return undefined;
  }
  return { stepId, toolName: payload.toolName, previewHash: payload.previewHash };
}

function findLatestEvent(
  events: RuntimeEventEnvelope[],
  predicate: (event: RuntimeEventEnvelope) => boolean,
): RuntimeEventEnvelope | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) return event;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendVerificationSummaryLine(
  current: string | undefined,
  line: string,
): string {
  if (!current) {
    return line;
  }
  return `${current}\n${line}`;
}

function createRestoredApprovalOutcome(
  record: DurableApprovalRecord,
  status: NonNullable<TaskSnapshot["approvalOutcome"]>["status"],
): NonNullable<TaskSnapshot["approvalOutcome"]> {
  return {
    approvalId: record.approvalId,
    status,
    ...(record.permissionRequest.resolvedAt ? { resolvedAt: record.permissionRequest.resolvedAt } : {}),
  };
}

function createRestoredVerificationResult(summary: string): VerifierCheckResult {
  const status = summary.startsWith("verified:")
    ? "pass"
    : summary.startsWith("failed:")
      ? "fail"
      : "warn";
  return {
    status,
    summary,
    detail: summary,
  };
}

function withRestoredVerificationResult(task: TaskSnapshot): TaskSnapshot {
  if (!task.verificationSummary) {
    return task;
  }
  return {
    ...task,
    verificationResult: createRestoredVerificationResult(task.verificationSummary),
  };
}

export function createRestoredPdfApprovalTask(record: DurableApprovalRecord): TaskSnapshot {
  const affectedPaths = record.permissionRequest.dryRun.affectedPaths;
  return {
    ...createInitialTaskSnapshot(),
    id: `restored-approval-${record.taskId}`,
    title: "PDF organization approval needed",
    userGoal: "Organize PDFs in Downloads",
    status: "waiting_permission",
    commanderMessage:
      "A pending PDF organization approval was restored from local approval records.",
    plan: [
      {
        id: "step-confirm-pdf",
        title: "User reviews the confirmed-write permission card",
        assignedAgentKind: "file",
        status: "running",
      },
    ],
    agents: [],
    logs: [
      {
        id: `${record.taskId}-approval-restored`,
        kind: "permission",
        title: "permission.restored",
        detail: `Restored pending approval ${record.approvalId} for ${record.toolName}.`,
      },
    ],
    fileOrganizationPlan: {
      approvalId: record.approvalId,
      directoryPath: record.workspacePath,
      fileCount: affectedPaths.length,
      dryRun: record.permissionRequest.dryRun,
    },
    permissionRequest: record.permissionRequest,
  };
}

export function createRestoredCodePatchApprovalTask(record: DurableApprovalRecord): TaskSnapshot {
  const affectedPaths = record.permissionRequest.dryRun.affectedPaths;
  return {
    ...createInitialTaskSnapshot(),
    id: `restored-approval-${record.taskId}`,
    title: "Code Agent patch approval needed",
    userGoal: "Apply restored Code Agent patch proposal",
    status: "waiting_permission",
    commanderMessage:
      "A pending Code Agent patch approval was restored from local approval records.",
    plan: [
      {
        id: "step-confirm-code-patch",
        title: "User reviews the confirmed-write permission card",
        assignedAgentKind: "code",
        status: "running",
      },
    ],
    agents: [],
    logs: [
      {
        id: `${record.taskId}-code-approval-restored`,
        kind: "permission",
        title: "permission.restored",
        detail: `Restored pending approval ${record.approvalId} for ${record.toolName}.`,
      },
    ],
    codeProposedEdit: record.codeProposedEdit,
    codeReviewPreview: record.codeProposedEdit
      ? {
          workspacePath: record.codeProposedEdit.workspacePath,
          changedFiles: record.codeProposedEdit.changedFiles,
          diffStat: `${affectedPaths.length} proposed file(s)`,
          diff: record.codeProposedEdit.patch,
        }
      : undefined,
    permissionRequest: record.permissionRequest,
  };
}

export function createRestoredGitPushApprovalTask(record: DurableApprovalRecord): TaskSnapshot {
  const preview = record.gitPushPlan?.preview;
  return {
    ...createInitialTaskSnapshot(),
    id: `restored-approval-${record.taskId}`,
    title: "Git push approval needed",
    userGoal: "Push restored Git branch",
    status: "waiting_permission",
    commanderMessage:
      "A pending Git push approval was restored from local approval records.",
    plan: [
      {
        id: "step-confirm-git-push",
        title: "User reviews the confirmed-write permission card",
        assignedAgentKind: "code",
        status: "running",
      },
    ],
    agents: [],
    logs: [
      {
        id: `${record.taskId}-git-push-approval-restored`,
        kind: "permission",
        title: "permission.restored",
        detail: `Restored pending approval ${record.approvalId} for ${record.toolName}.`,
      },
    ],
    permissionRequest: record.permissionRequest,
    verificationSummary: preview
      ? `pending: ${preview.commits.length} commit(s) ready to push from ${preview.branch} to ${preview.upstream}.`
      : undefined,
  };
}

export function createRestoredGitCommitApprovalTask(record: DurableApprovalRecord): TaskSnapshot {
  const preview = record.gitCommitPlan?.preview;
  return {
    ...createInitialTaskSnapshot(),
    id: `restored-approval-${record.taskId}`,
    title: "Git commit approval needed",
    userGoal: "Commit restored Git changes",
    status: "waiting_permission",
    commanderMessage:
      "A pending Git commit approval was restored from local approval records.",
    plan: [
      {
        id: "step-confirm-git-commit",
        title: "User reviews the confirmed-write permission card",
        assignedAgentKind: "code",
        status: "running",
      },
    ],
    agents: [],
    logs: [
      {
        id: `${record.taskId}-git-commit-approval-restored`,
        kind: "permission",
        title: "permission.restored",
        detail: `Restored pending approval ${record.approvalId} for ${record.toolName}.`,
      },
    ],
    permissionRequest: record.permissionRequest,
    verificationSummary: preview
      ? `pending: ${preview.files.length} file(s) ready to commit with message "${preview.message}".`
      : undefined,
  };
}

export function createRestoredGitStageApprovalTask(record: DurableApprovalRecord): TaskSnapshot {
  const preview = record.gitStagePlan?.preview;
  return {
    ...createInitialTaskSnapshot(),
    id: `restored-approval-${record.taskId}`,
    title: "Git stage approval needed",
    userGoal: "Stage restored Git file selection",
    status: "waiting_permission",
    commanderMessage:
      "A pending Git stage approval was restored from local approval records.",
    plan: [
      {
        id: "step-confirm-git-stage",
        title: "User reviews the confirmed-write permission card",
        assignedAgentKind: "code",
        status: "running",
      },
    ],
    agents: [],
    logs: [
      {
        id: `${record.taskId}-git-stage-approval-restored`,
        kind: "permission",
        title: "permission.restored",
        detail: `Restored pending approval ${record.approvalId} for ${record.toolName}.`,
      },
    ],
    permissionRequest: record.permissionRequest,
    verificationSummary: preview
      ? `pending: ${preview.files.length} selected file(s) ready to stage.`
      : undefined,
  };
}

export function createRestoredGitCreatePullRequestApprovalTask(record: DurableApprovalRecord): TaskSnapshot {
  const preview = record.gitCreatePullRequestPlan?.preview;
  return {
    ...createInitialTaskSnapshot(),
    id: `restored-approval-${record.taskId}`,
    title: "Git pull request approval needed",
    userGoal: "Create restored Git pull request",
    status: "waiting_permission",
    commanderMessage:
      "A pending Git pull request approval was restored from local approval records.",
    plan: [
      {
        id: "step-confirm-git-create-pr",
        title: "User reviews the confirmed-write permission card",
        assignedAgentKind: "code",
        status: "running",
      },
    ],
    agents: [],
    logs: [
      {
        id: `${record.taskId}-git-create-pr-approval-restored`,
        kind: "permission",
        title: "permission.restored",
        detail: `Restored pending approval ${record.approvalId} for ${record.toolName}.`,
      },
    ],
    permissionRequest: record.permissionRequest,
    verificationSummary: preview
      ? `pending: ${preview.draft ? "draft " : ""}pull request "${preview.title}" ready from ${preview.headBranch} to ${preview.baseBranch}.`
      : undefined,
  };
}

export function createRestoredGitCommentPullRequestApprovalTask(record: DurableApprovalRecord): TaskSnapshot {
  const preview = record.gitCommentPullRequestPlan?.preview;
  return {
    ...createInitialTaskSnapshot(),
    id: `restored-approval-${record.taskId}`,
    title: "Git pull request comment approval needed",
    userGoal: "Comment on restored Git pull request",
    status: "waiting_permission",
    commanderMessage:
      "A pending Git pull request comment approval was restored from local approval records.",
    plan: [
      {
        id: "step-confirm-git-comment-pr",
        title: "User reviews the confirmed-write permission card",
        assignedAgentKind: "code",
        status: "running",
      },
    ],
    agents: [],
    logs: [
      {
        id: `${record.taskId}-git-comment-pr-approval-restored`,
        kind: "permission",
        title: "permission.restored",
        detail: `Restored pending approval ${record.approvalId} for ${record.toolName}.`,
      },
    ],
    permissionRequest: record.permissionRequest,
    verificationSummary: preview
      ? `pending: pull request comment ready for ${preview.pullRequest}.`
      : undefined,
  };
}

export function createRestoredPdfDeniedTask(record: DurableApprovalRecord): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredPdfApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "PDF organization denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not move or modify files.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "denied"),
    verificationSummary: "verified: restored permission denied; no write operation was executed.",
  });
}

export function createRestoredPdfApprovedTask(
  record: DurableApprovalRecord,
  execution: FileOrganizationExecution,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredPdfApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title: execution.failedCount === 0 ? "PDF organization completed" : "PDF organization completed with failures",
    status: execution.failedCount === 0 ? "completed" : "failed",
    commanderMessage: "Restored permission was approved and the PDF organization dry-run executed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    fileOrganizationExecution: execution,
    verificationSummary: `${execution.failedCount === 0 ? "verified" : "failed"}: ${execution.movedCount}/${execution.attemptedCount} PDF move(s) completed, ${execution.skippedCount} skipped, ${execution.failedCount} failed.`,
  });
}

export function createRestoredPdfFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredPdfApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "PDF organization execution failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native execution failed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `failed: restored PDF organization failed before completion; ${error instanceof Error ? error.message : String(error)}`,
    logs: [
      ...createRestoredPdfApprovalTask(record).logs,
      {
        id: `${record.taskId}-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}

export async function runRestoredPdfOrganization(
  record: DurableApprovalRecord,
): Promise<FileOrganizationExecution> {
  await invoke("restore_pdf_organization_approval", {
    request: {
      approvalId: record.approvalId,
      operations: record.permissionRequest.dryRun.affectedPaths,
      taskId: record.taskId,
    },
  });
  await invoke("approve_pdf_organization", {
    approvalId: record.approvalId,
    taskId: record.taskId,
  });
  return invoke<FileOrganizationExecution>("execute_pdf_organization", {
    request: {
      approvalId: record.approvalId,
      operations: record.permissionRequest.dryRun.affectedPaths,
      taskId: record.taskId,
    },
  });
}

export async function applyRestoredCodePatch(record: DurableApprovalRecord): Promise<CodeApplyResult> {
  const edit = record.codeProposedEdit;
  if (!edit) {
    throw new Error("Restored Code Patch approval does not include a patch proposal.");
  }
  const proposalSafetyError = validateCodeProposal(edit);
  if (proposalSafetyError) {
    throw new Error(proposalSafetyError);
  }
  const restoredEdit = {
    ...edit,
    approvalId: edit.approvalId ?? record.approvalId,
  };
  await invoke("restore_code_patch_approval", {
    request: {
      approvalId: record.approvalId,
      edit: restoredEdit,
      taskId: record.taskId,
    },
  });
  await invoke("approve_code_patch", {
    request: {
      approvalId: record.approvalId,
      proposalId: restoredEdit.proposalId,
      workspacePath: restoredEdit.workspacePath,
      changedFiles: restoredEdit.changedFiles,
      patchHash: restoredEdit.patchHash,
      taskId: record.taskId,
    },
  });
  const applyResult = await invoke<CodeApplyResult>("apply_code_patch", {
    request: {
      approvalId: record.approvalId,
      proposalId: restoredEdit.proposalId,
      workspacePath: restoredEdit.workspacePath,
      changedFiles: restoredEdit.changedFiles,
      patch: restoredEdit.patch,
      patchHash: restoredEdit.patchHash,
      baseGitHead: restoredEdit.baseGitHead,
      taskId: record.taskId,
    },
  });
  const applySafetyError = validateCodeApplyResult(restoredEdit, applyResult);
  if (applySafetyError) {
    throw new Error(applySafetyError);
  }
  return applyResult;
}

export function runRestoredCodePatchVerification(
  workspacePath: string,
): Promise<ShellCommandOutput> {
  return invoke<ShellCommandOutput>("run_read_only_command", {
    request: {
      program: "git",
      args: ["diff", "--check"],
      workspacePath,
    },
  });
}

export function createRestoredCodePatchDeniedTask(
  record: DurableApprovalRecord,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredCodePatchApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "Code Agent patch denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not apply the patch.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "denied"),
    verificationSummary: "verified: restored Code Agent patch was denied and no write operation was executed.",
  });
}

export function createRestoredGitPushDeniedTask(
  record: DurableApprovalRecord,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitPushApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "Git push denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not push to the remote.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "denied"),
    verificationSummary: "verified: restored Git push was denied and no remote operation was executed.",
  });
}

export function createRestoredGitPushApprovedTask(
  record: DurableApprovalRecord,
  execution: GitPushExecutionQuickResult,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitPushApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title: execution.pushed ? "Git push completed" : "Git push did not run",
    status: execution.pushed ? "completed" : "failed",
    commanderMessage: "Restored permission was approved and the Git push executed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `${execution.pushed ? "verified" : "failed"}: pushed ${execution.commitCount} commit(s) to ${execution.remoteName}/${execution.remoteBranch}.`,
    logs: [
      ...createRestoredGitPushApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-push-restored-executed`,
        kind: "tool",
        title: "git.pushBranch",
        detail: execution.output || `Pushed ${execution.commitCount} commit(s) to ${execution.upstream}.`,
      },
    ],
  });
}

export function createRestoredGitPushFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitPushApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "Git push failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native Git push execution failed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `failed: restored Git push failed before completion; ${error instanceof Error ? error.message : String(error)}`,
    logs: [
      ...createRestoredGitPushApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-push-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}

export function createRestoredGitCommitDeniedTask(
  record: DurableApprovalRecord,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCommitApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "Git commit denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not create a commit.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "denied"),
    verificationSummary: "verified: restored Git commit was denied and no local commit was created.",
  });
}

export function createRestoredGitCommitApprovedTask(
  record: DurableApprovalRecord,
  execution: GitCommitExecutionQuickResult,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCommitApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title: execution.committed ? "Git commit completed" : "Git commit did not run",
    status: execution.committed ? "completed" : "failed",
    commanderMessage: "Restored permission was approved and the Git commit executed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `${execution.committed ? "verified" : "failed"}: created commit ${execution.commitHash.slice(0, 12)} for ${execution.fileCount} file(s).`,
    logs: [
      ...createRestoredGitCommitApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-commit-restored-executed`,
        kind: "tool",
        title: "git.createCommit",
        detail: execution.output || `Created commit ${execution.commitHash}.`,
      },
    ],
  });
}

export function createRestoredGitCommitFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCommitApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "Git commit failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native Git commit execution failed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `failed: restored Git commit failed before completion; ${error instanceof Error ? error.message : String(error)}`,
    logs: [
      ...createRestoredGitCommitApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-commit-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}

export function createRestoredGitStageDeniedTask(
  record: DurableApprovalRecord,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitStageApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "Git stage denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not update the Git index.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "denied"),
    verificationSummary: "verified: restored Git stage was denied and no local index update was executed.",
  });
}

export function createRestoredGitStageApprovedTask(
  record: DurableApprovalRecord,
  execution: GitStageExecutionQuickResult,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitStageApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title: execution.staged ? "Git stage completed" : "Git stage did not run",
    status: execution.staged ? "completed" : "failed",
    commanderMessage: "Restored permission was approved and the Git stage executed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `${execution.staged ? "verified" : "failed"}: staged ${execution.fileCount} selected file(s).`,
    logs: [
      ...createRestoredGitStageApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-stage-restored-executed`,
        kind: "tool",
        title: "git.stageFiles",
        detail: execution.output || `Staged ${execution.fileCount} selected file(s).`,
      },
    ],
  });
}

export function createRestoredGitStageFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitStageApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "Git stage failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native Git stage execution failed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `failed: restored Git stage failed before completion; ${error instanceof Error ? error.message : String(error)}`,
    logs: [
      ...createRestoredGitStageApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-stage-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}

export function createRestoredGitCreatePullRequestDeniedTask(
  record: DurableApprovalRecord,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCreatePullRequestApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "Git pull request denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not create a pull request.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "denied"),
    verificationSummary: "verified: restored Git pull request creation was denied and no remote PR was created.",
  });
}

export function createRestoredGitCreatePullRequestApprovedTask(
  record: DurableApprovalRecord,
  execution: GitCreatePullRequestExecutionQuickResult,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCreatePullRequestApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title: execution.created ? "Git pull request created" : "Git pull request did not run",
    status: execution.created ? "completed" : "failed",
    commanderMessage: "Restored permission was approved and the Git pull request was created.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `${execution.created ? "verified" : "failed"}: created ${execution.draft ? "draft " : ""}pull request ${execution.url}.`,
    logs: [
      ...createRestoredGitCreatePullRequestApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-create-pr-restored-executed`,
        kind: "tool",
        title: "git.createPullRequest",
        detail: execution.output || `Created pull request ${execution.url}.`,
      },
    ],
  });
}

export function createRestoredGitCreatePullRequestFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCreatePullRequestApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "Git pull request creation failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native Git pull request creation failed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `failed: restored Git pull request creation failed before completion; ${error instanceof Error ? error.message : String(error)}`,
    logs: [
      ...createRestoredGitCreatePullRequestApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-create-pr-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}

export function createRestoredGitCommentPullRequestDeniedTask(
  record: DurableApprovalRecord,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCommentPullRequestApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "Git pull request comment denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not post a pull request comment.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "denied"),
    verificationSummary: "verified: restored Git pull request comment was denied and no remote comment was posted.",
  });
}

export function createRestoredGitCommentPullRequestApprovedTask(
  record: DurableApprovalRecord,
  execution: GitCommentPullRequestExecutionQuickResult,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCommentPullRequestApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title: execution.commented ? "Git pull request comment posted" : "Git pull request comment did not run",
    status: execution.commented ? "completed" : "failed",
    commanderMessage: "Restored permission was approved and the Git pull request comment was posted.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `${execution.commented ? "verified" : "failed"}: posted pull request comment on ${execution.pullRequest}.`,
    logs: [
      ...createRestoredGitCommentPullRequestApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-comment-pr-restored-executed`,
        kind: "tool",
        title: "git.commentPullRequest",
        detail: execution.output || `Posted pull request comment on ${execution.pullRequest}.`,
      },
    ],
  });
}

export function createRestoredGitCommentPullRequestFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredGitCommentPullRequestApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "Git pull request comment failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native Git pull request commenting failed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `failed: restored Git pull request comment failed before completion; ${error instanceof Error ? error.message : String(error)}`,
    logs: [
      ...createRestoredGitCommentPullRequestApprovalTask(record).logs,
      {
        id: `${record.taskId}-git-comment-pr-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}

export async function runRestoredGitPush(
  record: DurableApprovalRecord,
): Promise<GitPushExecutionQuickResult> {
  const plan = record.gitPushPlan;
  if (!plan) {
    throw new Error("Restored Git push approval does not include a push plan.");
  }
  const sessionId = record.taskId;
  await invoke("git_restore_push_approval", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      taskId: record.taskId,
      preview: plan.preview,
    },
  });
  await invoke("git_approve_push", {
    approvalId: record.approvalId,
    taskId: record.taskId,
  });
  const execution = await invoke<{
    workspaceRoot: string;
    branch: string;
    upstream: string;
    remoteName: string;
    remoteBranch: string;
    commitCount: number;
    pushed: boolean;
    output: string;
  }>("git_execute_push", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      taskId: record.taskId,
    },
  });
  return {
    workspacePath: execution.workspaceRoot,
    branch: execution.branch,
    upstream: execution.upstream,
    remoteName: execution.remoteName,
    remoteBranch: execution.remoteBranch,
    commitCount: execution.commitCount,
    pushed: execution.pushed,
    output: execution.output,
  };
}

export async function runRestoredGitCommit(
  record: DurableApprovalRecord,
): Promise<GitCommitExecutionQuickResult> {
  const plan = record.gitCommitPlan;
  if (!plan) {
    throw new Error("Restored Git commit approval does not include a commit plan.");
  }
  const sessionId = record.taskId;
  await invoke("git_restore_commit_approval", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      taskId: record.taskId,
      preview: plan.preview,
    },
  });
  await invoke("git_approve_commit", {
    approvalId: record.approvalId,
    taskId: record.taskId,
  });
  const execution = await invoke<{
    workspaceRoot: string;
    branch?: string;
    commitHash: string;
    subject: string;
    fileCount: number;
    committed: boolean;
    output: string;
  }>("git_execute_commit", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      message: plan.preview.message,
      taskId: record.taskId,
    },
  });
  return {
    workspacePath: execution.workspaceRoot,
    branch: execution.branch,
    commitHash: execution.commitHash,
    subject: execution.subject,
    fileCount: execution.fileCount,
    committed: execution.committed,
    output: execution.output,
  };
}

export async function runRestoredGitStage(
  record: DurableApprovalRecord,
): Promise<GitStageExecutionQuickResult> {
  const plan = record.gitStagePlan;
  if (!plan) {
    throw new Error("Restored Git stage approval does not include a stage plan.");
  }
  const sessionId = record.taskId;
  const paths = plan.preview.files.map((file) => file.path);
  await invoke("git_restore_stage_approval", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      taskId: record.taskId,
      preview: plan.preview,
    },
  });
  await invoke("git_approve_stage_files", {
    approvalId: record.approvalId,
    taskId: record.taskId,
  });
  const execution = await invoke<{
    workspaceRoot: string;
    stagedPaths: string[];
    fileCount: number;
    staged: boolean;
    output: string;
  }>("git_execute_stage_files", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      paths,
      taskId: record.taskId,
    },
  });
  return {
    workspacePath: execution.workspaceRoot,
    stagedPaths: execution.stagedPaths,
    fileCount: execution.fileCount,
    staged: execution.staged,
    output: execution.output,
  };
}

export async function runRestoredGitCreatePullRequest(
  record: DurableApprovalRecord,
): Promise<GitCreatePullRequestExecutionQuickResult> {
  const plan = record.gitCreatePullRequestPlan;
  if (!plan) {
    throw new Error("Restored Git pull request approval does not include a pull request plan.");
  }
  const sessionId = record.taskId;
  await invoke("git_restore_create_pull_request_approval", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      taskId: record.taskId,
      preview: plan.preview,
    },
  });
  await invoke("git_approve_create_pull_request", {
    approvalId: record.approvalId,
    taskId: record.taskId,
  });
  const execution = await invoke<{
    workspaceRoot: string;
    provider: string;
    url: string;
    title: string;
    baseBranch: string;
    headBranch: string;
    draft: boolean;
    created: boolean;
    output: string;
  }>("git_execute_create_pull_request", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      title: plan.preview.title,
      body: plan.preview.body,
      baseBranch: plan.preview.baseBranch,
      draft: plan.preview.draft,
      taskId: record.taskId,
    },
  });
  return {
    workspacePath: execution.workspaceRoot,
    provider: execution.provider,
    url: execution.url,
    title: execution.title,
    baseBranch: execution.baseBranch,
    headBranch: execution.headBranch,
    draft: execution.draft,
    created: execution.created,
    output: execution.output,
  };
}

export async function runRestoredGitCommentPullRequest(
  record: DurableApprovalRecord,
): Promise<GitCommentPullRequestExecutionQuickResult> {
  const plan = record.gitCommentPullRequestPlan;
  if (!plan) {
    throw new Error("Restored Git pull request comment approval does not include a comment plan.");
  }
  const sessionId = record.taskId;
  await invoke("git_restore_comment_pull_request_approval", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      taskId: record.taskId,
      preview: plan.preview,
    },
  });
  await invoke("git_approve_comment_pull_request", {
    approvalId: record.approvalId,
    taskId: record.taskId,
  });
  const execution = await invoke<{
    workspaceRoot: string;
    provider: string;
    pullRequest: string;
    commented: boolean;
    output: string;
  }>("git_execute_comment_pull_request", {
    request: {
      approvalId: record.approvalId,
      sessionId,
      workspaceRoot: record.workspacePath,
      pullRequest: plan.preview.pullRequest,
      body: plan.preview.body,
      taskId: record.taskId,
    },
  });
  return {
    workspacePath: execution.workspaceRoot,
    provider: execution.provider,
    pullRequest: execution.pullRequest,
    commented: execution.commented,
    output: execution.output,
  };
}

export function createRestoredCodePatchApprovedTask(
  record: DurableApprovalRecord,
  applyResult: CodeApplyResult,
  verification: ShellCommandOutput,
): TaskSnapshot {
  const applyStatus = applyResult.applied && verification.exitCode === 0 ? "completed" : "failed";
  return withRestoredVerificationResult({
    ...createRestoredCodePatchApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title:
      applyStatus === "completed"
        ? "Code Agent patch applied"
        : "Code Agent patch verification failed",
    status: applyStatus,
    commanderMessage:
      applyStatus === "completed"
        ? "Restored permission was approved, the patch was applied, and post-apply verification passed."
        : "Restored permission was approved, but post-apply verification did not pass.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    codeApplyResult: applyResult,
    commands: [verification],
    verificationSummary:
      applyStatus === "completed"
        ? `verified: restored Code Agent patch applied to ${applyResult.changedFiles.length} file(s), and post-apply git diff --check passed.`
        : `failed: restored Code Agent patch apply result was ${applyResult.applied ? "applied" : "not applied"} and post-apply git diff --check returned exit code ${verification.exitCode ?? "unknown"}.`,
  });
}

export function createRestoredCodePatchFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return withRestoredVerificationResult({
    ...createRestoredCodePatchApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "Code Agent patch application failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native patch application failed.",
    permissionRequest: record.permissionRequest,
    approvalOutcome: createRestoredApprovalOutcome(record, "approved"),
    verificationSummary: `failed: restored Code Agent patch application failed before verification; ${error instanceof Error ? error.message : String(error)}`,
    logs: [
      ...createRestoredCodePatchApprovalTask(record).logs,
      {
        id: `${record.taskId}-code-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}
