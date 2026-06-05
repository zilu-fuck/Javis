import { useEffect, useRef, useState, type FormEventHandler } from "react";
import type {
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchModelConfiguration,
  WorkbenchPermissionDecision,
  WorkbenchStreamingAgentKind,
  WorkbenchTask,
} from "../types";
import { useSmoothStream } from "../use-smooth-stream";
import { stripVisionContextMarkers, translateWorkbenchText } from "../utils";
import { AgentDetailSections } from "./AgentDetailSections";
import { AgentSummaryList } from "./AgentSummaryList";
import { ChatComposer } from "./ChatComposer";
import { ContextRing } from "./ContextRing";
import { ContextStats } from "./ContextStats";
import { Markdown } from "./Markdown";
import { StreamingMessage } from "./StreamingMessage";
import { TaskSections } from "./TaskSections";

interface ThreadViewProps {
  currentWorkspacePath: string;
  draftGoal: string;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  modelConfiguration?: WorkbenchModelConfiguration;
  recentWorkspacePaths: string[];
  showWorkspaceContext?: boolean;
  task: WorkbenchTask;
  userDocuments?: WorkbenchFileEntry[];
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onPermissionDecision?: (decision: WorkbenchPermissionDecision) => void;
  onAskUserAnswer?: (answer: string) => void;
  onRetryTask?: () => void;
  onStopTask?: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onSubmitWithAttachments?: (goal: string, attachments: File[]) => void;
  onSelectAgent?: (agentId: string) => void;
  selectedAgentId?: string;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

export function ThreadView({
  currentWorkspacePath,
  draftGoal,
  labels,
  locale,
  modelConfiguration,
  recentWorkspacePaths,
  showWorkspaceContext = false,
  task,
  userDocuments,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onDraftGoalChange,
  onPermissionDecision,
  onAskUserAnswer,
  onRetryTask,
  onStopTask,
  onSubmit,
  onSubmitWithAttachments,
  onSelectAgent,
  selectedAgentId,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: ThreadViewProps) {
  const streaming = useRenderedStreamingText(task);
  const showStreaming = streaming.isVisible;
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const [commanderExpanded, setCommanderExpanded] = useState(false);
  const hasInlinePrompts = Boolean(
    task.status === "failed" || task.permissionRequest || task.askUserQuestion,
  );
  const conversationMessages = task.conversationMessages ?? [];
  const hasConversationMessages = conversationMessages.length > 0;

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [showStreaming, streaming.text, task]);

  return (
    <>
      <header className="javis-thread-header">
        <div className="javis-thread-title-group">
          <h1 className="javis-title">{translateWorkbenchText(task.title, locale)}</h1>
          <span className={`javis-task-status-dot status-${task.status}`} aria-hidden="true" />
          <span className="javis-task-status-inline">{translateWorkbenchText(task.status, locale)}</span>
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
        </div>
      </header>

      <section className="javis-thread" aria-label={labels.activeTask}>
        {hasConversationMessages ? (
          conversationMessages.map((message, index) => {
            const displayContent = message.role === "user"
              ? stripVisionContextMarkers(message.content)
              : message.content;
            return (
            <article
              className={`javis-message ${message.role === "user" ? "user" : ""}`}
              key={`${message.role}-${index}`}
            >
              <p className="javis-message-title">
                {message.role === "user" ? labels.user : labels.commander}
              </p>
              {message.role === "user" && message.attachments?.map((url, i) => (
                <img key={i} src={url} className="javis-message-attachment" alt="" />
              ))}
              <Markdown
                className="javis-message-body"
                text={translateWorkbenchText(displayContent, locale)}
              />
              {message.role === "assistant" && index === conversationMessages.length - 1 ? (
                <ArtifactCards task={task} locale={locale} />
              ) : null}
              {message.role === "assistant" && index === conversationMessages.length - 1 ? (
                <ContextStats task={task} labels={labels} />
              ) : null}
            </article>
          )})
        ) : (
          <article className="javis-message user">
            <p className="javis-message-title">{labels.user}</p>
            <Markdown className="javis-message-body" text={translateWorkbenchText(task.userGoal, locale)} />
          </article>
        )}

        {showStreaming ? (
          <StreamingMessage
            text={streaming.text}
            isStreaming={streaming.showCursor}
            agentLabel={getStreamingAgentLabel(streaming.agentKind, labels)}
          />
        ) : !hasConversationMessages ? (
          <article className="javis-message">
            <button
              className="javis-message-title javis-expandable-title"
              onClick={() => setCommanderExpanded((prev) => !prev)}
              type="button"
              aria-expanded={commanderExpanded}
            >
              <span>{labels.commander}</span>
              <span className="javis-expand-arrow">{commanderExpanded ? "▾" : "▸"}</span>
            </button>
            <Markdown className="javis-message-body" text={translateWorkbenchText(task.commanderMessage, locale)} />
            <ArtifactCards task={task} locale={locale} />
            <ContextStats task={task} labels={labels} />
            {commanderExpanded ? (
              <AgentDetailSections labels={labels} locale={locale} task={task} />
            ) : null}
          </article>
        ) : null}

        {/* Agent summary cards — click to open right sidebar with details */}
        <AgentSummaryList
          agents={task.agents}
          task={task}
          selectedAgentId={selectedAgentId}
          locale={locale}
          onSelectAgent={(id) => onSelectAgent?.(id)}
        />

        {/* Inline interactive prompts (permission & ask-user) — only these stay in the chat */}
        {hasInlinePrompts ? (
          <TaskSections
            labels={labels}
            locale={locale}
            onPermissionDecision={onPermissionDecision}
            onAskUserAnswer={onAskUserAnswer}
            task={task}
          />
        ) : null}
        <div aria-hidden="true" ref={scrollAnchorRef} />
      </section>

      <ChatComposer
        actionsClassName="javis-composer-actions"
        className="javis-composer"
        contextControl={
          <ContextRing
            labels={labels}
            locale={locale}
            task={task}
            modelConfiguration={modelConfiguration}
          />
        }
        currentWorkspacePath={currentWorkspacePath}
        isStreaming={showStreaming}
        draftGoal={draftGoal}
        labels={labels}
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onStopTask={onStopTask}
        onSubmit={onSubmit}
        onSubmitWithAttachments={onSubmitWithAttachments}
        onUseWorkspacePath={onUseWorkspacePath}
        onWorkspacePathChange={onWorkspacePathChange}
        recentWorkspacePaths={recentWorkspacePaths}
        showWorkspaceContext={showWorkspaceContext}
        userDocuments={userDocuments}
      />
    </>
  );
}

function ArtifactCards({ task, locale }: { task: WorkbenchTask; locale: WorkbenchLocale }) {
  const artifacts = buildArtifacts(task);
  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="javis-artifact-list" aria-label="Artifacts">
      {artifacts.map((artifact) => (
        <article className="javis-artifact-card" key={`${artifact.kind}-${artifact.title}`}>
          <span className={`javis-artifact-icon artifact-${artifact.kind}`}>{artifact.ext}</span>
          <span>
            <strong>{translateWorkbenchText(artifact.title, locale)}</strong>
            <small>{artifact.ext}</small>
          </span>
        </article>
      ))}
    </div>
  );
}

