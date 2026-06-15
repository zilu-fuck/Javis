console.log("[Javis-CORE] module loaded", new Date().toISOString());

import type {
  AskUserQuestionRequest,
  CodeReviewPreview,
  CodeProposedEdit,
  CodeApplyResult,
  CodeRepositorySearchResult,
  CodeRepositoryTraceResult,
  CodeTool,
  ComputerTool,
  CommanderTool,
  FileOrganizationExecution,
  FileOrganizationPlan,
  FileTool,
  GitTool,
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
  TrendTool,
  MemoryTool,
  McpTool,
  WorkspaceTool,
  TokenUsageSummary,
  BrowserTool,
  ToolDescriptor,
  VisionTool,
} from "@javis/tools";
import { initialToolDescriptors, isDisabledBrowserWriteToolName } from "@javis/tools";
import type { AskUserAnswerHandler } from "./ask-user";
import type { PendingPermissionHandler } from "./confirmed-write";
import type { AgentReActDecision } from "./agent-react-loop";
import type { ReActDecisionRequest } from "./agent-react-decider";
import type { CommanderDagPlan } from "./commander-plan-schema";
import type { ComputerUseStepTrace } from "./computer-use-types";
import type { HandoffReport } from "./shared-context";
import type { RecoveryReport } from "./recovery-report";
import type { PlanGenerationTrace } from "./planning/plan-generation-trace";
import {
  createDefaultAgentRegistry,
  demoAgents,
} from "./agents";
import { scoreAgentCapability } from "./agent-capability";
import type { AgentCapabilityScore, AgentCapabilityVerificationInput } from "./agent-capability";
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
import {
  createRecoveredContextMessages,
  isContextOverflowError,
} from "./context-recovery";
import type { TaskEventBus } from "./task-event-bus";
import type { RuntimeEventEnvelope } from "./runtime-event-envelope";
import type { WorkflowCheckpoint } from "./workflow-checkpoint";
import {
  createRouteLog,
  routeMessage,
  type RouteDecision,
  type RouteLog,
} from "./local-router";
import { isTaskCancelledError, throwIfTaskAborted, withTaskTimeout } from "./task-wait";
import { isTerminalTaskStatus } from "./state/task-state";
import { inferVisionMode } from "./vision-utils";

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
  getUiGenerationDesignRules,
  normalizePromptLocale,
  wrapCustomStyle,
} from "./agents/prompt";
export type {
  AgentPromptLocale,
  AgentStyleRecord,
  AgentStyleSource,
  BuildAgentSystemPromptOptions,
  WorkspacePromptProfile,
} from "./agents/prompt";
export type {
  AgentCapabilityTag,
  AgentCapabilityEvidenceRecord,
  AgentRepairPriority,
  AgentCapabilityScore,
  AgentCapabilityToolSignal,
  AgentCapabilityVerificationInput,
  ModelRequirements,
  AgentRegistration,
  AgentRegistry,
} from "./agent-capability";
export {
  createAgentRegistry,
  deriveAgentCapabilityVerificationInput,
  rankAgentRepairPriorities,
  scoreAgentCapability,
  scoreAgentCapabilities,
  ALL_CAPABILITY_TAGS,
  isValidCapabilityTag,
} from "./agent-capability";
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
  buildRepositoryTraceEvidenceReport,
  buildRepositorySearchEvidenceReport,
  clusterRepositorySearchResults,
  createRepositorySearchPlan,
} from "./repo-intelligence";
export type {
  RepositoryTraceDirection,
  RepositoryTraceEdge,
  RepositoryTraceEvidence,
  RepositoryTraceEvidenceReport,
  RepositoryTraceModuleKind,
  RepositoryTraceNode,
  RepositoryTraceRelation,
  RepositoryTraceRequest,
  RepositorySearchAttempt,
  RepositorySearchAttemptErrorKind,
  RepositorySearchCluster,
  RepositorySearchEvidenceReport,
  RepositorySearchPlan,
  RepositorySearchPlanRequest,
  RepositorySearchResult,
  RepositorySearchSemanticDiagnostic,
} from "./repo-intelligence";
export {
  DEFAULT_GOAL_MAX_RUN_COUNT,
  GOAL_BLOCKED_STREAK_THRESHOLD,
  applyGoalDecision,
  bindGoalTask,
  clearGoal,
  completeGoal,
  createGoalState,
  createGoalEvent,
  createGoalEvaluationFromDecision,
  isGoalTerminal,
  parseGoalAcceptanceCriteria,
  pauseGoal,
  resumeGoal,
  sanitizeGoalState,
} from "./goal-state";
export type {
  CreateGoalStateInput,
  GoalDecision,
  GoalDecisionStatus,
  GoalEvaluation,
  GoalEvent,
  GoalEventType,
  GoalRun,
  GoalRunStatus,
  GoalState,
  GoalStrategy,
  GoalStrategyContext,
  GoalStrategyPatch,
  GoalStatus,
} from "./goal-state";
export {
  AGENT_RUN_EVENT_KINDS,
  createTaskEventBus,
  isAgentRunEvent,
  taskEventToLogEntry,
} from "./task-event-bus";
export { createDeltaReducer } from "./delta-reducer";
export type { DeltaReducer } from "./delta-reducer";
export {
  buildHandoffReport,
  DEFAULT_CONTEXT_KEY_SCHEMAS,
  createHandoffReportArtifacts,
  createSharedTaskContext,
  CONTEXT_KEYS,
  formatStepInputValidationError,
  formatHandoffReportMarkdown,
  contextKeyForLocale,
  validateContextValue,
  validateStepInputContext,
} from "./shared-context";
export type {
  ContextKey,
  ContextKeySchema,
  ContextValueValidation,
  HandoffReport,
  HandoffReportArtifact,
  HandoffReportRecord,
  HandoffReportStep,
  HandoffReportStepRecord,
  HandoffReportValueSummary,
  SharedTaskContext,
  StepInputValidationResult,
} from "./shared-context";
export {
  buildRecoveryReport,
  classifyRecoveryFailure,
  createRecoveryAttempt,
} from "./recovery-report";
export type {
  RecoveryAttemptRecord,
  RecoveryFailureKind,
  RecoveryReplanStatus,
  RecoveryReport,
} from "./recovery-report";
export {
  buildPlanGenerationTrace,
  classifyCompileStatus,
} from "./planning/plan-generation-trace";
export type {
  PlanGenerationTrace,
  PlanGenerationStage,
  PlanGenerationStageStatus,
  PlanGenerationStageRecord,
  PlanRepairAttemptRecord,
  PlanRecoveryCompileRecord,
} from "./planning/plan-generation-trace";
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
export {
  compileCommanderPlan,
  formatDiagnosticSummary,
  isCompiledPlan,
  isRepairable,
  validateCommanderPlan,
  attemptPlanRepair,
} from "./planning";
export type {
  AttemptPlanRepairInput,
  AttemptPlanRepairResult,
  CompileCommanderPlanInput,
  CompileCommanderPlanResult,
  CompiledCommanderPlan,
  PlanDiagnostic,
  PlanDiagnosticCode,
  PlanValidationInput,
  RepairAttemptRecord,
} from "./planning";
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
export {
  createRuntimeEventEnvelope,
  currentEnvelopeSequence,
  extractEventKind,
  extractStepId,
  extractAgentKind,
  isStructuralEvent,
  isStreamingEvent,
  nextEnvelopeSequence,
  resetEnvelopeSequence,
  STRUCTURAL_EVENT_KINDS,
  STREAMING_EVENT_KINDS,
} from "./runtime-event-envelope";
export type {
  RuntimeEventEnvelope,
  RuntimeEventKind,
} from "./runtime-event-envelope";
export {
  createArtifactEnvelope,
  computeContentHash,
  isArtifactEnvelope,
  sanitizeArtifactForPersistence,
  summarizeArtifactForHandoff,
  resetArtifactIdCounter,
} from "./artifact-envelope";
export type {
  ArtifactEnvelope,
  ArtifactProducerRef,
  ArtifactSensitivity,
  ArtifactHashAlgorithm,
  EvidenceReference,
} from "./artifact-envelope";
export {
  buildCheckpointFromDagState,
  computePlanHash,
  getResumableStepIds,
  isCheckpointResumeCompatible,
  isCheckpointTrigger,
} from "./workflow-checkpoint";
export type {
  WorkflowCheckpoint,
  CheckpointTrigger,
} from "./workflow-checkpoint";
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
export {
  COMPUTER_USE_ACTION_TOOL_NAMES,
  parseModelAction,
  parseModelOutput,
} from "./computer-use-types";
export type {
  ComputerUseLoopConfig,
  ComputerUseStep,
  ComputerUsePhase,
  ComputerUseStepTrace,
  ComputerUseAction,
  ComputerScreenshotRegion,
  ComputerUseModelOutput,
} from "./computer-use-types";
export {
  COMMANDER_PLAN_SCHEMA_JSON,
  COMMANDER_PLAN_SCHEMA_PROMPT,
  buildCommanderPlanPrompt,
  buildCommanderPlanRepairPrompt,
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
  | "language-reviewer"
  | "security-reviewer"
  | "build-fix"
  | "test-runner"
  | "doc-updater"
  | "explorer"
  | "perf-analyzer"
  | "refactor"
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
  inputContextKeys?: string[];
  outputContextKey?: string;
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
    action: "create" | "modify" | "move" | "copy" | "delete" | "overwrite" | "push";
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
  capabilityScore?: AgentCapabilityScoreSnapshot;
}

