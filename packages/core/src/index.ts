console.log("[Javis-CORE] module loaded", new Date().toISOString());

import type {
  AskUserQuestionRequest,
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
  BrowserTool,
  VisionTool,
} from "@javis/tools";
import type { AskUserAnswerHandler } from "./ask-user";
import type { PendingPermissionHandler } from "./confirmed-write";
import type { AgentReActDecision } from "./agent-react-loop";
import type { ReActDecisionRequest } from "./agent-react-decider";
import type { CommanderDagPlan } from "./commander-plan-schema";
import {
  demoAgents,
} from "./agents";
import { runCodeReviewTask } from "./code-review-flow";
import { runPdfOrganizationPreviewTask } from "./pdf-organization-flow";
import { isTextWriteGoal, runTextWriteTask } from "./text-write-flow";
import { isVisionGoal, runVisionTask } from "./vision-flow";
import { runProjectInspectionTask } from "./project-inspection-flow";
import { runResearchSearchTask, runResearchSourceTask } from "./research-flow";
import {
  isReadCurrentProjectGoal,
  runGenericWorkbenchWorkflow,
  runReadCurrentProjectWorkflow,
  runCommanderDagTask,
} from "./workflow-executor";
import type { WorkbenchWorkflowId } from "./workflows";
import {
  extractUrls,
  isCodeReviewGoal,
  isPdfOrganizationGoal,
  isProjectInspectionGoal,
  isResearchGoal,
  getRecommendedWorkflowIds,
} from "./routing";
import { createRuntimeState } from "./runtime-state";
import { appendLog } from "./snapshot-utils";
import { addModelUsage, createEmptyTokenUsageSummary } from "./token-usage";
import type { TaskEventBus } from "./task-event-bus";
import {
  createRouteLog,
  routeMessage,
  type RouteDecision,
  type RouteLog,
} from "./local-router";

