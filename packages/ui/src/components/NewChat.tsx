import type { FormEventHandler } from "react";
import type { WorkbenchLocale } from "../types";
import { WorkspaceContext } from "./WorkspaceContext";

interface NewChatProps {
  currentWorkspacePath: string;
  draftGoal: string;
  labels: WorkbenchLocale["labels"];
  recentWorkspacePaths: string[];
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

export function NewChat({
  currentWorkspacePath,
  draftGoal,
  labels,
  recentWorkspacePaths,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onDraftGoalChange,
  onSubmit,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: NewChatProps) {
  return (
    <section className="javis-new-chat" aria-label={labels.newChat}>
      <h1>{labels.newChatTitle}</h1>
      <form className="javis-new-chat-composer" onSubmit={onSubmit}>
        <textarea
          aria-label={labels.taskInput}
          onChange={(event) => onDraftGoalChange(event.currentTarget.value)}
          placeholder={labels.taskInputPlaceholder}
          value={draftGoal}
        />
        <div className="javis-new-chat-actions">
          <button className="javis-attach-button" type="button">+</button>
          <WorkspaceContext
            currentWorkspacePath={currentWorkspacePath}
            labels={labels}
            onBrowseWorkspacePath={onBrowseWorkspacePath}
            onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
            onUseWorkspacePath={onUseWorkspacePath}
            onWorkspacePathChange={onWorkspacePathChange}
            recentWorkspacePaths={recentWorkspacePaths}
          />
          <button className="javis-send-button" type="submit">{labels.send}</button>
        </div>
      </form>
    </section>
  );
}
