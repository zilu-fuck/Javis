import { type FormEvent, useRef } from "react";
import type {
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchModelConfiguration,
  WorkbenchNewChatRecommendations,
  WorkbenchPermissionDecision,
  WorkbenchDetailItem,
  WorkbenchChatMessage,
  WorkbenchGoalEvaluation,
  WorkbenchGoalEvent,
  WorkbenchGoalState,
  WorkbenchSubmitGoalOptions,
  WorkbenchTask,
  WorkbenchWorkspaceToolAction,
} from "../types";
import { isChineseLocale } from "../utils";
import { NewChat } from "./NewChat";
import { ThreadView } from "./ThreadView";

interface ChatViewProps {
  task: WorkbenchTask;
  draftGoal: string;
  currentWorkspacePath: string;
  locale: WorkbenchLocale;
  currentGoal?: WorkbenchGoalState | null;
  currentGoalEvents?: WorkbenchGoalEvent[];
  currentGoalEvaluations?: WorkbenchGoalEvaluation[];
  modelConfiguration?: WorkbenchModelConfiguration;
  newChatRecommendations?: WorkbenchNewChatRecommendations;
  recentWorkspacePaths: string[];
  activeComposeMode?: "chat" | "project";
  userDocuments?: WorkbenchFileEntry[];
  onDraftGoalChange: (goal: string) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onCompleteGoal?: () => void;
  onClearGoal?: () => void;
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
  onPermissionDecision?: (decision: WorkbenchPermissionDecision) => void;
  onAskUserAnswer?: (answer: string) => void;
  onRetryTask?: () => void;
  onStopTask?: () => void;
  onConversationMessagesChange?: (messages: WorkbenchChatMessage[]) => void;
  onConversationMessageResubmit?: (messages: WorkbenchChatMessage[], goal: string) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
  onOpenFile?: (path: string) => void;
  onOpenWorkspaceTool?: (action: WorkbenchWorkspaceToolAction) => void;
  onSelectAgent?: (agentId: string) => void;
  onSelectComposeMode?: (mode: "chat" | "project") => void;
  selectedAgentId?: string;
  onSubmitGoal: (
    goal?: string,
    workspacePath?: string,
    scheduledTaskId?: string,
    attachments?: File[],
    imageDataUrls?: string[],
    options?: WorkbenchSubmitGoalOptions,
  ) => void;
}

