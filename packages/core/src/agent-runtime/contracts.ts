import type { AgentEvent } from "./event";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type AgentTextContentBlock = {
  type: "text";
  text: string;
};

export type AgentImageContentBlock = {
  type: "image";
  url: string;
  mimeType?: string;
};

export type AgentContentBlock = AgentTextContentBlock | AgentImageContentBlock;

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "system" | "user"; content: readonly AgentContentBlock[] }
  | {
      role: "assistant";
      content: readonly AgentContentBlock[];
      toolCalls?: readonly AgentToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: readonly AgentContentBlock[];
      status: "success" | "error";
    };

export interface AgentToolSpec {
  canonicalName: string;
  modelName: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  model?: string;
  provider?: string;
  contextWindowTokens?: number;
}

export interface AgentRuntimeRunMetrics {
  backend: AgentRuntimeBackend;
  status: "completed" | "failed" | "request_input" | "cancelled";
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  usage?: AgentTokenUsage;
}

export interface AgentRuntimeMetricsSnapshot {
  backend: AgentRuntimeRunMetrics["backend"];
  runCount: number;
  completedRunCount: number;
  successRate: number;
  totalDurationMs: number;
  averageDurationMs: number;
  modelCalls: number;
  toolCalls: number;
  usage?: AgentTokenUsage;
}

export interface AgentRuntimeRoutingObservation {
  observationId: string;
  providerId: string;
  agentKind: import("../index").AgentKind;
  taskType: string;
  backend: AgentRuntimeRouteBackend;
  rolloutTargeted: boolean;
  taskId: string;
  workflowRunId: string;
  agentRunId: string;
  stepId: string;
  attempt: number;
  primaryCapability?: string;
  permissionLevel?: "read" | "preview" | "confirmed_write" | "dangerous";
  provider?: string;
  model?: string;
  contextWindowTokens?: number;
  selectionReason?: string;
  fallbackReason?: AgentRuntimeFallbackReason;
}

/** Input compatibility for observations persisted before dual-kernel identity fields. */
export type AgentRuntimeRoutingObservationInput =
  Omit<
    AgentRuntimeRoutingObservation,
    "taskId" | "workflowRunId" | "agentRunId" | "stepId" | "attempt"
  > &
  Partial<
    Pick<
      AgentRuntimeRoutingObservation,
      "taskId" | "workflowRunId" | "agentRunId" | "stepId" | "attempt"
    >
  >;

export type AgentRuntimeRouteBackend = WorkflowExecutionBackend;

export type AgentRuntimeFallbackReason =
  | "native_tool_call_unavailable"
  | "runtime_factory_unavailable"
  | "runtime_initialization_failed"
  | "eligible_tools_unavailable"
  | "legacy_backend_selected";

export interface AgentRuntimeRoutingDecision {
  backend: WorkflowExecutionBackend;
  rolloutTargeted: boolean;
  selectionReason?: string;
  fallbackReason?: AgentRuntimeFallbackReason;
}

export interface AgentRuntimeRoutingMetricsSnapshot {
  providerId: string;
  agentKind: import("../index").AgentKind;
  taskType: string;
  routeCount: number;
  rolloutTargetCount: number;
  /** Optional so persisted pre-dual-kernel snapshots remain readable. */
  directRouteCount?: number;
  langchainRouteCount: number;
  /** Optional so persisted pre-dual-kernel snapshots remain readable. */
  opencodeRouteCount?: number;
  legacyRouteCount: number;
  /** Optional so persisted pre-dual-kernel snapshots remain readable. */
  javisSpecializedRouteCount?: number;
  unavailableRouteCount: number;
  fallbackCount: number;
  fallbackRate: number;
  fallbackReasons: Array<{
    reason: AgentRuntimeFallbackReason;
    count: number;
  }>;
  observationIds: string[];
}

export interface AgentModelCapabilities {
  nativeToolCalling: boolean;
  streamingToolCalls: boolean;
  structuredOutput: boolean;
  parallelToolCalls: boolean;
}

export type AgentToolChoice = "auto" | "none" | "required" | { name: string };

