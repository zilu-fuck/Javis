import type {
  CodeReviewPreview,
  CodeProposedEdit,
  CodeApplyResult,
  CodeTool,
  ComputerTool,
  CommanderTool,
  FileOrganizationExecution,
  FileOrganizationPlan,
  FileTool,
  MarkdownDocumentSummary,
  ModelUsage,
  PermissionRequest as ToolPermissionRequest,
  ProjectInspection,
  ProjectTool,
  ResearchReport,
  ShellCommandOutput,
  ShellTool,
  SchedulerTool,
  VerifierTool,
  WebSource,
  WebTool,
  WorkspaceTool,
  TokenUsageSummary,
} from "@javis/tools";
import type { PendingPermissionHandler } from "./confirmed-write";
import {
  demoAgents,
} from "./agents";
import { runCodeReviewTask } from "./code-review-flow";
import { runFileScanTask } from "./file-scan-flow";
import { runPdfOrganizationPreviewTask } from "./pdf-organization-flow";
import { runProjectInspectionTask } from "./project-inspection-flow";
import { runResearchSearchTask, runResearchSourceTask } from "./research-flow";
import {
  isReadCurrentProjectGoal,
  runGenericWorkbenchWorkflow,
  runReadCurrentProjectWorkflow,
} from "./workflow-executor";
import type { WorkbenchWorkflowId } from "./workflows";
import {
  extractUrls,
  isCodeReviewGoal,
  isDocumentScanGoal,
  isPdfOrganizationGoal,
  isProjectInspectionGoal,
  isResearchGoal,
  getRecommendedWorkflowIds,
} from "./routing";
import { createRuntimeState } from "./runtime-state";
import { appendLog } from "./snapshot-utils";
import { addModelUsage, createEmptyTokenUsageSummary } from "./token-usage";
import type { TaskEventBus } from "./task-event-bus";

export {
  createCodeApplyDryRun,
  parsePatchHunks,
  validateCodeApplyResult,
  validateCodeProposal,
} from "./code-proposal-safety";
export { createDryRunBindingHash } from "./permission-state";
export {
  DOCUMENTED_TASK_TRANSITIONS,
  TASK_STATUSES,
  isTerminalTaskStatus,
  transitionTask,
} from "./state/task-state";
export { demoAgents, getAgentSystemPrompt, createDefaultAgentRegistry } from "./agents";
export type {
  AgentCapabilityTag,
  ModelRequirements,
  AgentRegistration,
  AgentRegistry,
} from "./agent-capability";
export { createAgentRegistry } from "./agent-capability";
export {
  CHINESE_REVIEW_SCORE_SCHEMA,
  createChineseReviewPrompt,
  createChineseRevisionPrompt,
  parseChineseReviewResult,
} from "./chinese-reviewer";
export type {
  ChineseReviewMode,
  ChineseReviewResult,
  ChineseReviewScore,
} from "./chinese-reviewer";
export {
  JAVIS_TERMINOLOGY,
  buildTerminologyPromptPrefix,
  injectTerminologyPrompt,
  shouldInjectTerminology,
} from "./terminology";
export {
  WORKBENCH_WORKFLOWS,
  getWorkbenchWorkflow,
  listWorkbenchWorkflows,
} from "./workflows";
export {
  createTaskEventBus,
  taskEventToLogEntry,
} from "./task-event-bus";
export { createDeltaReducer } from "./delta-reducer";
export type { DeltaReducer } from "./delta-reducer";
export { createSharedTaskContext, CONTEXT_KEYS, contextKeyForLocale } from "./shared-context";
export type { ContextKey, SharedTaskContext } from "./shared-context";
export { localizeError, localizeOpenCodeError } from "./error-localizer";
export { executeWorkflow } from "./workflow-dag-executor";
export type {
  WorkflowExecutionResult,
  WorkflowExecutorOptions,
  WorkflowStepExecutionResult,
} from "./workflow-dag-executor";
export { createAgentStateTracker } from "./agent-state-tracker";
export type {
  AgentState,
  AgentStateTracker,
} from "./agent-state-tracker";
export type {
  TaskEventBus,
  TaskEventHandler,
  TaskEventMiddleware,
  TaskRuntimeEvent,
} from "./task-event-bus";
export type {
  WorkbenchWorkflow,
  WorkbenchWorkflowId,
  WorkbenchWorkflowStep,
} from "./workflows";
export type {
  WorkspaceDefinition,
  WorkspaceAgentDefinition,
  WorkspaceWorkflowDefinition,
  WorkspaceWorkflowStepDefinition,
  WorkspaceToolDefinition,
  WorkspaceRouteDefinition,
} from "./workspace-definition";
export { createWorkflowRegistry } from "./workflow-registry";
export type { WorkflowRegistry } from "./workflow-registry";
export { createRouteRegistry } from "./route-registry";
export type {
  RouteRegistry,
  RouteScoringFn,
  RouteScore,
  RouteScoringContext,
} from "./route-registry";
export type { RouteKind } from "./routing";

