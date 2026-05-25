import { type FormEvent } from "react";
import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { NewChat } from "./NewChat";
import { ThreadView } from "./ThreadView";

interface ChatViewProps {
  task: WorkbenchTask;
  draftGoal: string;
  currentWorkspacePath: string;
  locale: WorkbenchLocale;
  recentWorkspacePaths: string[];
  onDraftGoalChange: (goal: string) => void;
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
  onPermissionDecision?: (decision: "approved" | "denied") => void;
  onRetryTask?: () => void;
  onSubmitGoal: (goal?: string, workspacePath?: string, scheduledTaskId?: string) => void;
}

export function ChatView({
  task,
  draftGoal,
  currentWorkspacePath,
  locale,
  recentWorkspacePaths,
  onDraftGoalChange,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onUseWorkspacePath,
  onWorkspacePathChange,
  onPermissionDecision,
  onRetryTask,
  onSubmitGoal,
}: ChatViewProps) {
  const labels = locale.labels;
  const isNewChat =
    task.status === "created" &&
    task.plan.length === 0 &&
    !task.documents &&
    !task.commands &&
    !task.fileOrganizationExecution &&
    !task.permissionRequest &&
    !task.project &&
    !task.codeReviewPreview &&
    !task.codeProposedEdit &&
    !task.codeApplyResult &&
    !task.researchReport &&
    !task.sources &&
    !task.verificationSummary;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmitGoal();
  }

  if (isNewChat) {
    return (
      <NewChat
        currentWorkspacePath={currentWorkspacePath}
        draftGoal={draftGoal}
        labels={labels}
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onSubmit={handleSubmit}
        onUseWorkspacePath={onUseWorkspacePath}
        onWorkspacePathChange={onWorkspacePathChange}
        recentWorkspacePaths={recentWorkspacePaths}
      />
    );
  }

  return (
    <ThreadView
      currentWorkspacePath={currentWorkspacePath}
      draftGoal={draftGoal}
      labels={labels}
      locale={locale}
      onBrowseWorkspacePath={onBrowseWorkspacePath}
      onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
      onDraftGoalChange={onDraftGoalChange}
      onPermissionDecision={onPermissionDecision}
      onRetryTask={onRetryTask}
      onSubmit={handleSubmit}
      onUseWorkspacePath={onUseWorkspacePath}
      onWorkspacePathChange={onWorkspacePathChange}
      recentWorkspacePaths={recentWorkspacePaths}
      task={task}
    />
  );
}
