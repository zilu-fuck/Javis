import { Fragment, useEffect, useRef, useState, type FormEventHandler } from "react";
import type {
  WorkbenchFileEntry,
  WorkbenchChatMessage,
  WorkbenchDetailItem,
  WorkbenchLocale,
  WorkbenchModelConfiguration,
  WorkbenchPermissionDecision,
  WorkbenchStreamingAgentKind,
  WorkbenchTask,
  WorkbenchWorkspaceToolAction,
} from "../types";
import { useSmoothStream } from "../use-smooth-stream";
import {
  getTaskStatusLabel,
  getTaskStatusProgress,
  isChineseLocale,
  stripVisionContextMarkers,
  translateWorkbenchText,
} from "../utils";
import { AgentDetailSections } from "./AgentDetailSections";
import { AgentOrchestrationPanel } from "./AgentOrchestrationPanel";
import { AgentSummaryList } from "./AgentSummaryList";
import { getParticipatingAgents } from "./agent-visibility";
import { ChatComposer } from "./ChatComposer";
import { ContextRing } from "./ContextRing";
import { ContextStats } from "./ContextStats";
import { Markdown } from "./Markdown";
import { StreamingMessage } from "./StreamingMessage";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { TaskSections } from "./TaskSections";
import { TaskProgressCard } from "./TaskProgressCard";

interface ThreadViewProps {
  composeMode?: "chat" | "project";
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
  onConversationMessagesChange?: (messages: WorkbenchChatMessage[]) => void;
  onResubmitConversationMessage?: (messageContent: string, messages: WorkbenchChatMessage[]) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
  onOpenFile?: (path: string) => void;
  onOpenWorkspaceTool?: (action: WorkbenchWorkspaceToolAction) => void;
  onSelectComposeMode?: (mode: "chat" | "project") => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onSubmitWithAttachments?: (goal: string, attachments: File[]) => void;
  onSelectAgent?: (agentId: string) => void;
  selectedAgentId?: string;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

export function ThreadView({
  composeMode = "chat",
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
  onConversationMessagesChange,
  onResubmitConversationMessage,
  onOpenDetail,
  onOpenFile,
  onOpenWorkspaceTool,
  onSelectComposeMode,
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
  const autoScrollTaskRef = useRef<string | undefined>(undefined);
  const [commanderExpanded, setCommanderExpanded] = useState(false);
  const [terminalDetailsExpanded, setTerminalDetailsExpanded] = useState(false);
  const [localConversationMessages, setLocalConversationMessages] =
    useState<WorkbenchChatMessage[] | null>(null);
  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const hasPendingPermissionRequest =
    task.status === "waiting_permission" && task.permissionRequest?.status === "pending";
  const hasPendingAskUserQuestion =
    task.status === "waiting_info" && task.askUserQuestion?.status === "pending";
  const hasInlinePrompts = Boolean(
    task.status === "failed" || hasPendingPermissionRequest || hasPendingAskUserQuestion,
  );
  const hasActivePrompt = hasPendingPermissionRequest || hasPendingAskUserQuestion;
  const showExecutionPanels = !hasActivePrompt;
  const isTerminalTask = isTerminalTaskStatus(task.status);
  const hasExecutionProgress = Boolean(task.plan?.length) && task.status !== "created";
  const hasExecutionResults = getParticipatingAgents(task).some(
    (agent) => agent.status === "completed" || agent.status === "failed",
  );
  const unfilteredConversationMessages = task.conversationMessages?.length
    ? task.conversationMessages
    : createFallbackConversationMessages(task);
  const progressFilteredMessages = unfilteredConversationMessages.filter((message) =>
    !isSupersededTaskProgressMilestone(message, task.id ?? "")
  );
  const sourceConversationMessages = isTerminalTask
    ? ensureTerminalConclusionMessage(
        collapseTerminalExecutionMessages(progressFilteredMessages),
        task,
      )
    : progressFilteredMessages;
  const conversationMessages = localConversationMessages
    ? isTerminalTask
      ? ensureTerminalConclusionMessage(
          collapseTerminalExecutionMessages(localConversationMessages),
          task,
        )
      : localConversationMessages
    : sourceConversationMessages;
  const hasConversationMessages = conversationMessages.length > 0;
  const lastConversationMessage = conversationMessages[conversationMessages.length - 1];
  const actionLabels = getMessageActionLabels(locale);
  const composerStatusHint = hasPendingAskUserQuestion
    ? translateWorkbenchText("Answer the question card above to continue.", locale)
    : hasPendingPermissionRequest
      ? translateWorkbenchText("Review the permission card above to continue.", locale)
      : undefined;
  const isActiveTask = !["completed", "failed", "cancelled"].includes(task.status);
  const showStreamingResponse = showStreaming && isActiveTask && !hasActivePrompt;
  const showLiveCommanderMessage = Boolean(
    !task.taskProgress &&
    (
      task.status === "planning" ||
      task.status === "running" ||
      task.status === "generating" ||
      task.status === "verifying" ||
      task.status === "retrying"
    ) &&
    lastConversationMessage?.role === "user" &&
    task.commanderMessage.trim() &&
    (
      !showStreamingResponse ||
      (streaming.agentKind === "commander" && !streaming.text.trim())
    ),
  );
  const showStreamingMessage = showStreamingResponse && !showLiveCommanderMessage;
  const taskProgressMessageIndex = task.taskProgress && lastConversationMessage?.role === "assistant"
    ? conversationMessages.length - 1
    : -1;
  const reasoningText = task.streamingReasoningText ?? "";
  const showReasoningPanel = showStreamingResponse && reasoningText.trim().length > 0;
  const reasoningTextRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = reasoningTextRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [reasoningText]);

  useEffect(() => {
    setLocalConversationMessages(null);
    setEditingMessageKey(null);
    setEditingContent("");
  }, [task.id, task.conversationMessages]);

  useEffect(() => {
    setTerminalDetailsExpanded(false);
  }, [task.id, task.status]);

  useEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (typeof anchor?.scrollIntoView !== "function") {
      return;
    }
    const isNewTask = autoScrollTaskRef.current !== task.id;
    autoScrollTaskRef.current = task.id;
    const scrollContainer = anchor.parentElement;
    const distanceFromBottom = scrollContainer
      ? scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
      : 0;
    if (!isNewTask && distanceFromBottom > 160) {
      return;
    }
    anchor.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [showStreamingMessage, showReasoningPanel, task.commanderMessage, task.id]);

