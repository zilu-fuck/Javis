import { type FormEvent } from "react";
import type { WorkbenchLocale, WorkbenchModelConfiguration, WorkbenchTask } from "../types";
import { NewChat } from "./NewChat";
import { ThreadView } from "./ThreadView";

interface ChatViewProps {
  task: WorkbenchTask;
  draftGoal: string;
  currentWorkspacePath: string;
  locale: WorkbenchLocale;
  modelConfiguration?: WorkbenchModelConfiguration;
  recentWorkspacePaths: string[];
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
      task={task}
    />
  );
}
