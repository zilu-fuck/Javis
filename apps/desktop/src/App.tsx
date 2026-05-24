import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createFileScanTaskRuntime,
  createInitialTaskSnapshot,
  validateCodeApplyResult,
  validateCodeProposal,
} from "@javis/core";
import type {
  CodeApplyResult,
  CodeProposedEdit,
  CodeReviewPreview,
  FileOrganizationExecution,
  FileOrganizationPlan,
  MarkdownDocument,
  PlannedPathOperation,
  ProjectInspection,
  ShellCommandOutput,
  ShellCommandRequest,
  WebSource,
  WebSourceRequest,
  WebSearchRequest,
  WebSearchResult,
} from "@javis/tools";
import { JavisWorkbench, zhCNWorkbenchLocale } from "@javis/ui";
import {
  getTaskUpdatedAt,
  isArchivableTask,
  loadTaskHistory,
  saveTaskHistory,
  upsertTaskHistory,
} from "./task-history";
import {
  deletePersistedWorkspacePath,
  getCompletedTaskWorkspacePath,
  loadWorkspaceSession,
  persistWorkspaceForTaskStatus,
} from "./workspace-session";
import { loadModelSettings, saveModelSettings, type ModelSettings } from "./model-settings";
import { parseGitStatusFiles } from "./git-status";
import {
  createApprovalRecordFromPermissionRequest,
  expireApprovalRecord,
  findPendingApprovalRecord,
  isApprovalRecordExpired,
  loadApprovalRecords,
  resolveApprovalRecord,
  saveApprovalRecords,
  upsertApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";
import "./App.css";

type PersistedTaskSnapshot = ReturnType<typeof createInitialTaskSnapshot>;
export const DEFAULT_DRAFT_GOAL = "检查当前项目，说明如何启动，并运行一次检查";
const PDF_APPROVAL_TOOL_NAME = "file.executePdfOrganization";
const PDF_APPROVAL_TITLE = "Approve PDF move plan";
const CODE_PATCH_APPROVAL_TOOL_NAME = "code.applyProposedEdit";
const CODE_PATCH_APPROVAL_TITLE = "Approve Code Agent patch application";

function App() {
  const [workspaceSession, setWorkspaceSession] = useState(() =>
    loadWorkspaceSession(window.localStorage),
  );
  const { recentWorkspacePaths, workspacePath } = workspaceSession;
  const [modelSettings, setModelSettings] = useState(() =>
    loadModelSettings(window.localStorage),
  );
  const runtime = useMemo(
    () => {
      const runReadOnlyCommand = (request: ShellCommandRequest) =>
        invoke<ShellCommandOutput>("run_read_only_command", {
          request: {
            ...request,
            workspacePath: request.workspacePath ?? (workspacePath.trim() || null),
          },
        });

      return createFileScanTaskRuntime({
        fileTool: {
          scanMarkdownDocuments: () =>
            invoke<MarkdownDocument[]>("scan_markdown_documents", {
              workspacePath: workspacePath.trim() || null,
            }),
          planPdfOrganization: () =>
            invoke<FileOrganizationPlan>("plan_pdf_organization"),
          executePdfOrganization: async (
            operations: PlannedPathOperation[],
            approvalId: string,
          ) => {
            await invoke("approve_pdf_organization", { approvalId });
            return invoke<FileOrganizationExecution>("execute_pdf_organization", {
              request: { approvalId, operations },
            });
          },
        },
        shellTool: {
          runReadOnlyCommand,
        },
        codeTool: {
          inspectRepository: async (): Promise<CodeReviewPreview> => {
            const [status, diffStat, diff] = await Promise.all([
              runReadOnlyCommand({ program: "git", args: ["status", "--short"], workspacePath: null }),
              runReadOnlyCommand({ program: "git", args: ["diff", "--stat"], workspacePath: null }),
              runReadOnlyCommand({ program: "git", args: ["diff", "--unified=1"], workspacePath: null }),
            ]);

            for (const output of [status, diffStat, diff]) {
              if (output.exitCode !== 0) {
                throw new Error(output.stderr || output.stdout || `${output.command} failed`);
              }
            }

            return {
              workspacePath: status.cwd,
              changedFiles: parseGitStatusFiles(status.stdout),
              diffStat: diffStat.stdout,
              diff: diff.stdout,
            };
          },
          proposeEdit: ({ userGoal, preview }) =>
            invoke<CodeProposedEdit>("propose_code_edit", {
              request: {
                workspacePath: preview.workspacePath,
                userGoal,
                changedFiles: preview.changedFiles,
                diff: preview.diff,
                providerId: modelSettings.provider,
                model: modelSettings.model,
                apiKeyReference: modelSettings.apiKeyReference,
                baseUrl: modelSettings.baseUrl,
              },
            }),
          applyProposedEdit: (edit: CodeProposedEdit, approval) =>
            invoke("approve_code_patch", {
              request: {
                approvalId: approval.approvalId,
                proposalId: edit.proposalId,
                workspacePath: edit.workspacePath,
                changedFiles: edit.changedFiles,
                patchHash: edit.patchHash,
              },
            }).then(() =>
              invoke<CodeApplyResult>("apply_code_patch", {
                request: {
                  approvalId: approval.approvalId,
                  proposalId: edit.proposalId,
                  workspacePath: edit.workspacePath,
                  changedFiles: edit.changedFiles,
                  patch: edit.patch,
                  patchHash: edit.patchHash,
                },
              }),
            ),
        },
        projectTool: {
          inspectProject: () =>
            invoke<ProjectInspection>("inspect_project", {
              workspacePath: workspacePath.trim() || null,
            }),
        },
        webTool: {
          fetchWebSource: (request: WebSourceRequest) =>
            invoke<WebSource>("fetch_web_source", { request }),
          searchWeb: (request: WebSearchRequest) =>
            invoke<WebSearchResult[]>("search_web_sources", { request }),
        },
      });
    },
    [modelSettings, workspacePath],
  );
  const [task, setTask] = useState(createInitialTaskSnapshot);
  const [history, setHistory] = useState<PersistedTaskSnapshot[]>(() =>
    loadTaskHistory(window.localStorage),
  );
  const [approvalRecords, setApprovalRecords] = useState(() =>
    loadApprovalRecords(window.localStorage),
  );
  const didCheckRestoredApproval = useRef(false);
  const [draftGoal, setDraftGoal] = useState(DEFAULT_DRAFT_GOAL);

  useEffect(() => {
    const unsubscribe = runtime.subscribe((nextTask) => {
      setTask(nextTask);
      if (isArchivableTask(nextTask)) {
        setHistory((current) =>
          saveTaskHistory(window.localStorage, upsertTaskHistory(current, nextTask)),
        );
      }
      persistDurableApprovalRecord(nextTask);
      if (nextTask.status === "completed") {
        persistWorkspaceForTask(
          nextTask.status,
          getCompletedTaskWorkspacePath(nextTask) || workspacePath,
        );
      }
    });
    return () => {
      unsubscribe();
      runtime.dispose();
    };
  }, [runtime, workspacePath]);

  useEffect(() => {
    if (didCheckRestoredApproval.current) {
      return;
    }
    didCheckRestoredApproval.current = true;
    const pendingRecord =
      findPendingApprovalRecord(approvalRecords, PDF_APPROVAL_TOOL_NAME) ??
      findPendingApprovalRecord(approvalRecords, CODE_PATCH_APPROVAL_TOOL_NAME);
    if (!pendingRecord) {
      return;
    }
    if (isApprovalRecordExpired(pendingRecord)) {
      updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
      return;
    }
    if (pendingRecord.toolName === CODE_PATCH_APPROVAL_TOOL_NAME) {
      if (!pendingRecord.codeProposedEdit) {
        updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
        return;
      }
      setTask(createRestoredCodePatchApprovalTask(pendingRecord));
      return;
    }
    setTask(createRestoredPdfApprovalTask(pendingRecord));
  }, [approvalRecords]);

  function submitGoal() {
    const goal = draftGoal.trim();
    if (!goal) {
      return;
    }
    runtime.start(goal);
  }

  function retryCurrentTask() {
    const goal = task.userGoal.trim();
    if (!goal) {
      return;
    }
    setDraftGoal(goal);
    runtime.start(goal);
  }

  function persistWorkspaceForTask(
    status: PersistedTaskSnapshot["status"],
    completedWorkspacePath: string,
  ) {
    setWorkspaceSession((current) => ({
      ...current,
      recentWorkspacePaths: persistWorkspaceForTaskStatus(
        window.localStorage,
        current.recentWorkspacePaths,
        completedWorkspacePath,
        status,
      ),
    }));
  }

  function useWorkspacePath(path: string) {
    setWorkspaceSession((current) => ({
      ...current,
      workspacePath: path.trim(),
    }));
  }

  async function browseWorkspacePath() {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "Select Javis workspace",
    });
    if (typeof selectedPath === "string") {
      useWorkspacePath(selectedPath);
    }
  }

  function deleteRecentWorkspacePath(path: string) {
    setWorkspaceSession((current) => {
      const recentWorkspacePaths = deletePersistedWorkspacePath(
        window.localStorage,
        current.recentWorkspacePaths,
        path,
      );
      return {
        workspacePath:
          current.workspacePath.toLocaleLowerCase() === path.trim().toLocaleLowerCase()
            ? recentWorkspacePaths[0] ?? ""
            : current.workspacePath,
        recentWorkspacePaths,
      };
    });
  }

  async function updateModelSettings(settings: ModelSettings) {
    const savedSettings = saveModelSettings(window.localStorage, settings);
    const shouldDeleteSecret = !settings.apiKey.trim() && modelSettings.apiKey.trim();
    setModelSettings(savedSettings);
    try {
      if (settings.apiKey.trim()) {
        await invoke("save_model_api_key_secret", {
          request: {
            keyReference: savedSettings.apiKeyReference,
            apiKey: settings.apiKey,
          },
        });
      } else if (shouldDeleteSecret) {
        await invoke("delete_model_api_key_secret", {
          keyReference: savedSettings.apiKeyReference,
        });
      }
    } catch (error) {
      console.error("Failed to update model API key secret", error);
    }
  }

  function persistDurableApprovalRecord(nextTask: PersistedTaskSnapshot) {
    const request = nextTask.permissionRequest;
    if (
      nextTask.status !== "waiting_permission" ||
      !request ||
      request.status !== "pending" ||
      (request.title !== PDF_APPROVAL_TITLE && request.title !== CODE_PATCH_APPROVAL_TITLE)
    ) {
      return;
    }
    const toolName = getDurableApprovalToolName(request.title);
    if (!toolName) {
      return;
    }
    const record = createApprovalRecordFromPermissionRequest({
      taskId: nextTask.id,
      toolName,
      workspacePath: getDurableApprovalWorkspacePath(nextTask, request.title),
      permissionRequest: request,
      codeProposedEdit: request.title === CODE_PATCH_APPROVAL_TITLE
        ? nextTask.codeProposedEdit
        : undefined,
    });
    if (!record) {
      return;
    }
    setApprovalRecords((current) =>
      saveApprovalRecords(window.localStorage, upsertApprovalRecord(current, record)),
    );
  }

  function updateApprovalRecord(record: DurableApprovalRecord) {
    setApprovalRecords((current) =>
      saveApprovalRecords(window.localStorage, upsertApprovalRecord(current, record)),
    );
  }

  async function resolveRestoredApproval(decision: "approved" | "denied") {
    const record =
      findPendingApprovalRecord(approvalRecords, PDF_APPROVAL_TOOL_NAME) ??
      findPendingApprovalRecord(approvalRecords, CODE_PATCH_APPROVAL_TOOL_NAME);
    if (!record) {
      return;
    }
    if (record.toolName === CODE_PATCH_APPROVAL_TOOL_NAME) {
      await resolveRestoredCodePatchApproval(record, decision);
      return;
    }
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      const deniedTask = createRestoredPdfDeniedTask(deniedRecord);
      updateApprovalRecord(deniedRecord);
      setTask(deniedTask);
      setHistory((current) =>
        saveTaskHistory(window.localStorage, upsertTaskHistory(current, deniedTask)),
      );
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      await invoke("restore_pdf_organization_approval", {
        request: {
          approvalId: approvedRecord.approvalId,
          operations: approvedRecord.permissionRequest.dryRun.affectedPaths,
        },
      });
      const execution = await invoke<FileOrganizationExecution>("execute_pdf_organization", {
        request: {
          approvalId: approvedRecord.approvalId,
          operations: approvedRecord.permissionRequest.dryRun.affectedPaths,
        },
      });
      const completedTask = createRestoredPdfApprovedTask(approvedRecord, execution);
      setTask(completedTask);
      setHistory((current) =>
        saveTaskHistory(window.localStorage, upsertTaskHistory(current, completedTask)),
      );
    } catch (error) {
      const failedTask = createRestoredPdfFailedTask(approvedRecord, error);
      setTask(failedTask);
      setHistory((current) =>
        saveTaskHistory(window.localStorage, upsertTaskHistory(current, failedTask)),
      );
    }
  }

  async function resolveRestoredCodePatchApproval(
    record: DurableApprovalRecord,
    decision: "approved" | "denied",
  ) {
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      const deniedTask = createRestoredCodePatchDeniedTask(deniedRecord);
      updateApprovalRecord(deniedRecord);
      setTask(deniedTask);
      setHistory((current) =>
        saveTaskHistory(window.localStorage, upsertTaskHistory(current, deniedTask)),
      );
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const applyResult = await applyRestoredCodePatch(approvedRecord);
      const verification = await runRestoredCodePatchVerification(approvedRecord.workspacePath);
      const completedTask = createRestoredCodePatchApprovedTask(
        approvedRecord,
        applyResult,
        verification,
      );
      setTask(completedTask);
      setHistory((current) =>
        saveTaskHistory(window.localStorage, upsertTaskHistory(current, completedTask)),
      );
    } catch (error) {
      const failedTask = createRestoredCodePatchFailedTask(approvedRecord, error);
      setTask(failedTask);
      setHistory((current) =>
        saveTaskHistory(window.localStorage, upsertTaskHistory(current, failedTask)),
      );
    }
  }

  function handlePermissionDecision(decision: "approved" | "denied") {
    const request = task.permissionRequest;
    if (
      task.status === "waiting_permission" &&
      request?.status === "pending" &&
      (request.title === PDF_APPROVAL_TITLE || request.title === CODE_PATCH_APPROVAL_TITLE)
    ) {
      const record = approvalRecords.find((item) => item.approvalId === request.id);
      if (record?.status === "pending") {
        updateApprovalRecord(resolveApprovalRecord(record, decision, new Date().toISOString()));
      }
    }
    runtime.resolvePermission(decision);
  }

  function selectHistoryEntry(id: string) {
    const entry = history.find((item) => item.id === id);
    if (entry) {
      setTask(entry);
      setDraftGoal(entry.userGoal);
    }
  }

  function deleteHistoryEntry(id: string) {
    setHistory((current) =>
      saveTaskHistory(
        window.localStorage,
        current.filter((entry) => entry.id !== id),
      ),
    );
  }

  return (
    <JavisWorkbench
      draftGoal={draftGoal}
      currentWorkspacePath={workspacePath}
      historyEntries={history.map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        userGoal: entry.userGoal,
        updatedAt: getTaskUpdatedAt(entry),
      }))}
      locale={zhCNWorkbenchLocale}
      modelSettings={modelSettings}
      onBrowseWorkspacePath={browseWorkspacePath}
      onDeleteHistoryEntry={deleteHistoryEntry}
      onDeleteRecentWorkspacePath={deleteRecentWorkspacePath}
      onDraftGoalChange={setDraftGoal}
      onModelSettingsChange={updateModelSettings}
      onPermissionDecision={
        task.id.startsWith("restored-approval-") ? resolveRestoredApproval : handlePermissionDecision
      }
      onRetryTask={retryCurrentTask}
      onSelectHistoryEntry={selectHistoryEntry}
      onSubmitGoal={submitGoal}
      onUseWorkspacePath={useWorkspacePath}
      onWorkspacePathChange={useWorkspacePath}
      recentWorkspacePaths={recentWorkspacePaths}
      task={task}
    />
  );
}