export interface AgentChatRequest {
  model?: string;
  messages: readonly AgentMessage[];
  tools?: readonly AgentToolSpec[];
  toolChoice?: AgentToolChoice;
  responseSchema?: JsonSchema;
  parallelToolCalls?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentChatResponse {
  message: Extract<AgentMessage, { role: "assistant" }>;
  finishReason:
    | "stop"
    | "tool_calls"
    | "length"
    | "content_filter"
    | "cancelled"
    | "error";
  usage?: AgentTokenUsage;
}

export type AgentChatStreamEvent =
  | { type: "message_start"; messageId: string }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_arguments_delta"; index: number; delta: string }
  | { type: "tool_call_end"; index: number }
  | { type: "usage"; usage: AgentTokenUsage }
  | { type: "message_end"; finishReason: AgentChatResponse["finishReason"] };

export interface AgentModelGateway {
  capabilities(model?: string): AgentModelCapabilities;
  complete(request: AgentChatRequest): Promise<AgentChatResponse>;
  stream(request: AgentChatRequest): AsyncIterable<AgentChatStreamEvent>;
}

export interface AgentDefinition {
  id: string;
  kind: import("../index").AgentKind;
  liveAgentKinds?: readonly import("../index").AgentKind[];
  instructions: string;
  allowedToolNames: readonly string[];
  limits: {
    maxModelCalls: number;
    maxToolCalls: number;
    modelTimeoutMs: number;
    toolTimeoutMs: number;
  };
  outputSchema?: JsonSchema;
}

export interface AgentRunRequest {
  taskId: string;
  runId: string;
  /** Optional during migration; new adapters should provide all runtime identity fields. */
  workflowRunId?: string;
  agentRunId?: string;
  stepId?: string;
  attempt?: number;
  threadId?: string;
  messages: readonly AgentMessage[];
  context: Readonly<Record<string, unknown>>;
  /** Normalized Javis contract for adapters that do not infer intent from model text. */
  stepContract?: import("../step-protocol").StepContract;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "request_input" | "cancelled";
  /** Transport-level termination. The legacy status remains for compatibility. */
  termination?: "returned" | "cancelled";
  /** Adapter-normalized five-state result, when the backend supports it. */
  stepResult?: import("../step-protocol").StepResult;
  output?: unknown;
  reason?: string;
  requestedContextKeys?: readonly string[];
  requestedAgentKind?: import("../index").AgentKind;
  usage?: AgentTokenUsage;
  metrics?: AgentRuntimeRunMetrics;
}

export interface AgentRunHandle {
  events: AsyncIterable<AgentEvent>;
  result: Promise<AgentRunResult>;
  cancel(): void;
}

export interface AgentRuntime {
  run(definition: AgentDefinition, request: AgentRunRequest): AgentRunHandle;
}

export type AgentRuntimeBackend = "legacy" | "langchain" | "opencode";

export type ModernAgentRuntimeBackend = Exclude<AgentRuntimeBackend, "legacy">;

export type WorkflowExecutionBackend =
  | "direct"
  | AgentRuntimeBackend
  | "javis_specialized"
  | "unavailable";

export interface AgentRouteRequest {
  taskId: string;
  workflowRunId: string;
  stepId: string;
  attempt: number;
  executionMode: "direct_response" | "direct_tool_call" | "react" | "desktop_input";
  primaryCapability?: string;
  agentKind: import("../index").AgentKind;
  permissionLevel: "read" | "preview" | "confirmed_write" | "dangerous";
  provider?: string;
  model?: string;
  contextWindowTokens?: number;
}

export type AgentRuntimeFactory = (options: {
  backend?: ModernAgentRuntimeBackend;
  agentKind: import("../index").AgentKind;
  primaryCapability?: string;
  toolGateway: ToolExecutionGateway;
  toolSpecs: readonly AgentToolSpec[];
}) => AgentRuntime;

/** Independent backend registrations used by the desktop adapter layer. */
export type AgentRuntimeFactoryRegistry = Readonly<
  Partial<Record<ModernAgentRuntimeBackend, AgentRuntimeFactory>>
>;

export interface ToolExecutionResult {
  status: "success" | "error";
  output?: unknown;
  reason?: string;
}

export interface ToolExecutionGateway {
  execute(request: {
    taskId: string;
    runId: string;
    agentKind: import("../index").AgentKind;
    toolName: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult>;
}