function buildArtifacts(task: WorkbenchTask): Array<{ kind: string; title: string; ext: string }> {
  const artifacts: Array<{ kind: string; title: string; ext: string }> = [];
  if (task.documents?.length) {
    artifacts.push({ kind: "doc", title: task.documents[0].heading || "需求说明", ext: "DOCX" });
  }
  if (task.researchReport) {
    artifacts.push({ kind: "md", title: task.researchReport.title || "研究报告", ext: "MD" });
  }
  if (task.codeProposedEdit || task.codeReviewPreview || task.codeApplyResult) {
    artifacts.push({ kind: "code", title: "代码建议", ext: "TS" });
  }
  if (task.commands?.length) {
    artifacts.push({ kind: "cmd", title: "执行计划", ext: "SH" });
  }
  return artifacts.slice(0, 4);
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

  // When streaming ends and rawText is already cleared, exit only after the
  // displayed text has caught up. This preserves the typewriter handoff while
  // avoiding a stale streaming bubble when the final text is byte-identical.
  useEffect(() => {
    if (
      !isStreaming &&
      active &&
      !rawText &&
      targetText === finalText &&
      displayedContent === finalText
    ) {
      setActive(false);
      setTargetText("");
    }
  }, [active, displayedContent, finalText, isStreaming, rawText, targetText]);

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
