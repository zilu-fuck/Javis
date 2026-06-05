import { type FormEvent, useRef } from "react";
import type {
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchModelConfiguration,
  WorkbenchNewChatRecommendations,
  WorkbenchPermissionDecision,
  WorkbenchTask,
} from "../types";
import { NewChat } from "./NewChat";
import { ThreadView } from "./ThreadView";

interface ChatViewProps {
  task: WorkbenchTask;
  draftGoal: string;
  currentWorkspacePath: string;
  locale: WorkbenchLocale;
  modelConfiguration?: WorkbenchModelConfiguration;
  newChatRecommendations?: WorkbenchNewChatRecommendations;
  recentWorkspacePaths: string[];
  activeComposeMode?: "chat" | "project";
  userDocuments?: WorkbenchFileEntry[];
  onDraftGoalChange: (goal: string) => void;
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
  onPermissionDecision?: (decision: WorkbenchPermissionDecision) => void;
  onAskUserAnswer?: (answer: string) => void;
  onRetryTask?: () => void;
  onStopTask?: () => void;
  onSelectAgent?: (agentId: string) => void;
  selectedAgentId?: string;
  onSubmitGoal: (goal?: string, workspacePath?: string, scheduledTaskId?: string, attachments?: File[], imageDataUrls?: string[]) => void;
}

export function ChatView({
  task,
  draftGoal,
  currentWorkspacePath,
  locale,
  modelConfiguration,
  newChatRecommendations,
  recentWorkspacePaths,
  activeComposeMode,
  userDocuments,
  onDraftGoalChange,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onUseWorkspacePath,
  onWorkspacePathChange,
  onPermissionDecision,
  onAskUserAnswer,
  onRetryTask,
  onStopTask,
  onSelectAgent,
  selectedAgentId,
  onSubmitGoal,
}: ChatViewProps) {
  const labels = locale.labels;
  const isNewChat = task.id === "task-idle";
  const showWorkspaceContext =
    activeComposeMode === "project" || Boolean(task.project || task.codeReviewPreview || task.codeProposedEdit || task.codeApplyResult);
  const pendingAttachmentsRef = useRef<File[]>([]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = pendingAttachmentsRef.current;
    pendingAttachmentsRef.current = [];
    onSubmitGoal(undefined, undefined, undefined, files.length > 0 ? files : undefined);
  }

  async function handleSubmitWithAttachments(_goal: string, files: File[]) {
    // Limit: max 5 images, max 10 MB each.
    const imageFiles = files.filter((f) => f.type.startsWith("image/")).slice(0, 5);
    const validFiles = imageFiles.filter((f) => f.size <= 10 * 1024 * 1024);
    const dataUrls = await Promise.all(validFiles.map(fileToDataUrl));
    pendingAttachmentsRef.current = [];
    // Don't pass goalOverride — let submitGoal read from draftGoal so
    // conversation continuation works (continuation checks !goalOverride).
    onSubmitGoal(undefined, undefined, undefined, undefined, dataUrls.length > 0 ? dataUrls : undefined);
    // Clear input after submit reads draftGoal.
    onDraftGoalChange("");
  }

  if (isNewChat) {
    return (
      <NewChat
        composeMode={activeComposeMode ?? "chat"}
        currentWorkspacePath={currentWorkspacePath}
        draftGoal={draftGoal}
        labels={labels}
        recommendations={newChatRecommendations}
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onSubmit={handleSubmit}
        onSubmitWithAttachments={handleSubmitWithAttachments}
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
      onAskUserAnswer={onAskUserAnswer}
      onRetryTask={onRetryTask}
      onStopTask={onStopTask}
      onSelectAgent={onSelectAgent}
      selectedAgentId={selectedAgentId}
      onSubmit={handleSubmit}
      onSubmitWithAttachments={handleSubmitWithAttachments}
      onUseWorkspacePath={onUseWorkspacePath}
      onWorkspacePathChange={onWorkspacePathChange}
      recentWorkspacePaths={recentWorkspacePaths}
      showWorkspaceContext={showWorkspaceContext}
      task={task}
      userDocuments={userDocuments}
    />
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