export interface AgentCapabilityScoreSnapshot {
  score: number;
  status: AgentCapabilityScore["status"];
  implemented: boolean;
  permissionReady: boolean;
  qaPassed: boolean;
  liveVerified: boolean;
  recentFailureRate: number;
  highestPermissionLevel: PermissionLevel;
  capabilityTags: string[];
  evidenceRefs: string[];
  gaps: string[];
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
  repoSearchReport?: CodeRepositorySearchResult;
  repoTraceReport?: CodeRepositoryTraceResult;
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
  /** Serializable multi-agent context handoff audit generated from DAG context keys. */
  handoffReport?: HandoffReport;
  /** Serializable recovery audit generated when failed steps trigger alternate paths. */
  recoveryReport?: RecoveryReport;
  /**
   * Structured audit of every Commander plan that flowed through the
   * executor: initial plan, repair attempts, and per-step recovery
   * compiles. Mirrors `recoveryReport` at a different layer (compile-time
   * gates) and is persisted alongside the task snapshot for product
   * analytics and post-mortem debugging.
   */
  planGenerationTrace?: PlanGenerationTrace;
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
  localVision?: {
    mode: NonNullable<ComputerUseStepTrace["localVision"]>["mode"];
    detectionCount?: number;
    promptCandidateCount?: number;
    latencyMs?: number;
    fullScreenshotVlmCalled?: boolean;
    cropVlmCalled?: boolean;
    fullScreenshotVlmSkipped?: boolean;
    consecutiveTimeouts?: number;
    consecutiveErrors?: number;
    consecutiveActionFailures?: number;
    consecutiveSlowDetections?: number;
    effectiveImgSize?: number;
    disabledReason?: NonNullable<ComputerUseStepTrace["localVision"]>["disabledReason"];
    selectedCandidateSource?: string[];
    actionType?: string;
    actionRisk?: NonNullable<ComputerUseStepTrace["localVision"]>["actionRisk"];
    actionSucceeded?: boolean;
    fallbackReason?: string;
  };
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
      originMode?: "chat" | "project";
      workspacePath?: string;
      appendUserMessage?: boolean;
      /** User-facing text (without <vision-context>). Defaults to userGoal. */
      displayGoal?: string;
      /** Image data URLs for display in the user's message bubble. */
      displayAttachments?: string[];
    },
  ): void;
  resolvePermission(decision: "approved" | "approved_always" | "denied", requestId?: string): void;
  respondToAskUser(answer: string, requestId?: string): void;
  stopTask(reason?: string): void;
  dispose(): void;
}

export interface RuntimeExecutionConfig {
  contextStrategy?: "auto" | "short" | "long";
  agentMaxIterations?: number;
  maxStepRetries?: number;
  taskTimeoutMs?: number;
  failureRecoveryEnabled?: boolean;
  userWaitTimeoutMs?: number;
}

