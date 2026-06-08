import { invoke } from "@tauri-apps/api/core";
import {
  createInitialTaskSnapshot,
  validateCodeApplyResult,
  validateCodeProposal,
  type TaskSnapshot,
} from "@javis/core";
import type { CodeApplyResult, FileOrganizationExecution, ShellCommandOutput } from "@javis/tools";
import {
  findPendingApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";

export const PDF_APPROVAL_TOOL_NAME = "file.executePdfOrganization";
export const PDF_APPROVAL_TITLE = "Approve PDF move plan";
export const CODE_PATCH_APPROVAL_TOOL_NAME = "code.applyProposedEdit";
export const CODE_PATCH_APPROVAL_TITLE = "Approve Code Agent patch application";

export function findRestorableApprovalRecord(
  approvalRecords: DurableApprovalRecord[],
): DurableApprovalRecord | undefined {
  return (
    findPendingApprovalRecord(approvalRecords, PDF_APPROVAL_TOOL_NAME) ??
    findPendingApprovalRecord(approvalRecords, CODE_PATCH_APPROVAL_TOOL_NAME)
  );
}

export function isDurableApprovalRequestTitle(title: string): boolean {
  return title === PDF_APPROVAL_TITLE || title === CODE_PATCH_APPROVAL_TITLE;
}

export function getDurableApprovalToolName(title: string): string | undefined {
  if (title === PDF_APPROVAL_TITLE) {
    return PDF_APPROVAL_TOOL_NAME;
  }
  if (title === CODE_PATCH_APPROVAL_TITLE) {
    return CODE_PATCH_APPROVAL_TOOL_NAME;
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
  return "";
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

export function createRestoredPdfDeniedTask(record: DurableApprovalRecord): TaskSnapshot {
  return {
    ...createRestoredPdfApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "PDF organization denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not move or modify files.",
    permissionRequest: record.permissionRequest,
    verificationSummary: "verified: restored permission denied; no write operation was executed.",
  };
}

export function createRestoredPdfApprovedTask(
  record: DurableApprovalRecord,
  execution: FileOrganizationExecution,
): TaskSnapshot {
  return {
    ...createRestoredPdfApprovalTask(record),
    id: `restored-approval-approved-${record.taskId}`,
    title: execution.failedCount === 0 ? "PDF organization completed" : "PDF organization completed with failures",
    status: execution.failedCount === 0 ? "completed" : "failed",
    commanderMessage: "Restored permission was approved and the PDF organization dry-run executed.",
    permissionRequest: record.permissionRequest,
    fileOrganizationExecution: execution,
    verificationSummary: `${execution.failedCount === 0 ? "verified" : "failed"}: ${execution.movedCount}/${execution.attemptedCount} PDF move(s) completed, ${execution.skippedCount} skipped, ${execution.failedCount} failed.`,
  };
}

export function createRestoredPdfFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return {
    ...createRestoredPdfApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "PDF organization execution failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native execution failed.",
    permissionRequest: record.permissionRequest,
    logs: [
      ...createRestoredPdfApprovalTask(record).logs,
      {
        id: `${record.taskId}-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  };
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
  return {
    ...createRestoredCodePatchApprovalTask(record),
    id: `restored-approval-denied-${record.taskId}`,
    title: "Code Agent patch denied",
    status: "completed",
    commanderMessage: "Permission was denied after restore. Javis did not apply the patch.",
    permissionRequest: record.permissionRequest,
    verificationSummary: "verified: restored Code Agent patch was denied and no write operation was executed.",
  };
}

export function createRestoredCodePatchApprovedTask(
  record: DurableApprovalRecord,
  applyResult: CodeApplyResult,
  verification: ShellCommandOutput,
): TaskSnapshot {
  const applyStatus = applyResult.applied && verification.exitCode === 0 ? "completed" : "failed";
  return {
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
    codeApplyResult: applyResult,
    commands: [verification],
    verificationSummary:
      applyStatus === "completed"
        ? `verified: restored Code Agent patch applied to ${applyResult.changedFiles.length} file(s), and post-apply git diff --check passed.`
        : `failed: restored Code Agent patch apply result was ${applyResult.applied ? "applied" : "not applied"} and post-apply git diff --check returned exit code ${verification.exitCode ?? "unknown"}.`,
  };
}

export function createRestoredCodePatchFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): TaskSnapshot {
  return {
    ...createRestoredCodePatchApprovalTask(record),
    id: `restored-approval-failed-${record.taskId}`,
    title: "Code Agent patch application failed",
    status: "failed",
    commanderMessage: "Restored permission was approved, but native patch application failed.",
    permissionRequest: record.permissionRequest,
    logs: [
      ...createRestoredCodePatchApprovalTask(record).logs,
      {
        id: `${record.taskId}-code-approval-restore-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}