export {
  createCodeApplyDryRun,
  parsePatchHunks,
  validateCodeApplyResult,
  validateCodeProposal,
} from "./code-proposal-safety";
export { createAskUserRequest } from "./ask-user";
export type { AskUserAnswerHandler } from "./ask-user";
export { createDryRunBindingHash } from "./permission-state";
export {
  DOCUMENTED_TASK_TRANSITIONS,
  TASK_STATUSES,
  TASK_STATUS_PROGRESS,
  getTaskProgress,
  isLegalTaskTransition,
  isTerminalTaskStatus,
  transitionTask,
} from "./state/task-state";
export { demoAgents, getAgentSystemPrompt, createDefaultAgentRegistry, browserSnapshot } from "./agents";
export {
  MAX_STYLE_LENGTH,
  buildAgentSystemPrompt,
  clampCustomStyle,
  defaultAgentStyleFileName,
  normalizePromptLocale,
  wrapCustomStyle,
} from "./agents/prompt";
export type {
  AgentPromptLocale,
  AgentStyleRecord,
  AgentStyleSource,
  BuildAgentSystemPromptOptions,
} from "./agents/prompt";
export type {
  AgentCapabilityTag,
  ModelRequirements,
  AgentRegistration,
  AgentRegistry,
} from "./agent-capability";
export { createAgentRegistry, ALL_CAPABILITY_TAGS, isValidCapabilityTag } from "./agent-capability";
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
  AGENT_RUN_EVENT_KINDS,
  createTaskEventBus,
  isAgentRunEvent,
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
  WorkflowStepFailureReplanAction,
  WorkflowStepExecutionResult,
} from "./workflow-dag-executor";
export { runAgentReActLoop } from "./agent-react-loop";
export type {
  AgentReActDecision,
  AgentReActLoopOptions,
  AgentReActLoopResult,
  AgentReActObservation,
  AgentReActTool,
} from "./agent-react-loop";
export { buildReActDecisionPrompt } from "./agent-react-decider";
export type { ReActDecisionRequest } from "./agent-react-decider";
export { createAgentStateTracker } from "./agent-state-tracker";
export type {
  AgentState,
  AgentStateTracker,
} from "./agent-state-tracker";
export type {
  AgentRunEvent,
  AgentRunEventKind,
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
export { isBrowserGoal, isComputerUseGoal } from "./routing";
export {
  COMPUTER_USE_SYSTEM_PROMPT,
  COMPUTER_USE_OUTPUT_SCHEMA,
  DEFAULT_COMPUTER_USE_CONFIG,
} from "./computer-use-prompt";
export { parseModelAction, parseModelOutput } from "./computer-use-types";
export type {
  ComputerUseLoopConfig,
  ComputerUseStep,
  ComputerUseAction,
  ComputerUseModelOutput,
} from "./computer-use-types";
export {
  COMMANDER_PLAN_SCHEMA_JSON,
  buildCommanderPlanPrompt,
  buildCommanderReplanPrompt,
} from "./commander-plan-schema";
export type {
  CommanderDagStep,
  CommanderDagPlan,
} from "./commander-plan-schema";
export {
  createRouteLog,
  routeMessage,
  scoreComplexity,
} from "./local-router";
export type {
  RouteDecision,
  RouteLevel,
  RouteLog,
  RouteMode,
} from "./local-router";

export type {
  ProviderProtocol,
  ProviderCapabilities,
  AdapterCompletionInput,
  AdapterRequestPayload,
  AdapterCompletionResponse,
  ProviderAdapter,
} from "./provider-adapter";

export {
  getAdapter,
  registerAdapter,
  listAdapters,
} from "./adapters/adapter-registry";
export { OpenAIAdapter } from "./adapters/openai-adapter";
export { OpenAICompatibleAdapter } from "./adapters/openai-compatible-adapter";
export { DeepSeekAdapter } from "./adapters/deepseek-adapter";
export { AnthropicAdapter } from "./adapters/anthropic-adapter";

export {
  PROVIDER_DEFINITIONS,
  PROVIDER_BY_ID,
  PROVIDER_IDS,
} from "./provider-definitions";
export type {
  ProviderDefinition,
  AdapterKind,
} from "./provider-definitions";

export {
  extractImageDataUrls,
  hasImageAttachments,
  stripImageMarkers,
  stripVisionContextMarkers,
  buildVisionBridgePrompt,
  formatVisionContext,
  modelSupportsVision,
} from "./vision-bridge";

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
  | "waiting_info"
  | "waiting_permission"
  | "running"
  | "generating"
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
  | "workspace"
  | "vision";

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
  agentId?: ID;
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
  /** Product-facing text shown in normal mode. Falls back to detail for legacy logs. */
  userMessage?: string;
  /** Technical detail shown only when process details are expanded. */
  devDetail?: string;
  /** Explicit agent owner for right-side Inspector filtering. */
  agentId?: ID;
  /** Explicit workflow step owner for right-side Inspector filtering. */
  stepId?: ID;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Base64 image data URLs attached to this message (user messages only). Stripped before SQLite persistence. */
  attachments?: string[];
}

export type ConversationMessageKind =
  | "user_text"
  | "assistant_text"
  | "ask_user_question"
  | "permission_request";

export interface ConversationMessage extends ChatMessage {
  id?: ID;
  kind?: ConversationMessageKind;
  parentMessageId?: ID;
  createdAt?: ISODateTime;
  askUserQuestion?: AskUserQuestionRequest;
  permissionRequest?: ToolPermissionRequest;
}

