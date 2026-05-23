import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createFileScanTaskRuntime, createInitialTaskSnapshot } from "@javis/core";
import type {
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
import "./App.css";

function App() {
  const runtime = useMemo(
    () =>
      createFileScanTaskRuntime({
        fileTool: {
          scanMarkdownDocuments: () =>
            invoke<MarkdownDocument[]>("scan_markdown_documents", { workspacePath: null }),
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
          runReadOnlyCommand: (request: ShellCommandRequest) =>
            invoke<ShellCommandOutput>("run_read_only_command", { request }),
        },
        projectTool: {
          inspectProject: () =>
            invoke<ProjectInspection>("inspect_project", { workspacePath: null }),
        },
        webTool: {
          fetchWebSource: (request: WebSourceRequest) =>
            invoke<WebSource>("fetch_web_source", { request }),
          searchWeb: (request: WebSearchRequest) =>
            invoke<WebSearchResult[]>("search_web_sources", { request }),
        },
      }),
    [],
  );
  const [task, setTask] = useState(createInitialTaskSnapshot);
  const [draftGoal, setDraftGoal] = useState(
    "检查当前项目，说明如何启动，并运行一次检查",
  );

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setTask);
    return () => {
      unsubscribe();
      runtime.dispose();
    };
  }, [runtime]);

  function submitGoal() {
    const goal = draftGoal.trim();
    if (!goal) {
      return;
    }
    runtime.start(goal);
  }

  return (
    <JavisWorkbench
      draftGoal={draftGoal}
      locale={zhCNWorkbenchLocale}
      onDraftGoalChange={setDraftGoal}
      onPermissionDecision={runtime.resolvePermission}
      onSubmitGoal={submitGoal}
      task={task}
    />
  );
}

export default App;