  function commitConversationMessages(messages: WorkbenchChatMessage[]) {
    setLocalConversationMessages(messages);
    onConversationMessagesChange?.(messages);
  }

  function handleWithdrawMessage(messageIndex: number) {
    const message = conversationMessages[messageIndex];
    if (message?.role !== "user" || isActiveTask) {
      return;
    }
    commitConversationMessages(conversationMessages.slice(0, messageIndex));
  }

  function handleQuoteMessage(message: WorkbenchChatMessage, displayContent: string) {
    onDraftGoalChange(formatDraftWithQuote(draftGoal, message, displayContent, actionLabels.quotePrefix));
  }

  function handleStartEdit(messageKey: string, displayContent: string) {
    setEditingMessageKey(messageKey);
    setEditingContent(displayContent);
  }

  function handleCancelEdit() {
    setEditingMessageKey(null);
    setEditingContent("");
  }

  function handleSaveEdit(messageIndex: number) {
    if (!editingContent.trim()) {
      return;
    }
    const message = conversationMessages[messageIndex];
    if (message?.role !== "user" || isActiveTask) {
      return;
    }
    const nextContent = editingContent.trim();
    const nextMessages = conversationMessages.slice(0, messageIndex + 1).map((item, index) =>
      index === messageIndex
        ? { ...item, content: nextContent }
        : item,
    );
    if (onResubmitConversationMessage) {
      onResubmitConversationMessage(nextContent, nextMessages);
    } else {
      commitConversationMessages(nextMessages);
      onDraftGoalChange(nextContent);
    }
    handleCancelEdit();
  }

  function renderExecutionPanels() {
    if (isTerminalTask || !showExecutionPanels || (!hasExecutionProgress && !hasExecutionResults)) return null;
    return (
      <div
        aria-label={translateWorkbenchText("Execution progress", locale)}
        className="javis-execution-summary"
        role="region"
      >
        <AgentOrchestrationPanel
          task={task}
          locale={locale}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
        />

        <AgentSummaryList
          agents={task.agents}
          task={task}
          selectedAgentId={selectedAgentId}
          locale={locale}
          onSelectAgent={(id) => onSelectAgent?.(id)}
        />
      </div>
    );
  }

  function renderResultDetails() {
    if (!isTerminalTask) {
      return (
        <>
          <ToolActivityCards task={task} locale={locale} />
          <ArtifactCards
            task={task}
            locale={locale}
            onOpenDetail={onOpenDetail}
            onOpenFile={onOpenFile}
            onOpenWorkspaceTool={onOpenWorkspaceTool}
          />
          <ContextStats task={task} labels={labels} />
        </>
      );
    }

    const activities = buildToolActivities(task, locale);
    const artifacts = buildArtifacts(task);

    const detailsId = `javis-terminal-details-${task.id ?? "current"}`;
    return (
      <section
        aria-label={translateWorkbenchText("Execution details", locale)}
        className={`javis-terminal-execution-details status-${task.status}`}
      >
        <button
          aria-controls={detailsId}
          aria-expanded={terminalDetailsExpanded}
          className="javis-terminal-execution-details-toggle"
          onClick={() => setTerminalDetailsExpanded((value) => !value)}
          type="button"
        >
          <span className="javis-terminal-execution-details-title">
            {translateWorkbenchText("Execution details", locale)}
          </span>
          <span className="javis-terminal-execution-details-summary">
            {formatTerminalDetailsSummary(task, activities.length, artifacts.length, locale)}
          </span>
          <span aria-hidden="true" className="javis-terminal-execution-details-arrow">
            {terminalDetailsExpanded ? "▾" : "▸"}
          </span>
        </button>
        {terminalDetailsExpanded ? (
          <div className="javis-terminal-execution-details-body" id={detailsId}>
            {hasExecutionProgress || hasExecutionResults ? (
              <div className="javis-execution-summary javis-terminal-execution-summary">
                <AgentOrchestrationPanel
                  initiallyExpanded={terminalDetailsExpanded}
                  task={task}
                  locale={locale}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={onSelectAgent}
                />
                <AgentSummaryList
                  agents={task.agents}
                  task={task}
                  selectedAgentId={selectedAgentId}
                  locale={locale}
                  onSelectAgent={(id) => onSelectAgent?.(id)}
                />
              </div>
            ) : null}
            <ToolActivityCards task={task} locale={locale} />
            <ArtifactCards
              task={task}
              locale={locale}
              onOpenDetail={onOpenDetail}
              onOpenFile={onOpenFile}
              onOpenWorkspaceTool={onOpenWorkspaceTool}
            />
            <ContextStats task={task} labels={labels} />
          </div>
        ) : null}
      </section>
    );
  }