export interface FileScanRuntimeOptions {
  fileTool: FileTool;
  chatTool?: ChatTool;
  commanderTool?: CommanderTool;
  computerTool?: ComputerTool;
  codeTool?: CodeTool;
  gitTool?: GitTool;
  projectTool?: ProjectTool;
  shellTool?: ShellTool;
  schedulerTool?: SchedulerTool;
  verifierTool?: VerifierTool;
  webTool?: WebTool;
  trendTool?: TrendTool;
  memoryTool?: MemoryTool;
  mcpTool?: McpTool;
  browserTool?: BrowserTool;
  visionTool?: VisionTool;
  workspaceTool?: WorkspaceTool;
  delayMs?: number;
  eventBus?: TaskEventBus;
  runtimeConfig?: RuntimeExecutionConfig;
  getRuntimeConfig?: () => RuntimeExecutionConfig | undefined;
  availableToolDescriptors?: ToolDescriptor[];
  getAvailableToolDescriptors?: () => ToolDescriptor[] | undefined;
  capabilityVerification?: AgentCapabilityVerificationInput;
  getCapabilityVerification?: () => AgentCapabilityVerificationInput | undefined;
  onTaskStarted?: (taskId: string) => void;
  /** Optional durable runtime event sink. If provided, the runtime forwards RuntimeEventEnvelope records. */
  runtimeEventSink?: {
    append: (envelope: RuntimeEventEnvelope) => void | Promise<void>;
  };
  /** Optional durable checkpoint sink. If provided, the runtime persists WorkflowCheckpoint snapshots. */
  checkpointSink?: {
    save: (checkpoint: WorkflowCheckpoint) => void | Promise<void>;
  };
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
    allowedToolNames?: string[];
    approveAction: (
      action: { tool: string; params: Record<string, unknown> },
      options?: {
        requiresFreshApproval?: boolean;
        screenshotDataUrl?: string;
        trustedWindowTitle?: string;
        timeoutMs?: number;
      },
    ) => Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }>;
    onStep?: (step: unknown) => void;
    onProgress?: (step: unknown) => void;
    signal?: AbortSignal;
  }) => Promise<unknown[]>;
}

export interface ChatTool {
  complete(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      locale?: string;
      skipAgentMemory?: boolean;
      skipSkillContext?: boolean;
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
      skipAgentMemory?: boolean;
      skipSkillContext?: boolean;
    },
  ): AsyncIterable<{
    text: string;
  }>;
}

const DEFAULT_AVAILABLE_TOOL_DESCRIPTORS = initialToolDescriptors.filter((descriptor) =>
  !isDisabledBrowserWriteToolName(descriptor.name)
);

function normalizeRuntimeToolDescriptors(
  toolDescriptors: readonly ToolDescriptor[] | undefined,
): ToolDescriptor[] {
  const source = toolDescriptors ?? DEFAULT_AVAILABLE_TOOL_DESCRIPTORS;
  const seen = new Set<string>();
  const normalized: ToolDescriptor[] = [];
  for (const descriptor of source) {
    if (seen.has(descriptor.name) || isDisabledBrowserWriteToolName(descriptor.name)) {
      continue;
    }
    seen.add(descriptor.name);
    normalized.push(descriptor);
  }
  return normalized;
}

function filterRuntimeToolDescriptorsForAvailableTools(
  toolDescriptors: readonly ToolDescriptor[],
  tools: { codeTool?: CodeTool; trendTool?: TrendTool },
): ToolDescriptor[] {
  return toolDescriptors.filter((descriptor) => {
    if (descriptor.name === "code.searchRepository") {
      return Boolean(tools.codeTool?.searchRepository);
    }
    if (descriptor.name === "code.traceCallChain") {
      return Boolean(tools.codeTool?.traceCallChain);
    }
    if (descriptor.name === "trend.fetchHotList") {
      return Boolean(tools.trendTool?.fetchHotList);
    }
    return true;
  });
}

function getVisionToolNameForGoal(userGoal: string): "vision.analyze" | "vision.describe" | "vision.extractText" {
  const mode = inferVisionMode(userGoal);
  if (mode === "ocr") return "vision.extractText";
  if (mode === "describe") return "vision.describe";
  return "vision.analyze";
}

function filterWebToolForAvailability(
  webTool: WebTool | undefined,
  hasTool: (toolName: string) => boolean,
): WebTool | undefined {
  if (!webTool) {
    return undefined;
  }
  return {
    fetchWebSource: webTool.fetchWebSource,
    searchWeb: hasTool("web.search") ? webTool.searchWeb : undefined,
  };
}

function filterCodeToolForAvailability(
  codeTool: CodeTool | undefined,
  hasTool: (toolName: string) => boolean,
): CodeTool | undefined {
  if (!codeTool) {
    return undefined;
  }
  return {
    inspectRepository: codeTool.inspectRepository,
    searchRepository: hasTool("code.searchRepository") ? codeTool.searchRepository : undefined,
    traceCallChain: hasTool("code.traceCallChain") ? codeTool.traceCallChain : undefined,
    proposeEdit: hasTool("code.proposeEdit") && hasTool("code.applyProposedEdit")
      ? codeTool.proposeEdit
      : undefined,
    applyProposedEdit: hasTool("code.applyProposedEdit") ? codeTool.applyProposedEdit : undefined,
  };
}

function filterFileToolForAvailability(
  fileTool: FileTool | undefined,
  hasTool: (toolName: string) => boolean,
): FileTool | undefined {
  if (!fileTool) {
    return undefined;
  }
  return {
    scanMarkdownDocuments: fileTool.scanMarkdownDocuments,
    planPdfOrganization: hasTool("file.planPdfOrganization") ? fileTool.planPdfOrganization : undefined,
    executePdfOrganization: hasTool("file.executePdfOrganization") ? fileTool.executePdfOrganization : undefined,
    planWriteText: hasTool("file.planWriteText") ? fileTool.planWriteText : undefined,
    writeText: hasTool("file.writeText") ? fileTool.writeText : undefined,
    scanUserDocuments: hasTool("file.scanUserDocuments") ? fileTool.scanUserDocuments : undefined,
    scanUserImages: hasTool("file.scanUserImages") ? fileTool.scanUserImages : undefined,
    scanInstalledApps: hasTool("file.scanInstalledApps") ? fileTool.scanInstalledApps : undefined,
    classifyDocuments: hasTool("file.classifyDocuments") ? fileTool.classifyDocuments : undefined,
  };
}