export {
  getAdapter,
  registerAdapter,
  listAdapters,
} from "./adapters/adapter-registry";
export { OpenAIAdapter } from "./adapters/openai-adapter";
export { DeepSeekAdapter } from "./adapters/deepseek-adapter";
export { AnthropicAdapter } from "./adapters/anthropic-adapter";
export type {
  ProviderProtocol,
  ProviderCapabilities,
  AdapterCompletionInput,
  AdapterRequestPayload,
  AdapterCompletionResponse,
  ProviderAdapter,
} from "./provider-adapter";

export {
  PREDEFINED_CATEGORIES,
  createClassificationPrompt,
  injectDocumentContext,
} from "./file-classifier";
export type {
  ClassifiableFile,
  ClassifiedFile,
} from "./file-classifier";

export type ID = string;
export type ISODateTime = string;

export type TaskStatus =
  | "created"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentKind =
  | "commander"
  | "file"
  | "shell"
  | "browser"
  | "computer"
  | "scheduler"
  | "research"
  | "code"
  | "verifier"
  | "chinese-reviewer";

export type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type PermissionLevel = "read" | "preview" | "confirmed_write" | "dangerous";
export type VerificationStatus = "verified" | "unverified" | "failed";

export interface Task {
  id: ID;
  title: string;
  userGoal: string;
  status: TaskStatus;
  workspacePath?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  plan?: TaskStep[];
  agentRuns: AgentRun[];
  pendingPermissionRequestId?: ID;
  verification?: VerificationResult;
  tokenUsage?: TokenUsageSummary;
  finalMessage?: string;
}

export interface TaskStep {
  id: ID;
  title: string;
  assignedAgentKind: AgentKind;
  requiredCapabilities?: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  successCriteria?: string;
}

export interface Agent {
  id: ID;
  kind: AgentKind;
  displayName: string;
  description: string;
  allowedToolNames: string[];
  /** @deprecated Use modelRequirements instead */
  preferredModelTags?: string[];
  /** Model capabilities this agent needs from its assigned model profile */
  modelRequirements?: import("./agent-capability").ModelRequirements;
  systemPrompt: AgentPromptSet;
}

export interface AgentPromptSet {
  en: string;
  zhCN: string;
}

export interface AgentRun {
  id: ID;
  taskId: ID;
  agentId: ID;
  agentKind: AgentKind;
  status: AgentRunStatus;
  modelProfileId?: ID;
  inputSummary: string;
  outputSummary?: string;
  tokenUsage?: TokenUsageSummary;
  toolCallIds: ID[];
  error?: TaskError;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
}

export interface ToolCall {
  id: ID;
  taskId: ID;
  agentRunId: ID;
  toolName: string;
  permissionLevel: PermissionLevel;
  status:
    | "planned"
    | "waiting_permission"
    | "running"
    | "succeeded"
    | "failed"
    | "denied"
    | "cancelled";
  inputSummary: string;
  outputSummary?: string;
  dryRun?: DryRunSummary;
  permissionRequestId?: ID;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
  error?: TaskError;
}

export interface DryRunSummary {
  operation: string;
  affectedPaths?: Array<{
    source?: string;
    target?: string;
    action: "create" | "modify" | "move" | "copy" | "delete" | "overwrite";
    conflict?: string;
  }>;
  command?: {
    cwd: string;
    text: string;
    expectedWrites?: string[];
  };
  riskSummary: string;
  reversible: boolean;
}

export interface PermissionRequest {
  id: ID;
  taskId: ID;
  agentRunId: ID;
  toolCallId: ID;
  level: Exclude<PermissionLevel, "read">;
  title: string;
  reason: string;
  dryRun: DryRunSummary;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  createdAt: ISODateTime;
  resolvedAt?: ISODateTime;
}

