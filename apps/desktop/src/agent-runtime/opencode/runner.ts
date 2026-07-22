import {
  validateCodeProposal,
  type AgentDefinition,
  type AgentEvent,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRuntime,
  type AgentTokenUsage,
  type AgentToolSpec,
  type StepResult,
} from "@javis/core";
import type { CodeProposedEdit, CodeReviewPreview } from "@javis/tools";

const FORBIDDEN_OPENCODE_TOOL_NAMES = new Set([
  "code.proposeEdit",
  "code.applyProposedEdit",
]);

export interface OpenCodeProposalRequest {
  taskId: string;
  runId: string;
  workflowRunId?: string;
  agentRunId?: string;
  stepId?: string;
  attempt?: number;
  userGoal: string;
  preview: CodeReviewPreview;
  signal?: AbortSignal;
}

export interface OpenCodeProposalCancelRequest {
  taskId: string;
  runId: string;
  workflowRunId?: string;
  agentRunId?: string;
  stepId?: string;
  attempt?: number;
}

export type OpenCodeProposalRunner = ((
  request: OpenCodeProposalRequest,
) => Promise<CodeProposedEdit>) & {
  cancel?: (request: OpenCodeProposalCancelRequest) => void | Promise<void>;
};

export interface OpenCodeAgentRuntimeOptions {
  proposeEdit: OpenCodeProposalRunner;
  toolSpecs?: readonly AgentToolSpec[];
}

export function createOpenCodeAgentRuntime(
  options: OpenCodeAgentRuntimeOptions,
): AgentRuntime {
  return {
    run(definition, request) {
      return runOpenCodeAgent(options, definition, request);
    },
  };
}

function runOpenCodeAgent(
  options: OpenCodeAgentRuntimeOptions,
  definition: AgentDefinition,
  request: AgentRunRequest,
): AgentRunHandle {
  const queue = new AgentEventQueue();
  const controller = new AbortController();
  let transportCancelRequested = false;
  const cancelTransport = () => {
    if (transportCancelRequested) return;
    transportCancelRequested = true;
    void Promise.resolve(options.proposeEdit.cancel?.({
      taskId: request.taskId,
      runId: request.runId,
      workflowRunId: request.workflowRunId,
      agentRunId: request.agentRunId,
      stepId: request.stepId,
      attempt: request.attempt,
    })).catch(() => undefined);
  };
  const abortFromRequest = () => {
    controller.abort(request.signal?.reason);
    cancelTransport();
  };
  request.signal?.addEventListener("abort", abortFromRequest, { once: true });
  if (request.signal?.aborted) abortFromRequest();
  const startedAt = Date.now();

  const emit = (event: AgentEvent) => {
    const callId = request.stepId && (
      event.type === "model.started" || event.type === "model.completed"
        ? `${request.stepId}:model:${event.callIndex}`
        : event.type === "usage.updated"
          ? `${request.stepId}:model:1`
          : undefined
    );
    queue.push(request.stepId && request.attempt !== undefined
      ? {
          ...event,
          stepId: request.stepId,
          attempt: request.attempt,
          ...(callId ? { callId } : {}),
        }
      : event);
  };
  const result = executeOpenCodeProposal(
    options,
    definition,
    { ...request, signal: controller.signal },
    emit,
  ).then((runResult): AgentRunResult => ({
    ...runResult,
    metrics: {
      backend: "opencode",
      status: runResult.status,
      durationMs: Date.now() - startedAt,
      modelCalls: runResult.status === "request_input" ? 0 : 1,
      toolCalls: 0,
      ...(runResult.usage ? { usage: runResult.usage } : {}),
    },
    termination: runResult.status === "cancelled" ? "cancelled" : "returned",
  })).then((runResult) => {
    if (runResult.status === "completed" || runResult.status === "request_input") {
      emit({ type: "run.completed", result: runResult });
    }
    return runResult;
  }).finally(() => {
    request.signal?.removeEventListener("abort", abortFromRequest);
    queue.close();
  });

  return {
    events: queue.iterate(),
    result,
    cancel() {
      controller.abort(new DOMException("Cancelled", "AbortError"));
      cancelTransport();
    },
  };
}