export interface TaskSnapshot {
  id: ID;
  title: string;
  userGoal: string;
  status: TaskStatus;
  updatedAt?: ISODateTime;
  originMode?: "chat" | "project";
  workspacePath?: string;
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
  askUserQuestion?: AskUserQuestionRequest;
  project?: ProjectInspection;
  researchReport?: ResearchReport;
  sources?: WebSource[];
  tokenUsage?: TokenUsageSummary;
  verificationSummary?: string;
  conversationMessages?: ConversationMessage[];
  /** Accumulated partial text during streaming. Non-empty + isStreaming -> UI renders StreamingMessage. */
  streamingText?: string;
  /** Agent currently producing streaming output. */
  streamingAgentKind?: AgentKind;
  /** Whether an agent is currently generating streaming output. */
  isStreaming?: boolean;
  /** Structured execution trace 鈥?per-step wall-clock time and token usage. */
  executionTrace?: ExecutionTrace;
  /** User-readable error message set when task fails. Avoids exposing raw stack traces. */
  userFacingError?: string;
}

/** Per-step timing and resource data for performance analysis. */
export interface ExecutionTrace {
  taskId: ID;
  startedAt: ISODateTime;
  completedAt?: ISODateTime;
  totalWallTimeMs: number;
  steps: StepTrace[];
  /** Step IDs on the critical path (longest dependency chain). */
  criticalPath?: ID[];
}

export interface StepTrace {
  stepId: ID;
  agentKind: string;
  toolName?: string;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
  tokenUsage?: { input: number; output: number };
  status: "completed" | "failed" | "skipped";
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
      workspacePath?: string;
      /** User-facing text (without <vision-context>). Defaults to userGoal. */
      displayGoal?: string;
      /** Image data URLs for display in the user's message bubble. */
      displayAttachments?: string[];
    },
  ): void;
  resolvePermission(decision: "approved" | "approved_always" | "denied", requestId?: string): void;
  respondToAskUser(answer: string, requestId?: string): void;
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
  browserTool?: BrowserTool;
  visionTool?: VisionTool;
  workspaceTool?: WorkspaceTool;
  delayMs?: number;
  eventBus?: TaskEventBus;
  onTaskStarted?: (taskId: string) => void;
  /** P0-2: LLM-based ReAct decision maker for step execution loops. */
  reactDecideNext?: (request: ReActDecisionRequest) => Promise<AgentReActDecision>;
  /** P0-3: Commander replan after step failure or P0-4: after askUser clarification. */
  replanDag?: (
    userGoal: string,
    contextSnapshot: Record<string, unknown>,
    failedStepId?: string,
    failureReason?: string,
  ) => Promise<CommanderDagPlan>;
  /**
   * Vision-model-driven action loop for computer-use steps.
   * Injected from desktop layer (where ModelProvider lives).
   */
  computerUseLoopRunner?: (options: {
    userGoal: string;
    computerTool: import("@javis/tools").ComputerTool;
    approveAction: (action: { tool: string; params: Record<string, unknown> }) => Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }>;
    onStep?: (step: unknown) => void;
  }) => Promise<unknown[]>;
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
      streamMode?: "default" | "l1";
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