function filterGitToolForAvailability(
  gitTool: GitTool | undefined,
  hasTool: (toolName: string) => boolean,
): GitTool | undefined {
  if (!gitTool) {
    return undefined;
  }
  return {
    planStageFiles: hasTool("git.stageFiles") ? gitTool.planStageFiles : undefined,
    executeStageFiles: hasTool("git.stageFiles") ? gitTool.executeStageFiles : undefined,
    planCommit: hasTool("git.createCommit") ? gitTool.planCommit : undefined,
    executeCommit: hasTool("git.createCommit") ? gitTool.executeCommit : undefined,
    planCreatePullRequest: hasTool("git.createPullRequest") ? gitTool.planCreatePullRequest : undefined,
    executeCreatePullRequest: hasTool("git.createPullRequest") ? gitTool.executeCreatePullRequest : undefined,
    planCommentPullRequest: hasTool("git.commentPullRequest") ? gitTool.planCommentPullRequest : undefined,
    executeCommentPullRequest: hasTool("git.commentPullRequest") ? gitTool.executeCommentPullRequest : undefined,
  };
}

function createAgentSnapshots(
  selectState: (agent: Agent) => Pick<AgentSnapshot, "status" | "task">,
  verification?: AgentCapabilityVerificationInput,
): AgentSnapshot[] {
  return demoAgents.map((agent) => ({
    id: agent.id,
    name: agent.displayName,
    role: agent.description,
    ...selectState(agent),
    capabilityScore: getAgentCapabilityScoreSnapshot(agent, verification),
  }));
}

let agentCapabilityScoreSnapshotCache: Map<AgentKind, AgentCapabilityScoreSnapshot | undefined> | undefined;

const DEFAULT_PRODUCT_CAPABILITY_VERIFICATION: AgentCapabilityVerificationInput = {
  qaPassedAgentKinds: ["research", "code"],
  liveVerifiedAgentKinds: ["research"],
};

function getAgentCapabilityScoreSnapshot(
  agent: Agent,
  verification?: AgentCapabilityVerificationInput,
): AgentCapabilityScoreSnapshot | undefined {
  if (verification) {
    const registration = createDefaultAgentRegistry().findByKind(agent.kind);
    return registration
      ? toAgentCapabilityScoreSnapshot(scoreAgentCapability(registration, verification))
      : undefined;
  }
  if (!agentCapabilityScoreSnapshotCache) {
    const registry = createDefaultAgentRegistry();
    agentCapabilityScoreSnapshotCache = new Map(
      demoAgents.map((candidate) => {
        const registration = registry.findByKind(candidate.kind);
        return [
          candidate.kind,
          registration
            ? toAgentCapabilityScoreSnapshot(scoreAgentCapability(
                registration,
                DEFAULT_PRODUCT_CAPABILITY_VERIFICATION,
              ))
            : undefined,
        ];
      }),
    );
  }
  return agentCapabilityScoreSnapshotCache.get(agent.kind);
}

function toAgentCapabilityScoreSnapshot(score: AgentCapabilityScore): AgentCapabilityScoreSnapshot {
  return {
    score: score.score,
    status: score.status,
    implemented: score.implemented,
    permissionReady: score.permissionReady,
    qaPassed: score.qaPassed,
    liveVerified: score.liveVerified,
    recentFailureRate: score.recentFailureRate,
    highestPermissionLevel: score.highestPermissionLevel,
    capabilityTags: [...score.capabilityTags],
    evidenceRefs: [...score.evidenceRefs],
    gaps: [...score.gaps],
  };
}

