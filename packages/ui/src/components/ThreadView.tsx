import { useEffect, useRef, useState, type FormEventHandler } from "react";
import type {
  WorkbenchLocale,
  WorkbenchStreamingAgentKind,
  WorkbenchTask,
} from "../types";
import { useSmoothStream } from "../use-smooth-stream";
import { formatTokenCount, translateWorkbenchText } from "../utils";
import { ChatComposer } from "./ChatComposer";
import { StreamingMessage } from "./StreamingMessage";
import { TaskSections } from "./TaskSections";

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
  onStopTask?: () => void;
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
  onStopTask,
  onSubmit,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: ThreadViewProps) {
  const streaming = useRenderedStreamingText(task);
  const showStreaming = streaming.isVisible;

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
            text={streaming.text}
            isStreaming={streaming.showCursor}
            agentLabel={getStreamingAgentLabel(streaming.agentKind, labels)}
          />
        ) : (
          <article className="javis-message">
            <p className="javis-message-title">{labels.commander}</p>
            <p className="javis-message-body">
              {translateWorkbenchText(task.commanderMessage, locale)}
            </p>
            {task.tokenUsage && task.tokenUsage.modelCalls > 0 ? (
              <p className="javis-token-inline" aria-label={labels.tokenUsage}>
                <span>{labels.tokenUsage}</span>
                <span>
                  {formatTokenCount(task.tokenUsage.totalTokens)}
                </span>
                <span>
                  {labels.tokenInput} {formatTokenCount(task.tokenUsage.inputTokens)}
                </span>
                <span>
                  {labels.tokenOutput} {formatTokenCount(task.tokenUsage.outputTokens)}
                </span>
              </p>
            ) : null}
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

      <ChatComposer
        actionsClassName="javis-composer-actions"
        className="javis-composer"
        currentWorkspacePath={currentWorkspacePath}
        isStreaming={showStreaming}
        draftGoal={draftGoal}
        labels={labels}
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onStopTask={onStopTask}
        onSubmit={onSubmit}
        onUseWorkspacePath={onUseWorkspacePath}
        onWorkspacePathChange={onWorkspacePathChange}
        recentWorkspacePaths={recentWorkspacePaths}
      />
    </>
  );
}

function useRenderedStreamingText(task: WorkbenchTask): {
  agentKind: WorkbenchStreamingAgentKind;
  isVisible: boolean;
  showCursor: boolean;
  text: string;
} {
  const rawText = task.streamingText ?? "";
  const isStreaming = Boolean(task.isStreaming);
  const resetKey = task.id ?? task.userGoal;
  const [active, setActive] = useState(Boolean(isStreaming || rawText));
  const [targetText, setTargetText] = useState(rawText);
  const [activeAgentKind, setActiveAgentKind] =
    useState<WorkbenchStreamingAgentKind>(task.streamingAgentKind ?? "commander");
  const resetKeyRef = useRef(resetKey);
  const resetPending = resetKeyRef.current !== resetKey;
  const resolvedAgentKind = task.streamingAgentKind ?? activeAgentKind;
  const effectiveAgentKind = resetPending
    ? (task.streamingAgentKind ?? "commander")
    : resolvedAgentKind;
  const finalText = getFinalStreamingText(task, resolvedAgentKind);
  const { displayedContent, isSettled } = useSmoothStream({
    content: targetText,
    isStreaming: isStreaming || active,
  });

  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      setActive(Boolean(isStreaming || rawText));
      setActiveAgentKind(task.streamingAgentKind ?? "commander");
      setTargetText(rawText);
      return;
    }

    if (isStreaming || rawText) {
      setActive(true);
      setActiveAgentKind(resolvedAgentKind);
      setTargetText(rawText);
      return;
    }

    if (active) {
      setTargetText(finalText);
    }
  }, [
    active,
    finalText,
    isStreaming,
    rawText,
    resetKey,
    resolvedAgentKind,
    task.streamingAgentKind,
  ]);

  useEffect(() => {
    if (!isStreaming && active && isSettled) {
      setActive(false);
      setTargetText("");
    }
  }, [active, isSettled, isStreaming]);

  // When streaming ends and rawText is already cleared, force-exit the
  // streaming state.  Without this, the hook deadlocks when the final
  // text (commanderMessage) is byte-identical to the last streamed text:
  // setTargetText(finalText) produces no content change in useSmoothStream,
  // so isSettled stays false forever.
  useEffect(() => {
    if (!isStreaming && active && !rawText) {
      setActive(false);
      setTargetText("");
    }
  }, [active, isStreaming, rawText]);

  const shouldShowText = active || isStreaming || Boolean(rawText);

  return {
    agentKind: effectiveAgentKind,
    isVisible: resetPending
      ? Boolean(isStreaming || rawText)
      : isStreaming || active || Boolean(rawText),
    showCursor: resetPending ? isStreaming : isStreaming || (active && !isSettled),
    text: resetPending ? rawText : shouldShowText ? displayedContent : "",
  };
}

function getFinalStreamingText(
  task: WorkbenchTask,
  agentKind: WorkbenchStreamingAgentKind,
): string {
  switch (agentKind) {
    case "verifier":
      return task.verificationSummary ?? task.commanderMessage;
    case "research":
      return task.researchReport?.summary ?? task.commanderMessage;
    default:
      return task.commanderMessage;
  }
}

function getStreamingAgentLabel(
  agentKind: WorkbenchStreamingAgentKind,
  labels: WorkbenchLocale["labels"],
): string {
  switch (agentKind) {
    case "verifier":
      return labels.verifier;
    case "research":
      return labels.researchReport;
    default:
      return labels.commander;
  }
}