export function ChatView({
  task,
  draftGoal,
  currentWorkspacePath,
  locale,
  currentGoal,
  currentGoalEvents = [],
  currentGoalEvaluations = [],
  modelConfiguration,
  newChatRecommendations,
  recentWorkspacePaths,
  activeComposeMode,
  userDocuments,
  onDraftGoalChange,
  onPauseGoal,
  onResumeGoal,
  onCompleteGoal,
  onClearGoal,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onUseWorkspacePath,
  onWorkspacePathChange,
  onPermissionDecision,
  onAskUserAnswer,
  onRetryTask,
  onStopTask,
  onConversationMessagesChange,
  onConversationMessageResubmit,
  onOpenDetail,
  onOpenFile,
  onOpenWorkspaceTool,
  onSelectAgent,
  onSelectComposeMode,
  selectedAgentId,
  onSubmitGoal,
}: ChatViewProps) {
  const labels = locale.labels;
  const isChinese = isChineseLocale(locale);
  const isNewChat = task.id === "task-idle";
  const shouldContinueCurrentTask = !isNewChat && !["completed", "failed", "cancelled"].includes(task.status);
  const submitIntent = isNewChat ? "new_chat" : shouldContinueCurrentTask ? "continue_history" : "new_task";
  const showWorkspaceContext =
    activeComposeMode === "project" || Boolean(task.project || task.codeReviewPreview || task.codeProposedEdit || task.codeApplyResult);
  const pendingAttachmentsRef = useRef<File[]>([]);
  const goalPanel = currentGoal && currentGoal.status !== "cleared" ? (
    <GoalPanel
      goal={currentGoal}
      evaluations={currentGoalEvaluations}
      events={currentGoalEvents}
      isChinese={isChinese}
      onClear={onClearGoal}
      onComplete={onCompleteGoal}
      onPause={onPauseGoal}
      onResume={onResumeGoal}
    />
  ) : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = pendingAttachmentsRef.current;
    pendingAttachmentsRef.current = [];
    onSubmitGoal(
      undefined,
      undefined,
      undefined,
      files.length > 0 ? files : undefined,
      undefined,
      { intent: submitIntent },
    );
  }

  async function handleSubmitWithAttachments(goal: string, files: File[]) {
    // Limit: max 5 images, max 10 MB each.
    const imageFiles = files.filter((f) => f.type.startsWith("image/")).slice(0, 5);
    const validFiles = imageFiles.filter((f) => f.size <= 10 * 1024 * 1024);
    const dataUrls = await Promise.all(validFiles.map(fileToDataUrl));
    pendingAttachmentsRef.current = [];
    // Don't pass goalOverride — let submitGoal read from draftGoal so
    // conversation continuation works (continuation checks !goalOverride).
    onSubmitGoal(
      goal,
      undefined,
      undefined,
      undefined,
      dataUrls.length > 0 ? dataUrls : undefined,
      { intent: submitIntent },
    );
    // Clear input after submit reads draftGoal.
  }

  if (isNewChat) {
    return (
      <>
        {goalPanel}
        <NewChat
          composeMode={activeComposeMode ?? "chat"}
          currentWorkspacePath={currentWorkspacePath}
          draftGoal={draftGoal}
          isChinese={isChinese}
          labels={labels}
          recommendations={newChatRecommendations}
          onBrowseWorkspacePath={onBrowseWorkspacePath}
          onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
          onDraftGoalChange={onDraftGoalChange}
          onSelectComposeMode={onSelectComposeMode}
          onSubmit={handleSubmit}
          onSubmitWithAttachments={handleSubmitWithAttachments}
          onUseWorkspacePath={onUseWorkspacePath}
          onWorkspacePathChange={onWorkspacePathChange}
          recentWorkspacePaths={recentWorkspacePaths}
          showWorkspaceContext={showWorkspaceContext}
          userDocuments={userDocuments}
        />
      </>
    );
  }

  return (
    <>
      {goalPanel}
      <ThreadView
        currentWorkspacePath={currentWorkspacePath}
        composeMode={activeComposeMode ?? "chat"}
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
        onConversationMessagesChange={onConversationMessagesChange}
        onResubmitConversationMessage={(goal, messages) =>
          onConversationMessageResubmit?.(messages, goal)}
        onOpenDetail={onOpenDetail}
        onOpenFile={onOpenFile}
        onOpenWorkspaceTool={onOpenWorkspaceTool}
        onSelectAgent={onSelectAgent}
        onSelectComposeMode={onSelectComposeMode}
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
    </>
  );
}

