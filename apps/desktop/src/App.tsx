import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { createFileScanTaskRuntime, createInitialTaskSnapshot } from "@javis/core";
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
import "./App.css";

type PersistedTaskSnapshot = ReturnType<typeof createInitialTaskSnapshot>;
export const DEFAULT_DRAFT_GOAL = "检查当前项目，说明如何启动，并运行一次检查";

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
                apiKey: modelSettings.apiKey,
                baseUrl: modelSettings.baseUrl,
              },
            }),
          applyProposedEdit: (edit: CodeProposedEdit) =>
            invoke<CodeApplyResult>("apply_code_patch", {
              request: {
                workspacePath: edit.workspacePath,
                changedFiles: edit.changedFiles,
                patch: edit.patch,
              },
            }),
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
  const [draftGoal, setDraftGoal] = useState(DEFAULT_DRAFT_GOAL);

  useEffect(() => {
    const unsubscribe = runtime.subscribe((nextTask) => {
      setTask(nextTask);
      if (isArchivableTask(nextTask)) {
        setHistory((current) =>
          saveTaskHistory(window.localStorage, upsertTaskHistory(current, nextTask)),
        );
      }
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

  function updateModelSettings(settings: ModelSettings) {
    setModelSettings(saveModelSettings(window.localStorage, settings));
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
      onPermissionDecision={runtime.resolvePermission}
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