export interface VerificationResult {
  id: ID;
  taskId: ID;
  status: VerificationStatus;
  checkedAt: ISODateTime;
  summary: string;
  evidence: Array<{
    kind: "file" | "command" | "source" | "log" | "permission" | "manual";
    label: string;
    reference?: string;
    result: "pass" | "warn" | "fail";
  }>;
  retryRecommendation?: {
    shouldRetry: boolean;
    reason: string;
    suggestedAgentKind?: AgentKind;
  };
}

export type TaskEvent =
  | { type: "task.created"; task: Task }
  | { type: "task.status_changed"; taskId: ID; status: TaskStatus }
  | { type: "task.plan_updated"; taskId: ID; plan: TaskStep[] }
  | { type: "agent_run.started"; taskId: ID; agentRun: AgentRun }
  | { type: "agent_run.updated"; taskId: ID; agentRun: AgentRun }
  | { type: "tool_call.planned"; taskId: ID; toolCall: ToolCall }
  | { type: "tool_call.updated"; taskId: ID; toolCall: ToolCall }
  | { type: "permission.requested"; taskId: ID; request: PermissionRequest }
  | { type: "permission.resolved"; taskId: ID; request: PermissionRequest }
  | { type: "verification.completed"; taskId: ID; result: VerificationResult }
  | { type: "task.message"; taskId: ID; role: "system" | "agent" | "user"; content: string }
  | { type: "task.failed"; taskId: ID; error: TaskError }
  | { type: "task.completed"; taskId: ID; finalMessage: string };

export interface TaskError {
  code: string;
  message: string;
  recoverable: boolean;
  detail?: unknown;
}

export interface AgentSnapshot {
  id: ID;
  name: string;
  role: string;
  status: AgentRunStatus;
  task: string;
  tokenUsage?: TokenUsageSummary;
}

export interface TaskLogEntry {
  id: ID;
  kind: "plan" | "tool" | "permission" | "verification" | "event";
  title: string;
  detail: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TaskSnapshot {
  id: ID;
  title: string;
  userGoal: string;
  status: TaskStatus;
  updatedAt?: ISODateTime;
  scheduledTaskId?: ID;
  commanderMessage: string;
  plan: TaskStep[];
  agents: AgentSnapshot[];
  logs: TaskLogEntry[];
  documents?: MarkdownDocumentSummary[];
  commands?: ShellCommandOutput[];
  fileOrganizationExecution?: FileOrganizationExecution;
  fileOrganizationPlan?: FileOrganizationPlan;
  codeReviewPreview?: CodeReviewPreview;
  codeProposedEdit?: CodeProposedEdit;
  codeApplyResult?: CodeApplyResult;
  permissionRequest?: ToolPermissionRequest;
  project?: ProjectInspection;
  researchReport?: ResearchReport;
  sources?: WebSource[];
  tokenUsage?: TokenUsageSummary;
  verificationSummary?: string;
  conversationMessages?: ChatMessage[];
  /** Accumulated partial text during streaming. Non-empty + isStreaming → UI renders StreamingMessage. */
  streamingText?: string;
  /** Agent currently producing streaming output. */
  streamingAgentKind?: AgentKind;
  /** Whether an agent is currently generating streaming output. */
  isStreaming?: boolean;
}

export type { ModelUsage, TokenUsageSummary };
export { addModelUsage, createEmptyTokenUsageSummary };

export interface TaskRuntime {
  getSnapshot(): TaskSnapshot;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
  start(
    userGoal: string,
    options?: {
      taskId?: ID;
      priorMessages?: ChatMessage[];
      mode?: "auto" | "chat" | "project";
    },
  ): void;
  resolvePermission(decision: "approved" | "denied", requestId?: string): void;
  dispose(): void;
}

export interface FileScanRuntimeOptions {
  fileTool: FileTool;
  chatTool?: ChatTool;
  commanderTool?: CommanderTool;
  computerTool?: ComputerTool;
  codeTool?: CodeTool;
  projectTool?: ProjectTool;
  shellTool?: ShellTool;
  schedulerTool?: SchedulerTool;
  verifierTool?: VerifierTool;
  webTool?: WebTool;
  workspaceTool?: WorkspaceTool;
  delayMs?: number;
  eventBus?: TaskEventBus;
  onTaskStarted?: (taskId: string) => void;
}

export interface ChatTool {
  complete(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      locale?: string;
    },
  ): Promise<{
    text: string;
    tokenUsage?: ModelUsage;
  }>;
  stream?(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      locale?: string;
      onUsage?: (usage: ModelUsage) => void;
    },
  ): AsyncIterable<{
    text: string;
  }>;
}