export default App;

function createRestoredPdfApprovalTask(record: DurableApprovalRecord): PersistedTaskSnapshot {
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

function createRestoredCodePatchApprovalTask(record: DurableApprovalRecord): PersistedTaskSnapshot {
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

function getDurableApprovalToolName(title: string): string | undefined {
  if (title === PDF_APPROVAL_TITLE) {
    return PDF_APPROVAL_TOOL_NAME;
  }
  if (title === CODE_PATCH_APPROVAL_TITLE) {
    return CODE_PATCH_APPROVAL_TOOL_NAME;
  }
  return undefined;
}

function getDurableApprovalWorkspacePath(
  task: PersistedTaskSnapshot,
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

function createRestoredPdfDeniedTask(record: DurableApprovalRecord): PersistedTaskSnapshot {
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

function createRestoredPdfApprovedTask(
  record: DurableApprovalRecord,
  execution: FileOrganizationExecution,
): PersistedTaskSnapshot {
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

function createRestoredPdfFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): PersistedTaskSnapshot {
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

async function applyRestoredCodePatch(record: DurableApprovalRecord): Promise<CodeApplyResult> {
  const edit = record.codeProposedEdit;
  if (!edit) {
    throw new Error("Restored Code Patch approval does not include a patch proposal.");
  }
  const proposalSafetyError = validateCodeProposal(edit);
  if (proposalSafetyError) {
    throw new Error(proposalSafetyError);
  }
  await invoke("approve_code_patch", {
    request: {
      approvalId: record.approvalId,
      proposalId: edit.proposalId,
      workspacePath: edit.workspacePath,
      changedFiles: edit.changedFiles,
      patchHash: edit.patchHash,
    },
  });
  const applyResult = await invoke<CodeApplyResult>("apply_code_patch", {
    request: {
      approvalId: record.approvalId,
      proposalId: edit.proposalId,
      workspacePath: edit.workspacePath,
      changedFiles: edit.changedFiles,
      patch: edit.patch,
      patchHash: edit.patchHash,
    },
  });
  const applySafetyError = validateCodeApplyResult(edit, applyResult);
  if (applySafetyError) {
    throw new Error(applySafetyError);
  }
  return applyResult;
}

async function runRestoredCodePatchVerification(
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

function createRestoredCodePatchDeniedTask(
  record: DurableApprovalRecord,
): PersistedTaskSnapshot {
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

function createRestoredCodePatchApprovedTask(
  record: DurableApprovalRecord,
  applyResult: CodeApplyResult,
  verification: ShellCommandOutput,
): PersistedTaskSnapshot {
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

function createRestoredCodePatchFailedTask(
  record: DurableApprovalRecord,
  error: unknown,
): PersistedTaskSnapshot {
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
