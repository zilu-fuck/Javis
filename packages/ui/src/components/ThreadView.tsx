import type { FormEventHandler } from "react";
import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { translateWorkbenchText } from "../utils";
import { StreamingMessage } from "./StreamingMessage";
import { TaskSections } from "./TaskSections";
import { WorkspaceContext } from "./WorkspaceContext";

interface ThreadViewProps {
  currentWorkspacePath: string;
  draftGoal: string;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  recentWorkspacePaths: string[];
  task: WorkbenchTask;
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onPermissionDecision?: (decision: "approved" | "denied") => void;
  onRetryTask?: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

export function ThreadView({
  currentWorkspacePath,
  draftGoal,
  labels,
  locale,
  recentWorkspacePaths,
  task,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onDraftGoalChange,
  onPermissionDecision,
  onRetryTask,
  onSubmit,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: ThreadViewProps) {
  const showStreaming = Boolean(task.isStreaming && task.streamingText);

  return (
    <>
      <header className="javis-thread-header">
        <div>
          <p className="javis-eyebrow">{labels.mainThread}</p>
          <h1 className="javis-title">{translateWorkbenchText(task.title, locale)}</h1>
        </div>
        <div className="javis-thread-header-actions">
          {task.status === "failed" ? (
            <button
              className="javis-retry-button"
              onClick={onRetryTask}
              type="button"
            >
              {labels.retryTask}
            </button>
          ) : null}
          <span className="javis-task-status">{translateWorkbenchText(task.status, locale)}</span>
        </div>
      </header>

      <section className="javis-thread" aria-label={labels.activeTask}>
        <article className="javis-message user">
          <p className="javis-message-title">{labels.user}</p>
          <p className="javis-message-body">{translateWorkbenchText(task.userGoal, locale)}</p>
        </article>

        {showStreaming ? (
          <StreamingMessage
            text={task.streamingText!}
            isStreaming={task.isStreaming!}
            agentLabel={labels.commander}
          />
        ) : (
          <article className="javis-message">
            <p className="javis-message-title">{labels.commander}</p>
            <p className="javis-message-body">
              {translateWorkbenchText(task.commanderMessage, locale)}
            </p>
          </article>
        )}

        {!showStreaming && (
          <TaskSections
            labels={labels}
            locale={locale}
            onPermissionDecision={onPermissionDecision}
            task={task}
          />
        )}
      </section>

      <form className="javis-composer" onSubmit={onSubmit}>
        <textarea
          aria-label={labels.taskInput}
          disabled={showStreaming}
          onChange={(event) => onDraftGoalChange(event.currentTarget.value)}
          placeholder={labels.taskInputPlaceholder}
          value={draftGoal}
        />
        <div className="javis-composer-actions">
          <WorkspaceContext
            currentWorkspacePath={currentWorkspacePath}
            labels={labels}
            onBrowseWorkspacePath={onBrowseWorkspacePath}
            onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
            onUseWorkspacePath={onUseWorkspacePath}
            onWorkspacePathChange={onWorkspacePathChange}
            recentWorkspacePaths={recentWorkspacePaths}
          />
          <button type="submit" disabled={showStreaming}>{labels.send}</button>
        </div>
      </form>
    </>
  );
}