export function createInitialTaskSnapshot(): TaskSnapshot {
  return {
    id: "task-idle",
    title: "Ready",
    userGoal: "Waiting for a task",
    status: "created",
    commanderMessage:
      "Javis desktop is ready. Enter a goal to start the Core event stream.",
    plan: [],
    agents: demoAgents.map((agent) => ({
      id: agent.id,
      name: agent.displayName,
      role: agent.description,
      status: "queued",
      task: "Waiting",
    })),
    logs: [
      {
        id: "log-ready",
        kind: "event",
        title: "Runtime ready",
        detail: "Core runtime is ready for startTask.",
      },
    ],
    tokenUsage: createEmptyTokenUsageSummary(),
  };
}

function isConversationAnswerStatus(status: TaskSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function createFileScanTaskRuntime({
  fileTool,
  chatTool,
  commanderTool,
  computerTool,
  codeTool,
  projectTool,
  shellTool,
  schedulerTool,
  verifierTool,
  webTool,
  delayMs = 250,
  eventBus,
  onTaskStarted,
}: FileScanRuntimeOptions): TaskRuntime {
  const runtimeState = createRuntimeState(createInitialTaskSnapshot(), delayMs);
  const eventBusUnsubscribe = eventBus
    ? eventBus.on((e) => runtimeState.emitDelta(e))
    : undefined;
  const permissionHandlers = new Map<string, PendingPermissionHandler>();
  const queuedPermissionDecisions = new Map<string, "approved" | "denied">();
  let queuedLegacyPermissionDecision: "approved" | "denied" | undefined;
  let activeConversation:
    | { taskId: ID; startedMessages: ChatMessage[] }
    | undefined;
  function emit(nextSnapshot: TaskSnapshot) {
    runtimeState.emit(attachConversationMessages(nextSnapshot));
  }
  function attachConversationMessages(nextSnapshot: TaskSnapshot): TaskSnapshot {
    if (!activeConversation || activeConversation.taskId !== nextSnapshot.id) {
      return nextSnapshot;
    }
    const conversationMessages = nextSnapshot.conversationMessages?.length
      ? [...nextSnapshot.conversationMessages]
      : [...activeConversation.startedMessages];
    if (
      isConversationAnswerStatus(nextSnapshot.status) &&
      nextSnapshot.commanderMessage.trim() &&
      conversationMessages[conversationMessages.length - 1]?.role !== "assistant"
    ) {
      conversationMessages.push({
        role: "assistant",
        content: nextSnapshot.commanderMessage,
      });
    }

    return {
      ...nextSnapshot,
      conversationMessages,
    };
  }
  function setPendingPermissionHandler(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ) {
    if (handler) {
      const queuedDecision = queuedPermissionDecisions.get(requestId) ?? queuedLegacyPermissionDecision;
      if (queuedDecision) {
        queuedPermissionDecisions.delete(requestId);
        queuedLegacyPermissionDecision = undefined;
        void handler(queuedDecision);
        return;
      }
      permissionHandlers.set(requestId, handler);
      return;
    }
    permissionHandlers.delete(requestId);
  }
  const wait = runtimeState.wait;
  const controller = {
    emit,
    getSnapshot: runtimeState.getSnapshot,
    wait,
  };

  return {
    getSnapshot: () => runtimeState.getSnapshot(),
    subscribe(listener) {
      return runtimeState.subscribe(listener);
    },
    start(userGoal, options = {}) {
      runtimeState.clearTimers();
      permissionHandlers.clear();
      queuedPermissionDecisions.clear();
      queuedLegacyPermissionDecision = undefined;
      const startMode = options.mode ?? "auto";
      const taskId = options.taskId ?? `task-${Date.now()}`;
      activeConversation = {
        taskId,
        startedMessages: [
          ...(options.priorMessages ?? []),
          { role: "user", content: userGoal },
        ],
      };
      onTaskStarted?.(taskId);
      if (startMode === "chat") {
        if (chatTool) {
          void runChatTask(taskId, userGoal, chatTool, options.priorMessages ?? []);
          return;
        }
        runClarificationTask(taskId, userGoal);
        return;
      }
      if (startMode === "project") {
        // Only short-circuit for clearly casual inputs (greetings, small talk).
        // Everything else falls through to the auto-routing path below, which
        // already handles URLs, research, project inspection, code review,
        // document scan, and a final chat fallback.
        const isCasual = /^(hi|hello|hey|sup|yo|test|你好|嗨|喂|在吗|测试)$/i.test(
          userGoal.trim(),
        );
        if (isCasual && chatTool) {
          void runChatTask(taskId, userGoal, chatTool, options.priorMessages ?? []);
          return;
        }
        // Fall through to auto routing
      }
      if (webTool && extractUrls(userGoal).length > 0) {
        void runResearchSourceTask({ controller, taskId, userGoal, webTool, commanderTool });
        return;
      }
      const recommendedWorkflowIds = getRecommendedWorkflowIds(userGoal);
      const [recommendedWorkflowId] = recommendedWorkflowIds;
      if (shellTool && projectTool && isReadCurrentProjectGoal(userGoal)) {
        void runReadCurrentProjectWorkflow({
          controller,
          fileTool,
          commanderTool,
          projectTool,
          shellTool,
          codeTool,
          verifierTool,
          taskId,
          userGoal,
        });
        return;
      }
      if (webTool?.searchWeb && isResearchGoal(userGoal)) {
        void runResearchSearchTask({ controller, taskId, userGoal, webTool, commanderTool });
        return;
      }
      if (recommendedWorkflowId && recommendedWorkflowId !== "read-current-project") {
        const executableWorkflowIds = recommendedWorkflowIds.filter(
          (workflowId): workflowId is Exclude<WorkbenchWorkflowId, "read-current-project"> =>
            workflowId !== "read-current-project",
        );
        void runGenericWorkbenchWorkflow({
          controller,
          commanderTool,
          codeTool,
          computerTool,
          schedulerTool,
          webTool,
          verifierTool,
          taskId,
          userGoal,
          workflowId:
            executableWorkflowIds.length === 1 ? executableWorkflowIds[0] : executableWorkflowIds,
        });
        return;
      }
      if (shellTool && projectTool && isProjectInspectionGoal(userGoal)) {
        void runProjectInspectionTask(
          controller,
          taskId,
          userGoal,
          shellTool,
          projectTool,
          commanderTool,
        );
        return;
      }
      if (codeTool && shellTool && isCodeReviewGoal(userGoal)) {
        void runCodeReviewTask({
          controller,
          taskId,
          userGoal,
          codeTool,
          shellTool,
          commanderTool,
          setPendingPermissionHandler,
        });
        return;
      }
      if (fileTool.planPdfOrganization && isPdfOrganizationGoal(userGoal)) {
        void runPdfOrganizationPreviewTask({
          controller,
          fileTool,
          taskId,
          userGoal,
          commanderTool,
          setPendingPermissionHandler,
        });
        return;
      }
      if (isDocumentScanGoal(userGoal)) {
        void runFileScanTask(
          controller,
          fileTool,
          taskId,
          userGoal,
          commanderTool,
        );
        return;
      }

      if (chatTool) {
        void runChatTask(taskId, userGoal, chatTool, options.priorMessages ?? []);
        return;
      }

      runClarificationTask(taskId, userGoal);
    },
    resolvePermission(decision, requestId) {
      if (requestId) {
        const handler = permissionHandlers.get(requestId);
        permissionHandlers.delete(requestId);
        if (handler) {
          void handler(decision);
        } else {
          queuedPermissionDecisions.set(requestId, decision);
        }
        return;
      }
      if (permissionHandlers.size < 1) {
        queuedLegacyPermissionDecision = decision;
        return;
      }
      const [onlyRequestId, handler] = [...permissionHandlers.entries()][
        permissionHandlers.size - 1
      ];
      permissionHandlers.delete(onlyRequestId);
      void handler(decision);
    },
    dispose() {
      eventBusUnsubscribe?.();
      runtimeState.dispose();
    },
  };

  async function runChatTask(
    taskId: ID,
    userGoal: string,
    activeChatTool: ChatTool,
    priorMessages: ChatMessage[] = [],
  ) {
    const isChinese = /[\u3400-\u9fff]/u.test(userGoal);
    const startedMessages: ChatMessage[] = [
      ...priorMessages,
      { role: "user", content: userGoal },
    ];
    emit({
      id: taskId,
      title: isChinese ? "\u6b63\u5728\u56de\u7b54" : "Answering",
      userGoal,
      status: "running",
      updatedAt: new Date().toISOString(),
      commanderMessage: isChinese
        ? "\u6211\u6b63\u5728\u4f5c\u4e3a\u666e\u901a\u52a9\u624b\u56de\u7b54\uff0c\u6ca1\u6709\u542f\u52a8\u5de5\u4f5c\u6d41\u6216\u672c\u5730\u5de5\u5177\u3002"
        : "I'm answering as a general assistant without starting a workflow or local tool.",
      plan: [],
      agents: demoAgents.map((agent) => ({
        id: agent.id,
        name: agent.displayName,
        role: agent.description,
        status: agent.kind === "commander" ? "running" : "completed",
        task:
          agent.kind === "commander"
            ? isChinese
              ? "\u666e\u901a\u5bf9\u8bdd\u56de\u7b54"
              : "General chat response"
            : isChinese
              ? "\u672a\u5206\u914d\u5de5\u4f5c\u4efb\u52a1"
              : "No workflow task assigned",
      })),
      tokenUsage: createEmptyTokenUsageSummary(),
      conversationMessages: startedMessages,
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "User input did not match a work intent; routing to general chat.",
        },
      ],
    });

    try {
      const result = await completeGeneralChat(
        taskId,
        createGeneralChatPrompt(userGoal, isChinese, priorMessages),
        activeChatTool,
        {
          maxTokens: 1200,
          temperature: 0.7,
          locale: isChinese ? "zh-CN" : "en",
        },
      );
      const usage = result.tokenUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      const currentSnapshot = runtimeState.getSnapshot();

      emit({
        ...currentSnapshot,
        title: isChinese ? "\u5df2\u56de\u7b54" : "Answered",
        status: "completed",
        updatedAt: new Date().toISOString(),
        commanderMessage: result.text,
        conversationMessages: [
          ...startedMessages,
          { role: "assistant", content: result.text },
        ],
        agents: demoAgents.map((agent) => ({
          id: agent.id,
          name: agent.displayName,
          role: agent.description,
          status: "completed",
          task:
            agent.kind === "commander"
              ? isChinese
                ? "\u666e\u901a\u5bf9\u8bdd\u5df2\u56de\u7b54"
                : "General chat answered"
              : isChinese
                ? "\u672a\u5206\u914d\u5de5\u4f5c\u4efb\u52a1"
                : "No workflow task assigned",
        })),
        tokenUsage: addModelUsage(currentSnapshot.tokenUsage, "commander", usage),
        logs: appendLog(currentSnapshot, {
          id: `${taskId}-done`,
          kind: "event",
          title: "task.completed",
          detail: "General chat response completed without local tool calls.",
        }),
      });
    } catch (error) {
      runModelFailureTask(taskId, userGoal, error);
    }
  }

  async function completeGeneralChat(
    taskId: ID,
    prompt: string,
    activeChatTool: ChatTool,
    options: {
      maxTokens?: number;
      temperature?: number;
      locale?: string;
    },
  ): Promise<{ text: string; tokenUsage?: ModelUsage }> {
    if (!activeChatTool.stream || !eventBus) {
      return activeChatTool.complete(prompt, options);
    }

    let text = "";
    let tokenUsage: ModelUsage | undefined;
    eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "commander" });
    try {
      for await (const chunk of activeChatTool.stream(prompt, {
        ...options,
        onUsage: (usage) => {
          tokenUsage = usage;
        },
      })) {
        text += chunk.text;
        eventBus.emit({
          kind: "agent.chunk",
          taskId,
          agentKind: "commander",
          text: chunk.text,
        });
      }
      eventBus.emit({
        kind: "agent.chunk_end",
        taskId,
        agentKind: "commander",
        fullText: text,
      });
      return { text, tokenUsage };
    } catch {
      eventBus.emit({
        kind: "agent.chunk_end",
        taskId,
        agentKind: "commander",
        fullText: "",
        error: "stream failed",
      });
      return activeChatTool.complete(prompt, options);
    }
  }

  function createGeneralChatPrompt(
    userGoal: string,
    isChinese: boolean,
    priorMessages: ChatMessage[] = [],
  ): string {
    const transcript = priorMessages.map((message) => {
      const speaker = message.role === "user" ? (isChinese ? "用户" : "User") : "Javis";
      return `${speaker}: ${message.content}`;
    });
    return [
      isChinese
        ? "\u4f60\u662f Javis\uff0c\u4e00\u4e2a\u53ef\u4ee5\u666e\u901a\u804a\u5929\u3001\u4e5f\u53ef\u4ee5\u5728\u7528\u6237\u660e\u786e\u8981\u6c42\u65f6\u6267\u884c\u5de5\u4f5c\u6d41\u7684\u684c\u9762\u52a9\u624b\u3002"
        : "You are Javis, a desktop assistant that can chat normally and can run workflows when the user clearly asks for work.",
      isChinese
        ? "\u8fd9\u4e00\u8f6e\u6ca1\u6709\u5339\u914d\u5230\u5de5\u4f5c\u6d41\u3002\u8bf7\u76f4\u63a5\u56de\u7b54\u7528\u6237\uff0c\u4fdd\u6301\u81ea\u7136\u3001\u7b80\u6d01\uff0c\u4e0d\u8981\u58f0\u79f0\u5df2\u7ecf\u6267\u884c\u672c\u5730\u5de5\u5177\u3002"
        : "This turn did not match a workflow. Answer the user directly, naturally, and concisely. Do not claim that you ran local tools.",
      transcript.length > 0
        ? isChinese ? "\u5bf9\u8bdd\u5386\u53f2\uff1a" : "Conversation history:"
        : "",
      ...transcript,
      `User: ${userGoal}`,
    ].filter(Boolean).join("\n");
  }

  function runClarificationTask(taskId: ID, userGoal: string, error?: unknown) {
    const isChinese = /[㐀-鿿]/u.test(userGoal);
    emit({
      id: taskId,
      title: isChinese ? "需要更多信息" : "Need more details",
      userGoal,
      status: "completed",
      commanderMessage: isChinese
        ? "我还不太确定你想让我执行什么任务。你可以让我检查项目、审查代码、整理文件、搜索文档，或者进行普通问答。"
        : "I'm not sure what task you want me to run. You can ask me to inspect the project, review code, organize files, search for documents, or have a general chat.",
      plan: [],
      agents: demoAgents.map((agent) => ({
        id: agent.id,
        name: agent.displayName,
        role: agent.description,
        status: "completed",
        task: isChinese ? "无任务分配" : "No task assigned",
      })),
      tokenUsage: createEmptyTokenUsageSummary(),
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: error
            ? `General chat fallback failed: ${error instanceof Error ? error.message : String(error)}`
            : "User input did not match any known task intent.",
        },
      ],
    });
  }

  function runModelFailureTask(taskId: ID, userGoal: string, error: unknown) {
    const isChinese = /[㐀-鿿]/u.test(userGoal);
    const detail = error instanceof Error ? error.message : String(error);
    emit({
      id: taskId,
      title: isChinese ? "模型调用失败" : "Model call failed",
      userGoal,
      status: "failed",
      commanderMessage: isChinese
        ? "我尝试调用已配置的模型，但模型请求失败，所以没有生成回复。请检查服务商、模型名称、API 密钥和基础 URL；如果你正在 127.0.0.1 网页预览里测试，请改用 Tauri 桌面端运行。"
        : "I tried to call the configured model, but the model request failed. Check the provider, model, API key, and base URL; if you are testing in the 127.0.0.1 web preview, run the Tauri desktop app instead.",
      plan: [],
      agents: demoAgents.map((agent) => ({
        id: agent.id,
        name: agent.displayName,
        role: agent.description,
        status: agent.kind === "commander" ? "failed" : "completed",
        task:
          agent.kind === "commander"
            ? isChinese
              ? "模型请求失败"
              : "Model request failed"
            : isChinese
              ? "未分配工作任务"
              : "No workflow task assigned",
      })),
      tokenUsage: createEmptyTokenUsageSummary(),
      logs: [
        {
          id: `${taskId}-model-failed`,
          kind: "event",
          title: "model.call.failed",
          detail: `General chat model call failed: ${detail}`,
        },
      ],
    });
  }

}