function routeLogToTaskLog(routeLog: RouteLog): TaskLogEntry {
  return {
    id: `${routeLog.runId}-route`,
    kind: "event",
    title: "route_decided",
    detail: JSON.stringify(routeLog),
    userMessage: `Route ${routeLog.routeLevel}: ${routeLog.mode}`,
    devDetail: [
      `score=${routeLog.complexityScore}`,
      `reasons=${routeLog.reasons.join(",") || "none"}`,
      `escalated=${routeLog.escalated}`,
      `downgraded=${routeLog.downgraded}`,
    ].join("; "),
  };
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
  browserTool,
  visionTool,
  workspaceTool,
  delayMs = 250,
  eventBus,
  onTaskStarted,
  reactDecideNext,
  replanDag,
  computerUseLoopRunner,
}: FileScanRuntimeOptions): TaskRuntime {
  const runtimeState = createRuntimeState(createInitialTaskSnapshot(), delayMs);
  const eventBusUnsubscribe = eventBus
    ? eventBus.on((e) => {
        runtimeState.emitDelta(e);
      })
    : undefined;
  const permissionHandlers = new Map<string, PendingPermissionHandler>();
  const queuedPermissionDecisions = new Map<string, "approved" | "approved_always" | "denied">();
  const askUserHandlers = new Map<string, AskUserAnswerHandler>();
  const queuedAskUserAnswers = new Map<string, string>();
  let queuedLegacyPermissionDecision: "approved" | "approved_always" | "denied" | undefined;
  let activeConversation:
    | { taskId: ID; startedMessages: ChatMessage[] }
    | undefined;
  let activeTaskMetadata:
    | { taskId: ID; originMode?: "chat" | "project"; workspacePath?: string }
    | undefined;
  let activeRouteLog: { taskId: ID; log: TaskLogEntry } | undefined;
  function emit(nextSnapshot: TaskSnapshot) {
    runtimeState.emit(attachConversationMessages(attachRouteLog(attachTaskMetadata(nextSnapshot))));
  }
  function attachTaskMetadata(nextSnapshot: TaskSnapshot): TaskSnapshot {
    if (!activeTaskMetadata || activeTaskMetadata.taskId !== nextSnapshot.id) {
      return nextSnapshot;
    }

    return {
      ...nextSnapshot,
      originMode: nextSnapshot.originMode ?? activeTaskMetadata.originMode,
      workspacePath: nextSnapshot.workspacePath ?? activeTaskMetadata.workspacePath,
    };
  }
  function attachRouteLog(nextSnapshot: TaskSnapshot): TaskSnapshot {
    const routeLog = activeRouteLog;
    if (!routeLog || routeLog.taskId !== nextSnapshot.id) {
      return nextSnapshot;
    }
    if (nextSnapshot.logs.some((log) => log.id === routeLog.log.id)) {
      return nextSnapshot;
    }
    return {
      ...nextSnapshot,
      logs: [routeLog.log, ...nextSnapshot.logs],
    };
  }
  function attachConversationMessages(nextSnapshot: TaskSnapshot): TaskSnapshot {
    if (!activeConversation || activeConversation.taskId !== nextSnapshot.id) {
      return nextSnapshot;
    }
    const conversationMessages = nextSnapshot.conversationMessages?.length
      ? nextSnapshot.conversationMessages.map(normalizeConversationMessage)
      : activeConversation.startedMessages.map(normalizeConversationMessage);
    if (
      nextSnapshot.askUserQuestion &&
      !conversationMessages.some((message) => message.kind === "ask_user_question" && message.id === nextSnapshot.askUserQuestion?.id)
    ) {
      conversationMessages.push({
        id: nextSnapshot.askUserQuestion.id,
        kind: "ask_user_question",
        role: "assistant",
        content: nextSnapshot.askUserQuestion.question,
        createdAt: new Date().toISOString(),
        askUserQuestion: nextSnapshot.askUserQuestion,
      });
    }
    if (
      nextSnapshot.permissionRequest &&
      !conversationMessages.some((message) => message.kind === "permission_request" && message.id === nextSnapshot.permissionRequest?.id)
    ) {
      conversationMessages.push({
        id: nextSnapshot.permissionRequest.id,
        kind: "permission_request",
        role: "assistant",
        content: nextSnapshot.permissionRequest.reason,
        createdAt: new Date().toISOString(),
        permissionRequest: nextSnapshot.permissionRequest,
      });
    }
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
  function setPendingAskUserHandler(
    requestId: string,
    handler: AskUserAnswerHandler | undefined,
  ) {
    if (handler) {
      const wrappedHandler: AskUserAnswerHandler = async (answer) => {
        await handler(answer);
        if (eventBus) {
          const snapshot = runtimeState.getSnapshot();
          eventBus.emit({
            kind: "ask_user.responded",
            taskId: snapshot.id,
            requestId,
            answer,
          });
        }
      };
      const queuedAnswer = queuedAskUserAnswers.get(requestId);
      if (queuedAnswer !== undefined) {
        queuedAskUserAnswers.delete(requestId);
        void wrappedHandler(queuedAnswer);
        return;
      }
      askUserHandlers.set(requestId, wrappedHandler);
      return;
    }
    askUserHandlers.delete(requestId);
  }
  const wait = runtimeState.wait;
  const controller = {
    emit,
    getSnapshot: runtimeState.getSnapshot,
    wait,
    setPendingAskUserHandler,
  };
  function emitImmediateFeedback(taskId: ID, userGoal: string) {
    const isChinese = /[\u3400-\u9fff]/u.test(userGoal);
    emit({
      id: taskId,
      title: isChinese ? "姝ｅ湪鐞嗚В" : "Understanding",
      userGoal,
      status: "generating",
      updatedAt: new Date().toISOString(),
      commanderMessage: isChinese
        ? "姝ｅ湪鐞嗚В浣犵殑闂..."
        : "Understanding your request...",
      plan: [],
      agents: demoAgents.map((agent) => ({
        id: agent.id,
        name: agent.displayName,
        role: agent.description,
        status: agent.kind === "commander" ? "running" : "queued",
        task: agent.kind === "commander"
          ? isChinese ? "\u6b63\u5728\u8def\u7531\u5e76\u51c6\u5907\u56de\u590d" : "Routing and preparing a response"
          : isChinese ? "\u7b49\u5f85\u5206\u914d" : "Waiting",
      })),
      logs: [
        {
          id: `${taskId}-feedback`,
          kind: "event",
          title: "run_started",
          detail: "Immediate UI feedback was emitted before route execution.",
          userMessage: isChinese ? "姝ｅ湪鐞嗚В浣犵殑闂..." : "Understanding your request...",
        },
      ],
      tokenUsage: createEmptyTokenUsageSummary(),
      streamingText: "",
      streamingAgentKind: "commander",
      isStreaming: true,
    });
  }

  function normalizeConversationMessage(message: ConversationMessage): ConversationMessage {
    if (!message.attachments?.length) {
      return message;
    }
    const safeAttachments = message.attachments.filter(isSafeConversationAttachmentUrl);
    const next: ConversationMessage = { ...message };
    if (safeAttachments.length > 0) {
      next.attachments = safeAttachments;
    } else {
      delete next.attachments;
    }
    return next;
  }

  function isSafeConversationAttachmentUrl(value: string): boolean {
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
      askUserHandlers.clear();
      queuedAskUserAnswers.clear();
      const startMode = options.mode ?? "auto";
      const taskId = options.taskId ?? `task-${Date.now()}`;
      activeTaskMetadata = {
        taskId,
        originMode: startMode === "chat" || startMode === "project" ? startMode : undefined,
        workspacePath: options.workspacePath?.trim() || undefined,
      };
      activeConversation = {
        taskId,
        startedMessages: [
          ...(options.priorMessages ?? []),
          {
            role: "user",
            content: options.displayGoal ?? userGoal,
            ...(options.displayAttachments ? { attachments: options.displayAttachments } : {}),
          },
        ],
      };
      onTaskStarted?.(taskId);
      emitImmediateFeedback(taskId, userGoal);
      const routeDecision = routeMessage(userGoal);
      const routeLog = createRouteLog(taskId, userGoal, routeDecision);
      activeRouteLog = { taskId, log: routeLogToTaskLog(routeLog) };
      const recommendedWorkflowIds = getRecommendedWorkflowIds(userGoal);
      const hasKnownRouteIntent = Boolean(
        extractUrls(userGoal).length > 0 ||
        recommendedWorkflowIds.length > 0 ||
        isReadCurrentProjectGoal(userGoal) ||
        isTextWriteGoal(userGoal) ||
        isVisionGoal(userGoal) ||
        isResearchGoal(userGoal) ||
        isProjectInspectionGoal(userGoal) ||
        isCodeReviewGoal(userGoal) ||
        isPdfOrganizationGoal(userGoal)
      );
      if (startMode === "chat") {
        if (chatTool) {
          void runDirectChatTask(
            taskId,
            userGoal,
            chatTool,
            options.priorMessages ?? [],
            options.displayGoal,
            options.displayAttachments,
            routeDecision,
            routeLog,
          );
          return;
        }
        runClarificationTask(taskId, userGoal);
        return;
      }
      if (
        startMode !== "project" &&
        routeDecision.level === "L1" &&
        chatTool &&
        !hasKnownRouteIntent
      ) {
        void runDirectChatTask(
          taskId,
          userGoal,
          chatTool,
          options.priorMessages ?? [],
          options.displayGoal,
          options.displayAttachments,
          routeDecision,
          routeLog,
        );
        return;
      }
      // Project/Agent mode: ALL inputs go to Commander DAG.
      // No weak-rule pre-filtering 鈥?Commander (LLM) decides the routing.
      // Casual greetings in Agent mode still produce a valid (1-step) DAG.

      // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
      // Vision 鈥?check BEFORE Commander DAG so multimodal model is used.
      // Commander uses the primary (non-vision) model and cannot handle
      // image analysis; the vision flow uses the multimodal slot.
      // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
      if (visionTool && isVisionGoal(userGoal) && !userGoal.includes("<vision-context>")) {
        void runVisionTask({
          controller,
          visionTool,
          commanderTool,
          verifierTool,
          taskId,
          userGoal,
        });
        return;
      }

      // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
      // P0-1: Commander Dynamic DAG 鈥?PRIMARY path for all goals.
      // The Commander generates a structured DAG plan via LLM, which is
      // executed by the generic capability-based DAG executor.
      // Legacy branches below are fallbacks for when Commander is unavailable.
      // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
      if (startMode !== "project" && routeDecision.level === "L2") {
        if (webTool && extractUrls(userGoal).length > 0) {
          void runResearchSourceTask({ controller, taskId, userGoal, webTool, commanderTool });
          return;
        }
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
        if (fileTool.planWriteText && isTextWriteGoal(userGoal)) {
          void runTextWriteTask({
            controller,
            fileTool,
            webTool,
            taskId,
            userGoal,
            commanderTool,
            setPendingPermissionHandler,
          });
          return;
        }
        if (webTool?.searchWeb && isResearchGoal(userGoal)) {
          void runResearchSearchTask({ controller, taskId, userGoal, webTool, commanderTool });
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
        if (chatTool) {
          void runChatTask(
            taskId,
            userGoal,
            chatTool,
            options.priorMessages ?? [],
            options.displayGoal,
            options.displayAttachments,
            routeDecision,
            routeLog,
          );
          return;
        }
      }

      if (commanderTool) {
        void runCommanderDagTask({
          controller: {
            emit,
            getSnapshot: runtimeState.getSnapshot,
            wait,
            setPendingAskUserHandler,
            setPendingPermissionHandler,
          },
          commanderTool,
          codeTool,
          computerTool,
          fileTool,
          shellTool,
          schedulerTool,
          workspaceTool,
          webTool,
          browserTool,
          verifierTool,
          visionTool,
          taskId,
          userGoal,
          initialLogs: [routeLogToTaskLog(routeLog)],
          reactDecideNext,
          replanDag,
          computerUseLoopRunner,
        });
        return;
      }

      // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
      // LEGACY FALLBACKS 鈥?only reached when commanderTool is not provided.
      // These use regex-based goal detection (routing.ts) instead of LLM.
      // Purpose:
      //   1. Offline/degraded mode (no API key configured)
      //   2. Unit testing without LLM mocks
      //   3. Backward compatibility with workspace definitions lacking commander
      // Do NOT add new features here. New goal types -> Commander DAG path above.
      // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?

      if (webTool && extractUrls(userGoal).length > 0) {
        void runResearchSourceTask({ controller, taskId, userGoal, webTool, commanderTool });
        return;
      }
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
      if (fileTool.planWriteText && isTextWriteGoal(userGoal)) {
        void runTextWriteTask({
          controller,
          fileTool,
          webTool,
          taskId,
          userGoal,
          commanderTool,
          setPendingPermissionHandler,
        });
        return;
      }
      if (visionTool && isVisionGoal(userGoal) && !userGoal.includes("<vision-context>")) {
        void runVisionTask({
          controller,
          visionTool,
          commanderTool,
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
        const dedicatedWorkflowIds = new Set([
          "pdf-organization",
          "code-review",
        ]);
        const executableWorkflowIds = recommendedWorkflowIds.filter(
          (workflowId): workflowId is Exclude<WorkbenchWorkflowId, "read-current-project"> =>
            workflowId !== "read-current-project" && !dedicatedWorkflowIds.has(workflowId),
        );
        if (executableWorkflowIds.length === 0) {
          // fall through
        } else {
          void runGenericWorkbenchWorkflow({
            controller,
            commanderTool,
            codeTool,
            computerTool,
            fileTool,
            schedulerTool,
            webTool,
            browserTool,
            verifierTool,
            taskId,
            userGoal,
            workflowId:
              executableWorkflowIds.length === 1 ? executableWorkflowIds[0] : executableWorkflowIds,
          });
          return;
        }
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
      if (chatTool) {
        void runChatTask(
          taskId,
          userGoal,
          chatTool,
          options.priorMessages ?? [],
          options.displayGoal,
          options.displayAttachments,
          routeDecision,
          routeLog,
        );
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
    respondToAskUser(answer, requestId) {
      const resolvedId = requestId ?? (askUserHandlers.size > 0
        ? [...askUserHandlers.entries()][askUserHandlers.size - 1][0]
        : undefined);

      if (requestId) {
        const handler = askUserHandlers.get(requestId);
        askUserHandlers.delete(requestId);
        if (handler) {
          void handler(answer);
        } else {
          queuedAskUserAnswers.set(requestId, answer);
        }
      } else if (resolvedId) {
        const handler = askUserHandlers.get(resolvedId);
        askUserHandlers.delete(resolvedId);
        void handler?.(answer);
      } else {
        return;
      }

      // Preserve the user's answer in the conversation timeline so it
      // remains visible and scrollable after submission (P0-#3 fix).
      const current = runtimeState.getSnapshot();
      if (current.askUserQuestion && (!resolvedId || current.askUserQuestion.id === resolvedId)) {
        const currentMessages = current.conversationMessages ?? [];
        runtimeState.emit({
          ...current,
          askUserQuestion: {
            ...current.askUserQuestion,
            status: "answered",
            answer,
          } as typeof current.askUserQuestion,
          conversationMessages: [
            ...currentMessages,
            { role: "user", content: answer },
          ],
        });
      }
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
    displayGoal?: string,
    displayAttachments?: string[],
    routeDecision: RouteDecision = routeMessage(userGoal),
    routeLog: RouteLog = createRouteLog(taskId, userGoal, routeDecision),
  ) {
    const isChinese = /[\u3400-\u9fff]/u.test(userGoal);
    const displayContent = displayGoal ?? userGoal;
    const startedMessages: ChatMessage[] = [
      ...priorMessages,
      {
        role: "user",
        content: displayContent,
        ...(displayAttachments ? { attachments: displayAttachments } : {}),
      },
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
        routeLogToTaskLog(routeLog),
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: routeDecision.level === "L1"
            ? "Local router selected direct chat."
            : "Local router selected a single-agent task; using direct model response fallback.",
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

  async function runDirectChatTask(
    taskId: ID,
    userGoal: string,
    activeChatTool: ChatTool,
    priorMessages: ChatMessage[] = [],
    displayGoal?: string,
    displayAttachments?: string[],
    routeDecision: RouteDecision = routeMessage(userGoal),
    routeLog: RouteLog = createRouteLog(taskId, userGoal, routeDecision),
  ) {
    return runChatTask(
      taskId,
      userGoal,
      activeChatTool,
      priorMessages,
      displayGoal,
      displayAttachments,
      routeDecision,
      routeLog,
    );
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
    if (!activeChatTool.stream) {
      return activeChatTool.complete(prompt, options);
    }
    if (!eventBus) {
      return activeChatTool.complete(prompt, options);
    }

    let text = "";
    let tokenUsage: ModelUsage | undefined;
    eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "commander" });
    try {
      for await (const chunk of activeChatTool.stream(prompt, {
        ...options,
        streamMode: "l1",
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
        // Yield to the event loop so React can render between chunks
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      eventBus.emit({
        kind: "agent.chunk_end",
        taskId,
        agentKind: "commander",
        fullText: text,
      });
      return { text, tokenUsage };
    } catch (streamError) {
      console.log("[Javis] stream() threw, falling back to complete():", streamError);
      eventBus.emit({
        kind: "agent.chunk_end",
        taskId,
        agentKind: "commander",
        fullText: text,
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
        ? "\u8eab\u4efd\u89c4\u5219\uff1a\u4f60\u53ea\u80fd\u4ee5 Javis \u6216 Javis \u6307\u6325\u5b98\u7684\u8eab\u4efd\u56de\u7b54\u3002\u4e0d\u8981\u81ea\u79f0\u4e3a\u5e95\u5c42\u6a21\u578b\u3001\u4f9b\u5e94\u5546\u3001\u7814\u53d1\u56e2\u961f\u6216\u4efb\u4f55\u975e Javis \u8eab\u4efd\u3002"
        : "Identity rule: answer only as Javis or Javis Commander. Do not identify yourself as the underlying model, provider, vendor, lab, or any non-Javis identity.",
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
    const isChinese = /[\u3400-\u9fff]/u.test(userGoal);
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
    const isChinese = /[\u3400-\u9fff]/u.test(userGoal);
    const detail = error instanceof Error ? error.message : String(error);
    const currentSnapshot = runtimeState.getSnapshot();
    const partialText = currentSnapshot.id === taskId
      ? (currentSnapshot.streamingText || currentSnapshot.commanderMessage || "").trim()
      : "";
    const userFacingError = isChinese
      ? "模型请求失败。已保留当前已生成的内容，请检查服务商、模型、API 密钥和基础 URL 后重试。"
      : "The model request failed. Any generated content was kept; check the provider, model, API key, and base URL before retrying.";
    emit({
      ...(currentSnapshot.id === taskId ? currentSnapshot : {}),
      id: taskId,
      title: isChinese ? "模型调用失败" : "Model call failed",
      userGoal,
      status: "failed",
      commanderMessage: partialText || (currentSnapshot.id === taskId
        ? currentSnapshot.commanderMessage
        : isChinese
          ? "模型请求失败，请检查服务商、模型、API 密钥和基础 URL 后重试。"
          : "The model request failed. Check the provider, model, API key, and base URL before retrying."),
      plan: [],
      agents: demoAgents.map((agent) => ({
        id: agent.id,
        name: agent.displayName,
        role: agent.description,
        status: agent.kind === "commander" ? "failed" : "completed",
        task: agent.kind === "commander"
          ? isChinese ? "模型请求失败" : "Model request failed"
          : isChinese ? "未分配工作任务" : "No workflow task assigned",
      })),
      tokenUsage: currentSnapshot.id === taskId
        ? currentSnapshot.tokenUsage ?? createEmptyTokenUsageSummary()
        : createEmptyTokenUsageSummary(),
      streamingText: "",
      isStreaming: false,
      userFacingError,
      logs: [
        ...(currentSnapshot.id === taskId ? currentSnapshot.logs : []),
        {
          id: `${taskId}-model-failed`,
          kind: "event",
          title: "model.call.failed",
          detail: `General chat model call failed: ${detail}`,
          userMessage: userFacingError,
          devDetail: `General chat model call failed: ${detail}`,
        },
      ],
    });
  }

}