  async function handleCopyMessage(messageKey: string, displayContent: string) {
    await writeClipboardText(displayContent);
    setCopiedMessageKey(messageKey);
    window.setTimeout(() => {
      setCopiedMessageKey((current) => current === messageKey ? null : current);
    }, 1400);
  }

  return (
    <div className="javis-thread-view">
      <header className="javis-thread-header">
        <div className="javis-thread-title-group">
          <h1 className="javis-title">{translateWorkbenchText(task.title, locale)}</h1>
          <span className={`javis-task-status-dot status-${task.status}`} aria-hidden="true" />
          <span className="javis-task-status-inline">{getTaskStatusLabel(task.status, locale)}</span>
          {task.status !== "failed" ? (
            <span className="javis-task-progress-inline">
              {getTaskStatusProgress(task.status)}%
            </span>
          ) : null}
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
            if (message.kind === "ask_user_question" && message.askUserQuestion) {
              if (hasPendingAskUserQuestion && task.askUserQuestion?.id === message.askUserQuestion.id) {
                return null;
              }
              return (
                <article className="javis-message javis-message-inline-card" key={message.id ?? `ask-${index}`}>
                  <p className="javis-message-title">{labels.askUserQuestion}</p>
                  <Markdown className="javis-message-body" text={translateWorkbenchText(message.askUserQuestion.question, locale)} />
                </article>
              );
            }
            if (message.kind === "permission_request" && message.permissionRequest) {
              if (hasPendingPermissionRequest && task.permissionRequest?.id === message.permissionRequest.id) {
                return null;
              }
              return (
                <article className="javis-message javis-message-inline-card" key={message.id ?? `permission-${index}`}>
                  <p className="javis-message-title">{translateWorkbenchText(message.permissionRequest.title, locale)}</p>
                  <Markdown className="javis-message-body" text={translateWorkbenchText(message.permissionRequest.reason, locale)} />
                </article>
              );
            }
            const displayContent = message.role === "user"
              ? stripVisionContextMarkers(message.content)
              : getSafeAssistantContent(message.content, task, locale);
            const translatedDisplayContent = translateWorkbenchText(displayContent, locale);
            const messageKey = getConversationMessageKey(message, index);
            const timeoutDetail = message.role === "assistant"
              ? createTimeoutMessageDetail(message, task, locale, modelConfiguration)
              : undefined;
            const canMutateMessage = message.role === "user" && !isActiveTask;
            const shouldInsertExecutionPanels = !showStreamingMessage &&
              message.role === "assistant" &&
              index === conversationMessages.length - 1;
            return (
              <Fragment key={messageKey}>
                {task.taskProgress && taskProgressMessageIndex === index ? (
                  <TaskProgressCard locale={locale} progress={task.taskProgress} />
                ) : null}
                {shouldInsertExecutionPanels ? renderExecutionPanels() : null}
                <article
                  className={`javis-message ${message.role === "user" ? "user" : ""}`}
                >
                  <p className="javis-message-title">
                    <span>{message.role === "user" ? labels.user : formatCommanderTitle(labels.commander)}</span>
                    {message.createdAt ? (
                      <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
                    ) : null}
                  </p>
                  {message.role === "user" && message.attachments?.filter(isSafeAttachmentUrl).map((url, i) => (
                    <img key={i} src={url} className="javis-message-attachment" alt="" />
                  ))}
                  {editingMessageKey === messageKey ? (
                    <div className="javis-message-edit">
                      <textarea
                        aria-label={actionLabels.editTextarea}
                        onChange={(event) => setEditingContent(event.currentTarget.value)}
                        value={editingContent}
                      />
                      <div className="javis-message-edit-actions">
                        <button
                          disabled={!editingContent.trim()}
                          onClick={() => handleSaveEdit(index)}
                          type="button"
                        >
                          {actionLabels.save}
                        </button>
                        <button onClick={handleCancelEdit} type="button">
                          {actionLabels.cancel}
                        </button>
                      </div>
                    </div>
                  ) : timeoutDetail && onOpenDetail ? (
                    <button
                      aria-label={actionLabels.timeoutDetails}
                      className="javis-message-body javis-message-detail-body"
                      onClick={() => onOpenDetail(timeoutDetail)}
                      title={actionLabels.timeoutDetails}
                      type="button"
                    >
                      <span>{translatedDisplayContent}</span>
                      <span aria-hidden="true" className="javis-message-detail-body-icon" />
                    </button>
                  ) : (
                    <Markdown
                      className="javis-message-body"
                      text={translatedDisplayContent}
                    />
                  )}
                  <div className="javis-message-actions" aria-label={actionLabels.actions}>
                    <button
                      aria-label={copiedMessageKey === messageKey ? actionLabels.copied : actionLabels.copy}
                      className="javis-message-action action-copy"
                      onClick={() => void handleCopyMessage(messageKey, translatedDisplayContent)}
                      title={copiedMessageKey === messageKey ? actionLabels.copied : actionLabels.copy}
                      type="button"
                    >
                      <span aria-hidden="true" className="javis-message-action-icon" />
                      <span className="javis-message-action-label">
                        {copiedMessageKey === messageKey ? actionLabels.copied : actionLabels.copy}
                      </span>
                    </button>
                    {canMutateMessage ? (
                      <button
                        aria-label={actionLabels.withdraw}
                        className="javis-message-action action-withdraw"
                        onClick={() => handleWithdrawMessage(index)}
                        title={actionLabels.withdraw}
                        type="button"
                      >
                        <span aria-hidden="true" className="javis-message-action-icon" />
                        <span className="javis-message-action-label">{actionLabels.withdraw}</span>
                      </button>
                    ) : null}
                    <button
                      aria-label={actionLabels.quote}
                      className="javis-message-action action-quote"
                      onClick={() => handleQuoteMessage(message, translatedDisplayContent)}
                      title={actionLabels.quote}
                      type="button"
                    >
                      <span aria-hidden="true" className="javis-message-action-icon" />
                      <span className="javis-message-action-label">{actionLabels.quote}</span>
                    </button>
                    {canMutateMessage ? (
                      <button
                        aria-label={actionLabels.edit}
                        className="javis-message-action action-edit"
                        onClick={() => handleStartEdit(messageKey, translatedDisplayContent)}
                        title={actionLabels.edit}
                        type="button"
                      >
                        <span aria-hidden="true" className="javis-message-action-icon" />
                        <span className="javis-message-action-label">{actionLabels.edit}</span>
                      </button>
                    ) : null}
                  </div>
                  {message.role === "assistant" && index === conversationMessages.length - 1 ? (
                    renderResultDetails()
                  ) : null}
                </article>
              </Fragment>
          )})
        ) : (
          <article className="javis-message user">
            <p className="javis-message-title"><span>{labels.user}</span></p>
            <Markdown className="javis-message-body" text={translateWorkbenchText(task.userGoal, locale)} />
          </article>
        )}

        {task.taskProgress && taskProgressMessageIndex < 0 ? (
          <TaskProgressCard locale={locale} progress={task.taskProgress} />
        ) : null}

        {showLiveCommanderMessage ? (
          <article aria-live="polite" className="javis-message live-progress">
            <p className="javis-message-title">
              <span>{formatCommanderTitle(labels.commander)}</span>
            </p>
            <Markdown
              className="javis-message-body"
              text={translateWorkbenchText(
                getSafeAssistantContent(task.commanderMessage, task, locale),
                locale,
              )}
            />
            <ToolActivityCards task={task} locale={locale} />
          </article>
        ) : null}

        {!showStreamingMessage && lastConversationMessage?.role === "user"
          ? renderExecutionPanels()
          : null}

        {showReasoningPanel ? (
          <article className="javis-message javis-reasoning-stream" aria-live="polite">
            <div className="javis-reasoning-head">
              <ThinkingIndicator label={getThinkingLabel(locale)} messages={getThinkingMessages(locale)} />
            </div>
            <div className="javis-reasoning-text" ref={reasoningTextRef}>{reasoningText}</div>
          </article>
        ) : null}

        {showStreamingMessage ? (
          <>
            {renderExecutionPanels()}
            <StreamingMessage
              text={getReadableStreamingContent(streaming.text, task, locale)}
              isStreaming={streaming.showCursor}
              agentLabel={formatCommanderTitle(getStreamingAgentLabel(streaming.agentKind, labels))}
              thinkingLabel={getThinkingLabel(locale)}
              thinkingMessages={getThinkingMessages(locale)}
            />
          </>
        ) : !hasConversationMessages ? (
          <>
            {renderExecutionPanels()}
            <article className="javis-message">
            <button
              className="javis-message-title javis-expandable-title"
              onClick={() => setCommanderExpanded((prev) => !prev)}
              type="button"
              aria-expanded={commanderExpanded}
            >
              <span>{formatCommanderTitle(labels.commander)}</span>
              <span className="javis-expand-arrow">{commanderExpanded ? "▾" : "▸"}</span>
            </button>
            <Markdown className="javis-message-body" text={getSafeAssistantContent(task.commanderMessage, task, locale)} />
            {renderResultDetails()}
            {commanderExpanded ? (
              <AgentDetailSections labels={labels} locale={locale} task={task} />
            ) : null}
            </article>
          </>
        ) : null}

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
        composeMode={composeMode}
        contextControl={
          <ContextRing
            labels={labels}
            locale={locale}
            task={task}
            modelConfiguration={modelConfiguration}
          />
        }
        currentWorkspacePath={currentWorkspacePath}
        isStreaming={showStreamingResponse}
        disabled={hasActivePrompt}
        draftGoal={draftGoal}
        labels={labels}
        permissionControls={
          hasPendingPermissionRequest && task.permissionRequest
            ? {
                canRequestApproval: false,
                pendingRequest: {
                  allowAlways: task.permissionRequest.allowAlways,
                  onApprove: () => onPermissionDecision?.("approved"),
                  onAllowTask: () => onPermissionDecision?.("approved_always"),
                  onDeny: () => onPermissionDecision?.("denied"),
                },
              }
            : undefined
        }
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onSelectComposeMode={onSelectComposeMode}
        onStopTask={onStopTask}
        onSubmit={onSubmit}
        onSubmitWithAttachments={onSubmitWithAttachments}
        statusHint={composerStatusHint}
        onUseWorkspacePath={onUseWorkspacePath}
        onWorkspacePathChange={onWorkspacePathChange}
        recentWorkspacePaths={recentWorkspacePaths}
        showWorkspaceContext={showWorkspaceContext}
        userDocuments={userDocuments}
      />
    </div>
  );
}

function isSafeAttachmentUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^data:image\//i.test(trimmed)) {
    return false;
  }
  return (
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("asset:") ||
    trimmed.startsWith("/") ||
    /^https?:\/\/asset\.localhost(?:[:/]|$)/i.test(trimmed)
  );
}

function getReadableAssistantContent(
  content: string,
  task: WorkbenchTask,
  locale: WorkbenchLocale,
): string {
  if (!looksLikeCommanderPlanJson(content) || task.plan.length === 0) {
    return translateWorkbenchText(content, locale);
  }
  const isChinese = locale.labels.newChat !== "New chat";
  const lines = task.plan.slice(0, 6).map((step, index) => {
    const status = getTaskStatusLabel(step.status, locale);
    return `${index + 1}. ${translateWorkbenchText(step.title, locale)} (${status})`;
  });
  const remaining = task.plan.length - lines.length;
  const suffix = remaining > 0
    ? isChinese ? `\n...还有 ${remaining} 步` : `\n...and ${remaining} more`
    : "";
  return isChinese
    ? [`我会分 ${task.plan.length} 步处理：`, ...lines].join("\n") + suffix
    : [`I will handle this in ${task.plan.length} step(s):`, ...lines].join("\n") + suffix;
}

function looksLikeCommanderPlanJson(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") &&
    (trimmed.includes("\"steps\"") || trimmed.includes("\"plan\"")) &&
    (trimmed.includes("\"title\"") || trimmed.includes("\"riskSummary\""));
}

