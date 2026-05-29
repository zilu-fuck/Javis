import type { FormEventHandler } from "react";
import type { WorkbenchFileEntry, WorkbenchLocale } from "../types";
import { ChatComposer } from "./ChatComposer";

interface NewChatProps {
  currentWorkspacePath: string;
  composeMode?: "chat" | "project";
  draftGoal: string;
  labels: WorkbenchLocale["labels"];
  recentWorkspacePaths: string[];
  showWorkspaceContext?: boolean;
  userDocuments?: WorkbenchFileEntry[];
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

export function NewChat({
  currentWorkspacePath,
  composeMode = "chat",
  draftGoal,
  labels,
  recentWorkspacePaths,
  showWorkspaceContext = false,
  userDocuments,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onDraftGoalChange,
  onSubmit,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: NewChatProps) {
  const isProjectMode = composeMode === "project";
  return (
    <section className="javis-new-chat" aria-label={labels.newChat}>
      <h1>{isProjectMode ? labels.newChatTitle : labels.chatNewChatTitle}</h1>
      <ChatComposer
        actionsClassName="javis-new-chat-actions"
        className="javis-new-chat-composer"
        currentWorkspacePath={currentWorkspacePath}
        draftGoal={draftGoal}
        labels={labels}
        taskInputPlaceholder={isProjectMode ? labels.taskInputPlaceholder : labels.chatTaskInputPlaceholder}
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onSubmit={onSubmit}
        onUseWorkspacePath={onUseWorkspacePath}
        onWorkspacePathChange={onWorkspacePathChange}
        recentWorkspacePaths={recentWorkspacePaths}
        sendButtonClassName="javis-send-button"
        showWorkspaceContext={showWorkspaceContext}
        userDocuments={userDocuments}
      />
    </section>
  );
}
