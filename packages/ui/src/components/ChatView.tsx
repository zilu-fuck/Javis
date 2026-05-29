import { type FormEvent } from "react";
import type { WorkbenchFileEntry, WorkbenchLocale, WorkbenchModelConfiguration, WorkbenchTask } from "../types";
import { NewChat } from "./NewChat";
import { ThreadView } from "./ThreadView";

interface ChatViewProps {
  task: WorkbenchTask;
  draftGoal: string;
  currentWorkspacePath: string;
  locale: WorkbenchLocale;
  modelConfiguration?: WorkbenchModelConfiguration;
  recentWorkspacePaths: string[];
  activeComposeMode?: "chat" | "project";
  userDocuments?: WorkbenchFileEntry[];
  onDraftGoalChange: (goal: string) => void;
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
  onPermissionDecision?: (decision: "approved" | "denied") => void;
  onRetryTask?: () => void;
  onStopTask?: () => void;
  onSubmitGoal: (goal?: string, workspacePath?: string, scheduledTaskId?: string) => void;
}

export function ChatView({
  task,
  draftGoal,
  currentWorkspacePath,
  locale,
  modelConfiguration,
  recentWorkspacePaths,
  activeComposeMode,
  userDocuments,
  onDraftGoalChange,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onUseWorkspacePath,
  onWorkspacePathChange,
  onPermissionDecision,
  onRetryTask,
  onStopTask,
  onSubmitGoal,
}: ChatViewProps) {
  const labels = locale.labels;
  const isNewChat = task.id === "task-idle";
  const showWorkspaceContext =
    activeComposeMode === "project" || Boolean(task.project || task.codeReviewPreview || task.codeProposedEdit || task.codeApplyResult);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmitGoal();
  }

  if (isNewChat) {
    return (
      <NewChat
        composeMode={activeComposeMode ?? "chat"}
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
        showWorkspaceContext={showWorkspaceContext}
        userDocuments={userDocuments}
      />
    );
  }

  return (
    <ThreadView
      currentWorkspacePath={currentWorkspacePath}
      draftGoal={draftGoal}
      labels={labels}
      locale={locale}
      modelConfiguration={modelConfiguration}
      onBrowseWorkspacePath={onBrowseWorkspacePath}
      onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
      onDraftGoalChange={onDraftGoalChange}
      onPermissionDecision={onPermissionDecision}
      onRetryTask={onRetryTask}
      onStopTask={onStopTask}
      onSubmit={handleSubmit}
      onUseWorkspacePath={onUseWorkspacePath}
      onWorkspacePathChange={onWorkspacePathChange}
      recentWorkspacePaths={recentWorkspacePaths}
      showWorkspaceContext={showWorkspaceContext}
      task={task}
      userDocuments={userDocuments}
    />
  );
}