async function executeOpenCodeProposal(
  options: OpenCodeAgentRuntimeOptions,
  definition: AgentDefinition,
  request: AgentRunRequest,
  emit: (event: AgentEvent) => void,
): Promise<AgentRunResult> {
  emit({ type: "run.started", runId: request.runId });
  const forbiddenTool = [
    ...definition.allowedToolNames,
    ...(options.toolSpecs ?? []).map((tool) => tool.canonicalName),
  ].find((toolName) => FORBIDDEN_OPENCODE_TOOL_NAMES.has(toolName));
  if (forbiddenTool) {
    const reason = `OpenCode runtime must not expose ${forbiddenTool}.`;
    const stepResult = failedStepResult(
      "opencode_forbidden_tool",
      reason,
      "policy",
    );
    emit({ type: "policy.blocked", reason, permissionLevel: "preview" });
    emit({ type: "run.failed", reason });
    return { status: "failed", reason, stepResult };
  }

  const preview = resolveCodeReviewPreview(request.context);
  if (!preview) {
    const requestedContextKeys = ["diffPreview"];
    const reason = "OpenCode code proposal requires a diff preview input artifact.";
    const stepResult: StepResult = {
      status: "needs_clarification",
      evidence: [],
      assumptions: [],
      unresolvedQuestions: [reason],
      requestedContextKeys,
    };
    emit({ type: "context.requested", contextKeys: requestedContextKeys });
    return {
      status: "request_input",
      reason,
      requestedContextKeys,
      stepResult,
    };
  }

  try {
    emit({ type: "model.started", callIndex: 1 });
    const proposedEdit = await waitForProposal(options.proposeEdit({
      taskId: request.taskId,
      runId: request.runId,
      workflowRunId: request.workflowRunId,
      agentRunId: request.agentRunId,
      stepId: request.stepId,
      attempt: request.attempt,
      userGoal: request.stepContract?.instruction ?? readUserMessage(request),
      preview,
      signal: request.signal,
    }), request.signal);
    const safetyError = validateCodeProposal(proposedEdit);
    if (safetyError) {
      throw new OpenCodeProtocolError(safetyError);
    }
    const usage = proposedEdit.tokenUsage as AgentTokenUsage | undefined;
    const stepResult: StepResult<CodeProposedEdit> = {
      status: "completed",
      output: proposedEdit,
      evidence: proposedEdit.changedFiles.map((path) => ({
        kind: "file",
        label: `Proposed patch: ${path}`,
        reference: path,
      })),
      assumptions: [],
      unresolvedQuestions: [],
    };
    if (usage) emit({ type: "usage.updated", usage, revision: 1, final: true });
    emit({ type: "model.completed", callIndex: 1, finishReason: "stop" });
    return {
      status: "completed",
      output: proposedEdit,
      stepResult,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    const cancelled = request.signal?.aborted || isAbortError(error);
    const reason = cancelled
      ? "OpenCode Agent run was cancelled."
      : error instanceof Error ? error.message : String(error);
    if (cancelled) {
      emit({ type: "model.completed", callIndex: 1, finishReason: "cancelled" });
      emit({ type: "run.cancelled", reason });
      return { status: "cancelled", reason };
    }
    emit({ type: "model.completed", callIndex: 1, finishReason: "error" });
    const stepResult = failedStepResult(
      error instanceof OpenCodeProtocolError
        ? "opencode_invalid_proposal"
        : classifyOpenCodeError(reason),
      reason,
      error instanceof OpenCodeProtocolError ? "protocol" : "runtime",
    );
    emit({
      type: "backend.diagnostic",
      code: stepResult.errorDetail?.code ?? "opencode_runtime_failed",
      message: reason,
      phase: stepResult.errorDetail?.phase,
    });
    emit({ type: "run.failed", reason });
    return { status: "failed", reason, stepResult };
  }
}

function resolveCodeReviewPreview(
  context: Readonly<Record<string, unknown>>,
): CodeReviewPreview | undefined {
  const stepInput = context.stepInput;
  if (isRecord(stepInput)) {
    const fromStepInput = ["diffPreview", "codeReviewPreview", "preview"]
      .map((key) => stepInput[key])
      .find(isCodeReviewPreview);
    if (fromStepInput) return fromStepInput;
  }
  const preferred = ["diffPreview", "codeReviewPreview", "preview"]
    .map((key) => context[key])
    .find(isCodeReviewPreview);
  if (preferred) return preferred;
  const candidates = Object.values(context).filter(isCodeReviewPreview);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isCodeReviewPreview(value: unknown): value is CodeReviewPreview {
  if (!isRecord(value)) return false;
  return typeof value.workspacePath === "string" && value.workspacePath.trim().length > 0 &&
    Array.isArray(value.changedFiles) && value.changedFiles.length > 0 &&
    value.changedFiles.every((path) => typeof path === "string" && path.trim().length > 0) &&
    typeof value.diffStat === "string" && typeof value.diff === "string" &&
    value.diff.trim().length > 0;
}

function readUserMessage(request: AgentRunRequest): string {
  const text = request.messages.flatMap((message) => message.role === "user"
    ? message.content.flatMap((block) => block.type === "text" ? [block.text] : [])
    : []).join("\n").trim();
  return text || "Prepare a minimal code patch proposal.";
}

function failedStepResult(
  code: string,
  message: string,
  phase: "policy" | "protocol" | "runtime",
): StepResult {
  return {
    status: "failed",
    evidence: [],
    assumptions: [],
    unresolvedQuestions: [],
    error: message,
    errorDetail: {
      code,
      message,
      phase: phase === "policy" ? "verification" : phase,
      retryable: phase === "runtime",
    },
  };
}

function classifyOpenCodeError(message: string): string {
  return /unavailable|not found|could not find|failed to spawn/iu.test(message)
    ? "opencode_runtime_unavailable"
    : /empty|without.*output/iu.test(message)
      ? "opencode_empty_output"
      : "opencode_runtime_failed";
}

function waitForProposal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class OpenCodeProtocolError extends Error {}

class AgentEventQueue {
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }

  async *iterate(): AsyncGenerator<AgentEvent> {
    while (!this.closed || this.buffer.length > 0) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  }
}