export function createInitialTaskSnapshot(options: {
  capabilityVerification?: AgentCapabilityVerificationInput;
} = {}): TaskSnapshot {
  return {
    id: "task-idle",
    title: "Ready",
    userGoal: "Waiting for a task",
    status: "created",
    commanderMessage:
      "Javis desktop is ready. Enter a goal to start the Core event stream.",
    plan: [],
    agents: createAgentSnapshots(() => ({
      status: "queued",
      task: "Waiting",
    }), options.capabilityVerification),
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

const MODEL_CONTEXT_LIMITS: Record<NonNullable<RuntimeExecutionConfig["contextStrategy"]>, {
  maxMessages: number;
  maxChars: number;
  messageMaxChars: number;
}> = {
  short: { maxMessages: 40, maxChars: 8_000, messageMaxChars: 1_000 },
  auto: { maxMessages: 120, maxChars: 24_000, messageMaxChars: 2_000 },
  long: { maxMessages: 240, maxChars: 64_000, messageMaxChars: 4_000 },
};
const MODEL_CONTEXT_IMAGE_DATA_URL_PATTERN =
  /data:image\/(?:png|jpe?g|webp|gif|bmp|tiff?);base64,[A-Za-z0-9+/]+={0,2}/gi;

function selectModelContextMessages(
  messages: ChatMessage[],
  strategy: RuntimeExecutionConfig["contextStrategy"] = "auto",
): { messages: ChatMessage[]; omittedCount: number } {
  const limits = MODEL_CONTEXT_LIMITS[strategy ?? "auto"] ?? MODEL_CONTEXT_LIMITS.auto;
  const selected: ChatMessage[] = [];
  let selectedChars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeModelContextMessage(messages[index], limits.messageMaxChars);
    if (!normalized) {
      continue;
    }
    const nextChars = selectedChars + normalized.content.length;
    if (
      selected.length >= limits.maxMessages ||
      (selected.length > 0 && nextChars > limits.maxChars)
    ) {
      break;
    }
    selected.unshift(normalized);
    selectedChars = nextChars;
  }

  return {
    messages: selected,
    omittedCount: Math.max(0, messages.length - selected.length),
  };
}

function normalizeModelContextMessage(
  message: ChatMessage | undefined,
  messageMaxChars: number,
): ChatMessage | null {
  if (!message?.content.trim()) {
    return null;
  }
  const content = clipModelContextMessage(
    message.content
      .replace(MODEL_CONTEXT_IMAGE_DATA_URL_PATTERN, "[image data omitted]")
      .replace(/\s+/g, " ")
      .trim(),
    messageMaxChars,
  );
  if (!content) {
    return null;
  }
  return { role: message.role, content };
}

function clipModelContextMessage(content: string, messageMaxChars: number): string {
  if (content.length <= messageMaxChars) {
    return content;
  }
  const half = Math.floor((messageMaxChars - 7) / 2);
  return `${content.slice(0, half)} ... ${content.slice(-half)}`;
}



export function createFileScanTaskRuntime({
  fileTool,
  chatTool,
  commanderTool,
  computerTool,
  codeTool,
  gitTool,
  projectTool,
  shellTool,
  schedulerTool,
  verifierTool,
  webTool,
  trendTool,
  memoryTool,
  mcpTool,
  browserTool,
  visionTool,
  workspaceTool,
  delayMs = 250,
  eventBus,
  runtimeConfig,
  getRuntimeConfig,
  availableToolDescriptors,
  getAvailableToolDescriptors,
  capabilityVerification,
  getCapabilityVerification,
  onTaskStarted,
  runtimeEventSink,
  checkpointSink,
  reactDecideNext,
  replanDag,
  computerUseLoopRunner,
}: FileScanRuntimeOptions): TaskRuntime {
  const currentCapabilityVerification = () =>
    getCapabilityVerification?.() ?? capabilityVerification;
  const createRuntimeAgentSnapshots = (
    selectState: (agent: Agent) => Pick<AgentSnapshot, "status" | "task">,
  ) => createAgentSnapshots(selectState, currentCapabilityVerification());
  const runtimeState = createRuntimeState(
    createInitialTaskSnapshot({ capabilityVerification: currentCapabilityVerification() }),
    delayMs,
  );
  const eventBusUnsubscribe = eventBus
    ? eventBus.on((e) => {
        if (runtimeState.getSnapshot().id !== e.taskId) {
          return;
        }
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
  let activeAbortController: AbortController | undefined;
  function emit(nextSnapshot: TaskSnapshot) {
    runtimeState.emit(attachConversationMessages(attachRouteLog(attachTaskMetadata(nextSnapshot))));
  }
  function emitForActiveTask(taskId: ID, nextSnapshot: TaskSnapshot) {
    if (nextSnapshot.id !== taskId || runtimeState.getSnapshot().id !== taskId) {
      return;
    }
    emit(nextSnapshot);
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
  function stopActiveTask(reason = "Task cancelled.") {
    const controller = activeAbortController;
    activeAbortController = undefined;
    controller?.abort(new Error(reason));
    permissionHandlers.clear();
    queuedPermissionDecisions.clear();
    queuedLegacyPermissionDecision = undefined;
    askUserHandlers.clear();
    queuedAskUserAnswers.clear();

    const current = runtimeState.getSnapshot();
    if (isTerminalTaskStatus(current.status)) {
      return;
    }
    emit({
      ...current,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      commanderMessage: reason,
      askUserQuestion: current.askUserQuestion
        ? { ...current.askUserQuestion, status: "cancelled", resolvedAt: new Date().toISOString() }
        : undefined,
      permissionRequest: current.permissionRequest
        ? { ...current.permissionRequest, status: "cancelled", resolvedAt: new Date().toISOString() }
        : undefined,
      logs: appendLog(current, {
        id: `${current.id}-cancelled-${Date.now()}`,
        kind: "event",
        title: "task.cancelled",
        detail: reason,
      }),
    });
  }
  const wait = runtimeState.wait;
  function createTaskScopedController(taskId: ID) {
    const isCurrentTask = () => runtimeState.getSnapshot().id === taskId;
    return {
      emit(nextSnapshot: TaskSnapshot) {
        if (!isCurrentTask() || nextSnapshot.id !== taskId) {
          return;
        }
        emit(nextSnapshot);
      },
      getSnapshot: runtimeState.getSnapshot,
      wait,
      setPendingAskUserHandler(
        requestId: string,
        handler: AskUserAnswerHandler | undefined,
      ) {
        if (!isCurrentTask()) {
          return;
        }
        setPendingAskUserHandler(requestId, handler);
      },
      setPendingPermissionHandler(
        requestId: string,
        handler: PendingPermissionHandler | undefined,
      ) {
        if (!isCurrentTask()) {
          return;
        }
        setPendingPermissionHandler(requestId, handler);
      },
    };
  }
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
      agents: createRuntimeAgentSnapshots((agent) => ({
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

  function appendAskUserAnswerMessageOnce(
    messages: ConversationMessage[],
    answer: string,
  ): ConversationMessage[] {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "user" && lastMessage.content === answer) {
      return messages;
    }
    return [...messages, { role: "user", content: answer }];
  }

  function withoutTrailingUserMessage(messages: ChatMessage[]): ChatMessage[] {
    if (messages[messages.length - 1]?.role !== "user") {
      return messages;
    }
    return messages.slice(0, -1);
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
      stopActiveTask("Task replaced by a new request.");
      runtimeState.clearTimers();
      const taskAbortController = new AbortController();
      activeAbortController = taskAbortController;
      const signal = taskAbortController.signal;
      const startMode = options.mode ?? "auto";
      const taskId = options.taskId ?? `task-${Date.now()}`;
      const controller = createTaskScopedController(taskId);
      const effectiveRuntimeConfig = getRuntimeConfig?.() ?? runtimeConfig;
      const appendUserMessage = options.appendUserMessage !== false;
      const priorMessages = options.priorMessages ?? [];
      const modelPriorMessages = appendUserMessage
        ? priorMessages
        : withoutTrailingUserMessage(priorMessages);
      const modelContext = selectModelContextMessages(
        modelPriorMessages,
        effectiveRuntimeConfig?.contextStrategy,
      );
      const displayUserMessage: ChatMessage = {
        role: "user",
        content: options.displayGoal ?? userGoal,
        ...(options.displayAttachments ? { attachments: options.displayAttachments } : {}),
      };
      activeTaskMetadata = {
        taskId,
        originMode: options.originMode ?? (startMode === "chat" || startMode === "project" ? startMode : undefined),
        workspacePath: options.workspacePath?.trim() || undefined,
      };
      activeConversation = {
        taskId,
        startedMessages: appendUserMessage
          ? [...priorMessages, displayUserMessage]
          : [...priorMessages],
      };
      onTaskStarted?.(taskId);
      emitImmediateFeedback(taskId, userGoal);
      const routeDecision = routeMessage(userGoal);
      const routeLog = createRouteLog(taskId, userGoal, routeDecision);
      activeRouteLog = { taskId, log: routeLogToTaskLog(routeLog) };
      let effectiveToolDescriptors = normalizeRuntimeToolDescriptors(
        getAvailableToolDescriptors?.() ?? availableToolDescriptors,
      );
      const effectiveToolNames = new Set(effectiveToolDescriptors.map((descriptor) => descriptor.name));
      const hasTool = (toolName: string) => effectiveToolNames.has(toolName);
      const availableFileTool = filterFileToolForAvailability(fileTool, hasTool);
      const availableWebTool = filterWebToolForAvailability(webTool, hasTool);
      const availableCodeTool = filterCodeToolForAvailability(codeTool, hasTool);
      const availableGitTool = filterGitToolForAvailability(gitTool, hasTool);
      effectiveToolDescriptors = filterRuntimeToolDescriptorsForAvailableTools(effectiveToolDescriptors, {
        codeTool: availableCodeTool,
        trendTool,
      });
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
            priorMessages,
            modelContext.messages,
            modelContext.omittedCount,
            options.displayGoal,
            options.displayAttachments,
            routeDecision,
            routeLog,
            effectiveRuntimeConfig,
            signal,
            appendUserMessage,
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
          priorMessages,
          modelContext.messages,
          modelContext.omittedCount,
          options.displayGoal,
          options.displayAttachments,
          routeDecision,
          routeLog,
          effectiveRuntimeConfig,
          signal,
          appendUserMessage,
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
      if (
        visionTool &&
        isVisionGoal(userGoal) &&
        !userGoal.includes("<vision-context>") &&
        hasTool(getVisionToolNameForGoal(userGoal))
      ) {
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
        if (availableWebTool && hasTool("web.fetchSource") && extractUrls(userGoal).length > 0) {
          void runResearchSourceTask({ controller, taskId, userGoal, webTool: availableWebTool, commanderTool });
          return;
        }
        if (
          shellTool &&
          projectTool &&
          hasTool("file.scanMarkdownDocuments") &&
          hasTool("shell.runReadOnlyCommand") &&
          isReadCurrentProjectGoal(userGoal)
        ) {
          void runReadCurrentProjectWorkflow({
            controller,
            fileTool: availableFileTool ?? fileTool,
            commanderTool,
            projectTool,
            shellTool,
            codeTool: availableCodeTool,
            verifierTool,
            taskId,
            userGoal,
            availableToolDescriptors: effectiveToolDescriptors,
          });
          return;
        }
        if (
          availableFileTool?.planWriteText &&
          isTextWriteGoal(userGoal)
        ) {
          void runTextWriteTask({
            controller,
            fileTool: availableFileTool,
            webTool: availableWebTool,
            taskId,
            userGoal,
            commanderTool,
            setPendingPermissionHandler,
          });
          return;
        }
        if (
          availableWebTool?.searchWeb &&
          hasTool("web.search") &&
          hasTool("web.fetchSource") &&
          isResearchGoal(userGoal)
        ) {
          void runResearchSearchTask({ controller, taskId, userGoal, webTool: availableWebTool, commanderTool });
          return;
        }
        if (shellTool && projectTool && hasTool("shell.runReadOnlyCommand") && isProjectInspectionGoal(userGoal)) {
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
        if (
          availableCodeTool &&
          shellTool &&
          hasTool("code.inspectRepository") &&
          hasTool("shell.runReadOnlyCommand") &&
          isCodeReviewGoal(userGoal)
        ) {
          void runCodeReviewTask({
            controller,
            taskId,
            userGoal,
            codeTool: availableCodeTool,
            shellTool,
            commanderTool,
            setPendingPermissionHandler,
          });
          return;
        }
        if (
          availableFileTool?.planPdfOrganization &&
          isPdfOrganizationGoal(userGoal)
        ) {
          void runPdfOrganizationPreviewTask({
            controller,
            fileTool: availableFileTool,
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
            priorMessages,
            modelContext.messages,
            modelContext.omittedCount,
            options.displayGoal,
            options.displayAttachments,
            routeDecision,
            routeLog,
            effectiveRuntimeConfig,
            signal,
            appendUserMessage,
          );
          return;
        }
      }

      if (commanderTool) {
        void runCommanderDagTask({
          controller,
          commanderTool,
          codeTool: availableCodeTool,
          gitTool: availableGitTool,
          computerTool,
          fileTool,
          shellTool,
          schedulerTool,
          workspaceTool,
          webTool: availableWebTool,
          trendTool,
          memoryTool,
          mcpTool,
          browserTool,
          verifierTool,
          visionTool,
          taskId,
          userGoal,
          priorMessages: modelContext.messages,
          omittedPriorMessageCount: modelContext.omittedCount,
          fullPriorMessages: modelPriorMessages,
          contextSummaryTool: chatTool,
          initialLogs: [routeLogToTaskLog(routeLog)],
          runtimeConfig: effectiveRuntimeConfig,
          availableToolDescriptors: effectiveToolDescriptors,
          runtimeEventSink,
          checkpointSink,
          reactDecideNext,
          replanDag,
          computerUseLoopRunner,
          signal,
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

      if (availableWebTool && hasTool("web.fetchSource") && extractUrls(userGoal).length > 0) {
        void runResearchSourceTask({ controller, taskId, userGoal, webTool: availableWebTool, commanderTool });
        return;
      }
      const [recommendedWorkflowId] = recommendedWorkflowIds;
      if (
        shellTool &&
        projectTool &&
        hasTool("file.scanMarkdownDocuments") &&
        hasTool("shell.runReadOnlyCommand") &&
        isReadCurrentProjectGoal(userGoal)
      ) {
        void runReadCurrentProjectWorkflow({
          controller,
          fileTool: availableFileTool ?? fileTool,
          commanderTool,
          projectTool,
          shellTool,
          codeTool: availableCodeTool,
          verifierTool,
          taskId,
          userGoal,
          availableToolDescriptors: effectiveToolDescriptors,
        });
        return;
      }
      if (
        availableFileTool?.planWriteText &&
        isTextWriteGoal(userGoal)
      ) {
        void runTextWriteTask({
          controller,
          fileTool: availableFileTool,
          webTool: availableWebTool,
          taskId,
          userGoal,
          commanderTool,
          setPendingPermissionHandler,
        });
        return;
      }
      if (
        visionTool &&
        isVisionGoal(userGoal) &&
        !userGoal.includes("<vision-context>") &&
        hasTool(getVisionToolNameForGoal(userGoal))
      ) {
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
      if (
        availableWebTool?.searchWeb &&
        hasTool("web.search") &&
        hasTool("web.fetchSource") &&
        isResearchGoal(userGoal)
      ) {
        void runResearchSearchTask({ controller, taskId, userGoal, webTool: availableWebTool, commanderTool });
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
            codeTool: availableCodeTool,
            computerTool,
            fileTool,
            schedulerTool,
            webTool: availableWebTool,
            trendTool,
            browserTool,
            verifierTool,
            taskId,
            userGoal,
            workflowId:
              executableWorkflowIds.length === 1 ? executableWorkflowIds[0] : executableWorkflowIds,
            availableToolDescriptors: effectiveToolDescriptors,
          });
          return;
        }
      }
      if (shellTool && projectTool && hasTool("shell.runReadOnlyCommand") && isProjectInspectionGoal(userGoal)) {
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
      if (
        availableCodeTool &&
        shellTool &&
        hasTool("code.inspectRepository") &&
        hasTool("shell.runReadOnlyCommand") &&
        isCodeReviewGoal(userGoal)
      ) {
        void runCodeReviewTask({
          controller,
          taskId,
          userGoal,
          codeTool: availableCodeTool,
          shellTool,
          commanderTool,
          setPendingPermissionHandler,
        });
        return;
      }
      if (
        availableFileTool?.planPdfOrganization &&
        isPdfOrganizationGoal(userGoal)
      ) {
        void runPdfOrganizationPreviewTask({
          controller,
          fileTool: availableFileTool,
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
          priorMessages,
          modelContext.messages,
          modelContext.omittedCount,
          options.displayGoal,
          options.displayAttachments,
          routeDecision,
          routeLog,
          effectiveRuntimeConfig,
          signal,
          appendUserMessage,
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
      const askUserSnapshotBeforeAnswer = runtimeState.getSnapshot();

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
      const questionToResolve =
        current.askUserQuestion && (!resolvedId || current.askUserQuestion.id === resolvedId)
          ? current.askUserQuestion
          : askUserSnapshotBeforeAnswer.askUserQuestion &&
              (!resolvedId || askUserSnapshotBeforeAnswer.askUserQuestion.id === resolvedId)
            ? askUserSnapshotBeforeAnswer.askUserQuestion
            : undefined;
      if (questionToResolve) {
        const currentMessages = current.conversationMessages?.length
          ? current.conversationMessages
          : askUserSnapshotBeforeAnswer.conversationMessages ?? [];
        const resolvedQuestion = {
          ...questionToResolve,
          status: "answered",
          answer,
          resolvedAt: new Date().toISOString(),
        } as typeof questionToResolve;
        let hasQuestionMessage = false;
        const updatedMessages = currentMessages.map((message) => {
          if (message.kind !== "ask_user_question" || message.id !== resolvedQuestion.id) {
            return message;
          }
          hasQuestionMessage = true;
          return {
            ...message,
            content: resolvedQuestion.question,
            askUserQuestion: resolvedQuestion,
          };
        });
        if (!hasQuestionMessage) {
          updatedMessages.push({
            id: resolvedQuestion.id,
            kind: "ask_user_question",
            role: "assistant",
            content: resolvedQuestion.question,
            createdAt: resolvedQuestion.createdAt,
            askUserQuestion: resolvedQuestion,
          });
        }
        const answeredTimeline = appendAskUserAnswerMessageOnce(updatedMessages, answer);
        if (activeConversation?.taskId === current.id) {
          activeConversation = {
            ...activeConversation,
            startedMessages: answeredTimeline,
          };
        }
        runtimeState.emit({
          ...current,
          askUserQuestion: resolvedQuestion,
          conversationMessages: answeredTimeline,
        });
      }
    },
    stopTask(reason = "Task cancelled.") {
      stopActiveTask(reason);
    },
    dispose() {
      stopActiveTask("Runtime disposed.");
      eventBusUnsubscribe?.();
      runtimeState.dispose();
    },
  };

  async function runChatTask(
    taskId: ID,
    userGoal: string,
    activeChatTool: ChatTool,
    priorMessages: ChatMessage[] = [],
    modelMessages: ChatMessage[] = priorMessages,
    omittedPriorMessageCount = 0,
    displayGoal?: string,
    displayAttachments?: string[],
    routeDecision: RouteDecision = routeMessage(userGoal),
    routeLog: RouteLog = createRouteLog(taskId, userGoal, routeDecision),
    runtimeConfig?: RuntimeExecutionConfig,
    signal?: AbortSignal,
    appendUserMessage = true,
  ) {
    const isChinese = /[\u3400-\u9fff]/u.test(userGoal);
    const displayContent = displayGoal ?? userGoal;
    const displayUserMessage: ChatMessage = {
      role: "user",
      content: displayContent,
      ...(displayAttachments ? { attachments: displayAttachments } : {}),
    };
    const startedMessages: ChatMessage[] = appendUserMessage
      ? [...priorMessages, displayUserMessage]
      : [...priorMessages];
    emitForActiveTask(taskId, {
      id: taskId,
      title: isChinese ? "\u6b63\u5728\u56de\u7b54" : "Answering",
      userGoal,
      status: "running",
      updatedAt: new Date().toISOString(),
      commanderMessage: isChinese
        ? "\u6211\u6b63\u5728\u4f5c\u4e3a\u666e\u901a\u52a9\u624b\u56de\u7b54\uff0c\u6ca1\u6709\u542f\u52a8\u5de5\u4f5c\u6d41\u6216\u672c\u5730\u5de5\u5177\u3002"
        : "I'm answering as a general assistant without starting a workflow or local tool.",
      plan: [],
      agents: createRuntimeAgentSnapshots((agent) => ({
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
      const chatOptions = {
        maxTokens: 1200,
        temperature: 0.7,
        locale: isChinese ? "zh-CN" : "en",
      };
      const chatTimeoutMs = runtimeConfig?.taskTimeoutMs ?? 90_000;
      const result = await withTaskTimeout(
        () => completeGeneralChatWithContextRecovery({
          taskId,
          userGoal,
          isChinese,
          activeChatTool,
          priorMessages,
          modelMessages,
          omittedPriorMessageCount,
          options: chatOptions,
          timeoutMs: chatTimeoutMs,
          signal,
        }),
        {
          label: "chat.complete",
          timeoutMs: chatTimeoutMs,
          signal,
        },
      );
      const usage = result.tokenUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      const currentSnapshot = runtimeState.getSnapshot();
      if (currentSnapshot.id !== taskId) {
        return;
      }

      emitForActiveTask(taskId, {
        ...currentSnapshot,
        title: isChinese ? "\u5df2\u56de\u7b54" : "Answered",
        status: "completed",
        updatedAt: new Date().toISOString(),
        commanderMessage: result.text,
        conversationMessages: [
          ...startedMessages,
          { role: "assistant", content: result.text },
        ],
        agents: createRuntimeAgentSnapshots((agent) => ({
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
      if (isTaskCancelledError(error)) {
        const currentSnapshot = runtimeState.getSnapshot();
        if (currentSnapshot.id !== taskId) {
          return;
        }
        emitForActiveTask(taskId, {
          ...currentSnapshot,
          title: isChinese ? "已取消" : "Cancelled",
          status: "cancelled",
          updatedAt: new Date().toISOString(),
          commanderMessage: "Task cancelled.",
          agents: createRuntimeAgentSnapshots((agent) => ({
            status: agent.kind === "commander" ? "cancelled" : "completed",
            task: agent.kind === "commander" ? "Task cancelled" : "No workflow task assigned",
          })),
          logs: appendLog(currentSnapshot, {
            id: `${taskId}-cancelled-${Date.now()}`,
            kind: "event",
            title: "task.cancelled",
            detail: "Task cancelled.",
          }),
        });
        return;
      }
      runModelFailureTask(taskId, userGoal, error);
    }
  }

  async function runDirectChatTask(
    taskId: ID,
    userGoal: string,
    activeChatTool: ChatTool,
    priorMessages: ChatMessage[] = [],
    modelMessages: ChatMessage[] = priorMessages,
    omittedPriorMessageCount = 0,
    displayGoal?: string,
    displayAttachments?: string[],
    routeDecision: RouteDecision = routeMessage(userGoal),
    routeLog: RouteLog = createRouteLog(taskId, userGoal, routeDecision),
    runtimeConfig?: RuntimeExecutionConfig,
    signal?: AbortSignal,
    appendUserMessage = true,
  ) {
    return runChatTask(
      taskId,
      userGoal,
      activeChatTool,
      priorMessages,
      modelMessages,
      omittedPriorMessageCount,
      displayGoal,
      displayAttachments,
      routeDecision,
      routeLog,
      runtimeConfig,
      signal,
      appendUserMessage,
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
      skipAgentMemory?: boolean;
      skipSkillContext?: boolean;
    },
    timeoutMs = 90_000,
    signal?: AbortSignal,
  ): Promise<{ text: string; tokenUsage?: ModelUsage }> {
    throwIfTaskAborted(signal, "chat.complete");
    if (!activeChatTool.stream) {
      return withTaskTimeout(() => activeChatTool.complete(prompt, options), {
        label: "chat.complete",
        timeoutMs,
        signal,
      });
    }
    if (!eventBus) {
      return withTaskTimeout(() => activeChatTool.complete(prompt, options), {
        label: "chat.complete",
        timeoutMs,
        signal,
      });
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
        throwIfTaskAborted(signal, "chat.stream");
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
      throwIfTaskAborted(signal, "chat.stream");
      if (isContextOverflowError(streamError)) {
        eventBus.emit({
          kind: "agent.chunk_end",
          taskId,
          agentKind: "commander",
          fullText: text,
          error: "context overflow",
        });
        throw streamError;
      }
      console.log("[Javis] stream() threw, falling back to complete():", streamError);
      eventBus.emit({
        kind: "agent.chunk_end",
        taskId,
        agentKind: "commander",
        fullText: text,
        error: "stream failed",
      });
      return withTaskTimeout(() => activeChatTool.complete(prompt, options), {
        label: "chat.complete fallback",
        timeoutMs,
        signal,
      });
    }
  }

  async function completeGeneralChatWithContextRecovery(input: {
    taskId: ID;
    userGoal: string;
    isChinese: boolean;
    activeChatTool: ChatTool;
    priorMessages: ChatMessage[];
    modelMessages: ChatMessage[];
    omittedPriorMessageCount: number;
    options: {
      maxTokens?: number;
      temperature?: number;
      locale?: string;
      skipAgentMemory?: boolean;
      skipSkillContext?: boolean;
    };
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; tokenUsage?: ModelUsage }> {
    try {
      return await completeGeneralChat(
        input.taskId,
        createGeneralChatPrompt(
          input.userGoal,
          input.isChinese,
          input.modelMessages,
          input.omittedPriorMessageCount,
        ),
        input.activeChatTool,
        input.options,
        input.timeoutMs,
        input.signal,
      );
    } catch (error) {
      throwIfTaskAborted(input.signal, "chat.context_recovery");
      if (!isContextOverflowError(error) || input.priorMessages.length === 0) {
        throw error;
      }
      const recoveredMessages = await createRecoveredContextMessages({
        messages: input.priorMessages,
        summaryTool: input.activeChatTool,
        locale: input.options.locale,
        recentRounds: 5,
      });
      const recoveredPrompt = createGeneralChatPrompt(
        input.userGoal,
        input.isChinese,
        recoveredMessages,
        0,
      );
      return completeGeneralChat(
        input.taskId,
        recoveredPrompt,
        input.activeChatTool,
        input.options,
        input.timeoutMs,
        input.signal,
      );
    }
  }

  function createGeneralChatPrompt(
    userGoal: string,
    isChinese: boolean,
    priorMessages: ChatMessage[] = [],
    omittedPriorMessageCount = 0,
  ): string {
    const transcript = priorMessages.map((message) => {
      const speaker = message.role === "user" ? (isChinese ? "用户" : "User") : "Javis";
      return `${speaker}: ${message.content}`;
    });
    if (omittedPriorMessageCount > 0) {
      transcript.unshift(`(${omittedPriorMessageCount} earlier message(s) omitted)`);
    }
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
      isChinese
        ? "\u6ca1\u6709\u8bc1\u636e\u6216\u4e0d\u786e\u5b9a\u65f6\uff0c\u76f4\u63a5\u8bf4\u4e0d\u786e\u5b9a\u6216\u8bf7\u6c42\u66f4\u591a\u4fe1\u606f\uff1b\u4e0d\u8981\u628a\u63a8\u6d4b\u5199\u6210\u4e8b\u5b9e\u3002"
        : "When evidence is missing or uncertain, say so or ask for more information; do not present guesses as facts.",
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
      agents: createRuntimeAgentSnapshots(() => ({
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
    if (currentSnapshot.id !== taskId) {
      return;
    }
    const partialText = currentSnapshot.id === taskId
      ? (currentSnapshot.streamingText || currentSnapshot.commanderMessage || "").trim()
      : "";
    const userFacingError = isChinese
      ? "模型请求失败。已保留当前已生成的内容，请检查服务商、模型、API 密钥和基础 URL 后重试。"
      : "The model request failed. Any generated content was kept; check the provider, model, API key, and base URL before retrying.";
    emitForActiveTask(taskId, {
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
      agents: createRuntimeAgentSnapshots((agent) => ({
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