function getSafeAssistantContent(
  content: string,
  task: WorkbenchTask,
  locale: WorkbenchLocale,
): string {
  if (looksLikeCommanderPlanJson(content) && task.plan.length > 0) {
    const isChinese = locale.labels.newChat !== "New chat";
    const lines = task.plan.slice(0, 6).map((step, index) => {
      const status = getTaskStatusLabel(step.status, locale);
      return `${index + 1}. ${translateWorkbenchText(step.title, locale)} (${status})`;
    });
    const remaining = task.plan.length - lines.length;
    const suffix = remaining > 0
      ? isChinese ? `\n...还有 ${remaining} 步` : `\n...and ${remaining} more`
      : "";
    return isChinese
      ? [`我会分 ${task.plan.length} 步处理：`, ...lines].join("\n") + suffix
      : [`I will handle this in ${task.plan.length} step(s):`, ...lines].join("\n") + suffix;
  }
  if (looksLikeStructuredDataText(content)) {
    return getStructuredDataPlaceholder(task, locale);
  }
  return getReadableAssistantContent(content, task, locale);
}

function looksLikeStructuredDataText(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  if ((trimmed.startsWith("{") && trimmed.includes("\":")) || trimmed.startsWith("[")) {
    return true;
  }
  return /```json|\"steps\"|\"plan\"|\"needsClarification\"|\"toolName\"|\"assignedAgentKind\"|\"successCriteria\"/i
    .test(trimmed);
}

function getReadableStreamingContent(
  content: string,
  task: WorkbenchTask,
  locale: WorkbenchLocale,
): string {
  return looksLikeStructuredDataText(content)
    ? getStructuredDataPlaceholder(task, locale)
    : content;
}

function getStructuredDataPlaceholder(task: WorkbenchTask, locale: WorkbenchLocale): string {
  const isChinese = locale.labels.newChat !== "New chat";
  if (task.askUserQuestion) {
    return isChinese ? "我需要你补充一个关键信息。" : "I need one detail from you to continue.";
  }
  if (task.plan.length > 0) {
    return isChinese ? "我正在整理可执行计划。" : "I am preparing the executable plan.";
  }
  return isChinese ? "我正在整理结构化结果。" : "I am preparing the structured result.";
}

function formatCommanderTitle(label: string): string {
  return label.toLowerCase().includes("javis") ? label : `Javis · ${label}`;
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getConversationMessageKey(message: WorkbenchChatMessage, index: number): string {
  return message.id ?? `${message.role}-${index}`;
}

function createFallbackConversationMessages(task: WorkbenchTask): WorkbenchChatMessage[] {
  const messages: WorkbenchChatMessage[] = [];
  if (task.userGoal.trim()) {
    messages.push({
      id: `${task.id ?? "fallback"}-user`,
      kind: "user_text",
      role: "user",
      content: task.userGoal,
    });
  }
  if (task.commanderMessage.trim()) {
    messages.push({
      id: `${task.id ?? "fallback"}-assistant`,
      kind: "assistant_text",
      role: "assistant",
      content: task.commanderMessage,
    });
  }
  return messages;
}

function formatDraftWithQuote(
  draftGoal: string,
  message: WorkbenchChatMessage,
  content: string,
  quotePrefix: string,
): string {
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  const excerpt = normalizedContent.length > 160
    ? `${normalizedContent.slice(0, 160)}...`
    : normalizedContent;
  const speaker = message.role === "user" ? "User" : "Javis";
  const quote = `> ${quotePrefix} ${speaker}: ${excerpt}`;
  return draftGoal.trim() ? `${draftGoal.trimEnd()}\n\n${quote}\n` : `${quote}\n`;
}

function getMessageActionLabels(locale: WorkbenchLocale): {
  actions: string;
  copy: string;
  copied: string;
  withdraw: string;
  quote: string;
  edit: string;
  save: string;
  cancel: string;
  editTextarea: string;
  quotePrefix: string;
  timeoutDetails: string;
} {
  const isChinese = locale.labels.newChat !== "New chat";
  return isChinese
    ? {
        actions: "消息操作",
        copy: "复制",
        copied: "已复制",
        withdraw: "撤回",
        quote: "引用",
        edit: "编辑",
        save: "保存",
        cancel: "取消",
        editTextarea: "编辑消息内容",
        quotePrefix: "引用",
        timeoutDetails: "查看超时详情",
      }
    : {
        actions: "Message actions",
        copy: "Copy",
        copied: "Copied",
        withdraw: "Withdraw",
        quote: "Quote",
        edit: "Edit",
        save: "Save",
        cancel: "Cancel",
        editTextarea: "Edit message content",
        quotePrefix: "Quote",
        timeoutDetails: "View timeout details",
      };
}

function isSupersededTaskProgressMilestone(
  message: WorkbenchChatMessage,
  taskId: string,
): boolean {
  if (message.role !== "assistant" || !message.id) return false;
  const prefix = `progress-${taskId}-`;
  return message.id.startsWith(prefix) && message.id !== `${prefix}final`;
}

function collapseTerminalExecutionMessages(
  messages: WorkbenchChatMessage[],
): WorkbenchChatMessage[] {
  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (lastAssistantIndex < 0 && messages[index]?.role === "assistant") {
      lastAssistantIndex = index;
    }
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastAssistantIndex <= lastUserIndex + 1) {
    return messages;
  }
  return messages.filter((message, index) =>
    index <= lastUserIndex ||
    index === lastAssistantIndex ||
    message.kind === "ask_user_question" ||
    message.kind === "permission_request"
  );
}

function ensureTerminalConclusionMessage(
  messages: WorkbenchChatMessage[],
  task: WorkbenchTask,
): WorkbenchChatMessage[] {
  if (
    !task.commanderMessage.trim() ||
    messages[messages.length - 1]?.role === "assistant"
  ) {
    return messages;
  }
  return [
    ...messages,
    {
      id: `${task.id ?? "terminal"}-terminal-conclusion`,
      kind: "assistant_text",
      role: "assistant",
      content: task.commanderMessage,
    },
  ];
}

function createTimeoutMessageDetail(
  message: WorkbenchChatMessage,
  task: WorkbenchTask,
  locale: WorkbenchLocale,
  modelConfiguration?: WorkbenchModelConfiguration,
): WorkbenchDetailItem | undefined {
  const match = message.content.trim().match(/^(.+?)\s+timed out after\s+(\d+)\s*ms\.?$/iu);
  if (!match) return undefined;
  const timeoutMs = Number(match[2]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return undefined;
  const isChinese = locale.labels.newChat !== "New chat";
  const rawStage = match[1].trim();
  const stage = rawStage === "commander.plan"
    ? isChinese ? "Commander 任务规划" : "Commander planning"
    : rawStage.replace(/[._-]+/gu, " ");
  const duration = timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} s` : `${timeoutMs} ms`;
  const commanderProfileId = modelConfiguration?.agentOverrides.commander;
  const commanderProfile = modelConfiguration?.profiles.find((profile) =>
    profile.id === commanderProfileId,
  ) ?? modelConfiguration?.profiles.find((profile) => profile.slot === "primary");
  const modelLabel = commanderProfile?.provider && commanderProfile.model
    ? `${commanderProfile.provider} / ${commanderProfile.model}`
    : undefined;
  const matchingLog = [...task.logs].reverse().find((log) =>
    log.title === "task.timeout" &&
    (log.detail.includes(rawStage) || log.userMessage === message.content),
  );
  const content = isChinese
    ? [
        "## 发生了什么",
        `运行时等待 **${stage}** 超过 ${duration}，随后由本地超时保护终止。`,
        "",
        "## 影响",
        rawStage === "commander.plan"
          ? "DAG 计划尚未生成，因此没有进入工具调用或子代理执行阶段。"
          : "当前阶段没有在期限内完成，后续步骤未继续执行。",
        "",
        "## 建议",
        "- 先重试当前任务；临时的服务商延迟通常可恢复。",
        "- 连续超时时检查模型服务状态，或切换备用模型。",
        "- 长任务可在运行时设置中提高任务超时上限。",
        "",
        "## 原始错误",
        `\`${message.content.trim()}\``,
        ...(matchingLog?.devDetail
          ? ["", "## 运行时记录", matchingLog.devDetail]
          : []),
      ].join("\n")
    : [
        "## What happened",
        `The runtime waited more than ${duration} for **${stage}** and then stopped it with the local timeout guard.`,
        "",
        "## Impact",
        rawStage === "commander.plan"
          ? "No DAG plan was produced, so tools and sub-agents were not started."
          : "The current stage did not finish before the deadline, so later steps were not started.",
        "",
        "## Suggested actions",
        "- Retry the task; transient provider latency often clears.",
        "- If it repeats, check provider health or switch to a fallback model.",
        "- Increase the task timeout for consistently long requests.",
        "",
        "## Original error",
        `\`${message.content.trim()}\``,
        ...(matchingLog?.devDetail
          ? ["", "## Runtime record", matchingLog.devDetail]
          : []),
      ].join("\n");
  return {
    title: isChinese ? "任务超时详情" : "Task timeout details",
    description: isChinese
      ? `${stage} 未在 ${duration} 内完成。`
      : `${stage} did not complete within ${duration}.`,
    content,
    contentFormat: "markdown",
    kind: "Timeout",
    source: "runtime",
    metadata: [
      { label: isChinese ? "阶段" : "Stage", value: rawStage },
      { label: isChinese ? "超时上限" : "Timeout", value: duration },
      ...(modelLabel
        ? [{ label: isChinese ? "当前 Commander 模型" : "Current Commander model", value: modelLabel }]
        : []),
      ...(task.id ? [{ label: isChinese ? "任务 ID" : "Task ID", value: task.id }] : []),
      ...(message.createdAt
        ? [{ label: isChinese ? "发生时间" : "Occurred at", value: message.createdAt }]
        : []),
    ],
  };
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function getThinkingLabel(locale: WorkbenchLocale): string {
  return locale.labels.newChat === "New chat" ? "Thinking" : "思考中";
}

function getThinkingMessages(locale: WorkbenchLocale): string[] {
  return locale.labels.newChat === "New chat"
    ? [
        "Understanding your message",
        "Choosing the right path",
        "Preparing a response",
      ]
    : [
        "正在理解你的需求",
        "正在选择合适路径",
        "正在准备回复",
      ];
}

type ArtifactKind = "doc" | "md" | "code" | "cmd";

type ToolActivityStatus = "planned" | "running" | "completed" | "failed";

interface ThreadToolActivity {
  id: string;
  name: string;
  description: string;
  status: ToolActivityStatus;
}

function ToolActivityCards({ task, locale }: { task: WorkbenchTask; locale: WorkbenchLocale }) {
  const activities = buildToolActivities(task, locale);
  if (activities.length === 0) return null;
  const isChinese = isChineseLocale(locale);
  return (
    <div aria-label={isChinese ? "调用记录" : "Calls"} className="javis-tool-call-list">
      {activities.map((activity) => (
        <article className={`javis-tool-call-card status-${activity.status}`} key={activity.id}>
          <span className="javis-tool-call-icon" aria-hidden="true" />
          <span className="javis-tool-call-copy">
            <strong>{activity.name}</strong>
            <small>{activity.description}</small>
          </span>
          <span className="javis-tool-call-status">
            {getToolActivityStatusLabel(activity.status, isChinese)}
          </span>
        </article>
      ))}
    </div>
  );
}

function buildToolActivities(task: WorkbenchTask, locale: WorkbenchLocale): ThreadToolActivity[] {
  const isChinese = isChineseLocale(locale);
  const activities = new Map<string, ThreadToolActivity>();
  if ((task.tokenUsage?.modelCalls ?? 0) > 0) {
    const callCount = task.tokenUsage?.modelCalls ?? 0;
    const totalTokens = task.tokenUsage?.totalTokens ?? 0;
    activities.set("model-generation", {
      id: "model-generation",
      name: isChinese ? "文本生成模型" : "Text generation model",
      description: isChinese
        ? `${callCount} 次调用 · ${totalTokens.toLocaleString()} tokens`
        : `${callCount} call${callCount === 1 ? "" : "s"} · ${totalTokens.toLocaleString()} tokens`,
      status: task.status === "failed" ? "failed" : task.status === "completed" ? "completed" : "running",
    });
  }

  for (const log of task.logs) {
    const toolNames = log.detail.match(
      /\b(?:browser|code|computer|file|git|scheduler|shell|web|workspace)\.[A-Za-z][\w.]*/gu,
    ) ?? [];
    for (const toolName of toolNames) {
      const nextStatus = inferToolActivityStatus(log);
      const current = activities.get(toolName);
      activities.set(toolName, {
        id: `tool-${toolName}`,
        name: toolName,
        description: translateWorkbenchText(log.userMessage || log.detail, locale),
        status: current && toolActivityStatusRank(current.status) > toolActivityStatusRank(nextStatus)
          ? current.status
          : nextStatus,
      });
    }
  }
  return [...activities.values()].slice(0, 4);
}

function inferToolActivityStatus(log: WorkbenchTask["logs"][number]): ToolActivityStatus {
  const value = `${log.title} ${log.detail}`.toLocaleLowerCase();
  if (/failed|error/.test(value)) return "failed";
  if (/completed|succeeded|task\.completed|\bwrote\b/.test(value)) return "completed";
  if (/started|running/.test(value)) return "running";
  return "planned";
}

function toolActivityStatusRank(status: ToolActivityStatus): number {
  return { planned: 0, running: 1, completed: 2, failed: 3 }[status];
}

function getToolActivityStatusLabel(status: ToolActivityStatus, isChinese: boolean): string {
  if (!isChinese) return status === "completed" ? "Completed" : status[0].toUpperCase() + status.slice(1);
  switch (status) {
    case "planned": return "已计划";
    case "running": return "运行中";
    case "completed": return "已完成";
    case "failed": return "失败";
  }
}

interface ThreadArtifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  ext: string;
  detail?: WorkbenchDetailItem;
  filePath?: string;
  workspaceTool?: WorkbenchWorkspaceToolAction;
}