function GoalPanel({
  goal,
  evaluations,
  events,
  isChinese,
  onClear,
  onComplete,
  onPause,
  onResume,
}: {
  goal: WorkbenchGoalState;
  evaluations: WorkbenchGoalEvaluation[];
  events: WorkbenchGoalEvent[];
  isChinese: boolean;
  onClear?: () => void;
  onComplete?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}) {
  const statusLabel = getGoalStatusLabel(goal.status, isChinese);
  const canPause = goal.status === "active" && onPause;
  const canResume = (goal.status === "paused" || goal.status === "blocked") && onResume;
  const canComplete = goal.status !== "complete" && onComplete;
  const latestEvaluation = [...evaluations].reverse().find((evaluation) => evaluation.goalId === goal.id);
  const visibleEvents = events.filter((event) => event.goalId === goal.id).slice(-4).reverse();
  const missingCriteria = latestEvaluation?.unsatisfiedCriteria ?? [];
  const evidence = latestEvaluation?.evidence ?? [];

  return (
    <section className="javis-goal-panel" aria-label={isChinese ? "当前 Goal" : "Current Goal"}>
      <div className="javis-goal-panel-main">
        <div className="javis-goal-panel-heading">
          <span className={`javis-goal-status status-${goal.status}`}>{statusLabel}</span>
          <strong>{isChinese ? "当前 Goal" : "Current Goal"}</strong>
          <span>{goal.runCount}/{goal.maxRunCount}</span>
        </div>
        <p>{goal.objective}</p>
        {goal.workspacePath ? <small>{goal.workspacePath}</small> : null}
        {goal.blockedReason ? <small>{goal.blockedReason}</small> : null}
      </div>
      <div className="javis-goal-panel-checks">
        <GoalMiniList
          emptyLabel={isChinese ? "暂无完成检查" : "No completed checks"}
          items={goal.completedChecks}
          title={isChinese ? "已完成" : "Completed"}
        />
        <GoalMiniList
          emptyLabel={isChinese ? "无独立验收条件" : "No separate criteria"}
          items={goal.acceptanceCriteria}
          title={isChinese ? "验收条件" : "Criteria"}
        />
        <GoalMiniList
          emptyLabel={isChinese ? "暂无未满足项" : "No open criteria"}
          items={missingCriteria}
          title={isChinese ? "未满足" : "Open"}
        />
        <GoalMiniList
          emptyLabel={isChinese ? "暂无证据" : "No evidence yet"}
          items={evidence}
          title={isChinese ? "证据" : "Evidence"}
        />
      </div>
      <div className="javis-goal-panel-timeline">
        <span>{isChinese ? "时间线" : "Timeline"}</span>
        {visibleEvents.length > 0 ? (
          <ul>
            {visibleEvents.map((event) => (
              <li key={event.id}>
                <strong>{getGoalEventLabel(event.type, isChinese)}</strong>
                {event.message ? <em>{event.message}</em> : null}
              </li>
            ))}
          </ul>
        ) : (
          <em>{isChinese ? "暂无事件" : "No events yet"}</em>
        )}
      </div>
      <div className="javis-goal-panel-actions">
        {canPause ? <button onClick={onPause} type="button">{isChinese ? "暂停" : "Pause"}</button> : null}
        {canResume ? <button onClick={onResume} type="button">{isChinese ? "恢复" : "Resume"}</button> : null}
        {canComplete ? <button onClick={onComplete} type="button">{isChinese ? "完成" : "Complete"}</button> : null}
        {onClear ? <button onClick={onClear} type="button">{isChinese ? "清除" : "Clear"}</button> : null}
      </div>
    </section>
  );
}

function getGoalEventLabel(type: WorkbenchGoalEvent["type"], isChinese: boolean): string {
  if (isChinese) {
    if (type === "created") return "创建";
    if (type === "task_bound") return "绑定任务";
    if (type === "task_terminal") return "任务结束";
    if (type === "evaluated") return "验证";
    if (type === "continued") return "继续";
    if (type === "paused") return "暂停";
    if (type === "resumed") return "恢复";
    if (type === "completed") return "完成";
    if (type === "blocked") return "阻塞";
    if (type === "cleared") return "清除";
    if (type === "handoff_requested") return "转交";
    if (type === "self_refine_started") return "自我修正";
    return "策略";
  }
  if (type === "task_bound") return "Task";
  if (type === "task_terminal") return "Terminal";
  if (type === "strategy_applied") return "Strategy";
  if (type === "handoff_requested") return "Handoff";
  if (type === "self_refine_started") return "Self-refine";
  return type.replace(/_/g, " ");
}

function GoalMiniList({
  emptyLabel,
  items,
  title,
}: {
  emptyLabel: string;
  items: string[];
  title: string;
}) {
  const visibleItems = items.slice(0, 3);
  return (
    <div className="javis-goal-mini-list">
      <span>{title}</span>
      {visibleItems.length > 0 ? (
        <ul>
          {visibleItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : (
        <em>{emptyLabel}</em>
      )}
    </div>
  );
}

function getGoalStatusLabel(status: WorkbenchGoalState["status"], isChinese: boolean): string {
  if (isChinese) {
    if (status === "active") return "执行中";
    if (status === "paused") return "已暂停";
    if (status === "complete") return "已完成";
    if (status === "blocked") return "受阻";
    return "已清除";
  }
  if (status === "active") return "Active";
  if (status === "paused") return "Paused";
  if (status === "complete") return "Complete";
  if (status === "blocked") return "Blocked";
  return "Cleared";
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