function ArtifactCards({
  task,
  locale,
  onOpenDetail,
  onOpenFile,
  onOpenWorkspaceTool,
}: {
  task: WorkbenchTask;
  locale: WorkbenchLocale;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
  onOpenFile?: (path: string) => void;
  onOpenWorkspaceTool?: (action: WorkbenchWorkspaceToolAction) => void;
}) {
  const artifacts = buildArtifacts(task);
  if (artifacts.length === 0) {
    return null;
  }

  function openArtifact(artifact: ThreadArtifact) {
    if (artifact.filePath && onOpenFile) {
      onOpenFile(artifact.filePath);
      return;
    }
    if (artifact.detail) {
      onOpenDetail?.(artifact.detail);
    }
    if (artifact.workspaceTool) {
      onOpenWorkspaceTool?.(artifact.workspaceTool);
    }
  }

  return (
    <div className="javis-artifact-list" aria-label="Artifacts">
      {artifacts.map((artifact) => (
        <button
          className="javis-artifact-card"
          key={artifact.id}
          onClick={() => openArtifact(artifact)}
          type="button"
        >
          <span className={`javis-artifact-icon artifact-${artifact.kind}`}>{artifact.ext}</span>
          <span>
            <strong>{translateWorkbenchText(artifact.title, locale)}</strong>
            <small>{artifact.ext}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function buildArtifacts(task: WorkbenchTask): ThreadArtifact[] {
  const artifacts: ThreadArtifact[] = [];

  for (const document of task.documents ?? []) {
    const title = document.heading || getFileName(document.path);
    const ext = getArtifactExt(document.path, "DOC");
    artifacts.push({
      id: `doc-${document.path}`,
      kind: "doc",
      title,
      ext,
      filePath: document.path,
      detail: {
        title,
        description: document.excerpt || document.purpose,
        kind: ext,
        source: document.path,
        metadata: [
          { label: "Path", value: document.path },
          { label: "Purpose", value: document.purpose },
        ],
      },
    });
  }

  if (task.researchReport) {
    artifacts.push({
      id: "research-report",
      kind: "md",
      title: task.researchReport.title || "Research report",
      ext: "MD",
      workspaceTool: "sideChat",
      detail: {
        title: task.researchReport.title || "Research report",
        description: task.researchReport.summary,
        kind: "Research",
        metadata: [
          { label: "Claims", value: String(task.researchReport.rows.length) },
          { label: "Unknowns", value: String(task.researchReport.unknowns.length) },
        ],
      },
    });
  }

  if (task.codeProposedEdit) {
    artifacts.push({
      id: `code-proposal-${task.codeProposedEdit.proposalId}`,
      kind: "code",
      title: task.codeProposedEdit.summary || "Code patch proposal",
      ext: getArtifactExt(task.codeProposedEdit.changedFiles[0], "PATCH"),
      workspaceTool: "review",
      detail: {
        title: "Code patch proposal",
        description: task.codeProposedEdit.summary,
        kind: "Code",
        metadata: [
          { label: "Workspace", value: task.codeProposedEdit.workspacePath },
          { label: "Changed files", value: String(task.codeProposedEdit.changedFiles.length) },
          { label: "Patch hash", value: task.codeProposedEdit.patchHash },
        ],
      },
    });
  }

  if (task.codeReviewPreview && !task.codeProposedEdit) {
    artifacts.push({
      id: "code-review-preview",
      kind: "code",
      title: task.codeReviewPreview.diffStat || "Code review preview",
      ext: getArtifactExt(task.codeReviewPreview.changedFiles[0], "DIFF"),
      workspaceTool: "review",
      detail: {
        title: "Code review preview",
        description: task.codeReviewPreview.diffStat,
        kind: "Code",
        metadata: [
          { label: "Workspace", value: task.codeReviewPreview.workspacePath },
          { label: "Changed files", value: String(task.codeReviewPreview.changedFiles.length) },
        ],
      },
    });
  }

  if (task.codeApplyResult) {
    artifacts.push({
      id: "code-apply-result",
      kind: "code",
      title: task.codeApplyResult.message || "Code apply result",
      ext: task.codeApplyResult.applied ? "OK" : "SKIP",
      workspaceTool: "review",
      detail: {
        title: "Code apply result",
        description: task.codeApplyResult.message,
        kind: "Code",
        metadata: [
          { label: "Workspace", value: task.codeApplyResult.workspacePath },
          { label: "Changed files", value: String(task.codeApplyResult.changedFiles.length) },
          { label: "Applied", value: task.codeApplyResult.applied ? "yes" : "no" },
        ],
      },
    });
  }

  for (const [index, command] of (task.commands ?? []).entries()) {
    artifacts.push({
      id: `cmd-${index}-${command.command}`,
      kind: "cmd",
      title: command.command,
      ext: command.exitCode === 0 ? "OK" : "CMD",
      workspaceTool: "terminal",
      detail: {
        title: command.command,
        description: command.stdout || command.stderr || "No command output",
        kind: "Command",
        metadata: [
          { label: "cwd", value: command.cwd },
          { label: "exit", value: command.exitCode == null ? "unknown" : String(command.exitCode) },
        ],
      },
    });
  }

  return artifacts.slice(0, 4);
}

function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function getArtifactExt(path: string | undefined, fallback: string): string {
  const ext = path?.split(/[/\\]/).pop()?.match(/\.([^.]+)$/)?.[1];
  return (ext || fallback).slice(0, 5).toUpperCase();
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

function isTerminalTaskStatus(status: WorkbenchTask["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function formatTerminalDetailsSummary(
  task: WorkbenchTask,
  activityCount: number,
  artifactCount: number,
  locale: WorkbenchLocale,
): string {
  const isChinese = isChineseLocale(locale);
  const parts: string[] = [];
  if (task.plan.length > 0) {
    const completed = task.plan.filter((step) => step.status === "completed").length;
    parts.push(isChinese ? `${completed}/${task.plan.length} 步骤` : `${completed}/${task.plan.length} steps`);
  }
  if (activityCount > 0) parts.push(isChinese ? `${activityCount} 项调用` : `${activityCount} calls`);
  if (artifactCount > 0) parts.push(isChinese ? `${artifactCount} 个产物` : `${artifactCount} artifacts`);
  return parts.join(" · ") || (isChinese ? "查看运行记录" : "View run records");
}
