import type { Agent, AgentKind } from "./index";
import type { SharedTaskContext } from "./shared-context";
import { formatStepInputValidationError, validateStepInputContext } from "./shared-context";
import { DEFAULT_TASK_TIMEOUT_MS, throwIfTaskAborted, withTaskTimeout } from "./task-wait";
import type { WorkbenchWorkflowStep } from "./workflows";
import { isSensitiveFieldName, redactSensitiveText } from "./sensitive-data";
import type { AgentRuntimeRunMetrics, AgentTokenUsage } from "./agent-runtime/contracts";
import { addAgentTokenUsage } from "./agent-runtime/metrics";

export interface AgentReActObservation {
  iteration: number;
  toolName: string;
  status: "succeeded" | "failed";
  output: unknown;
  /** Set when the raw tool output was not usable evidence before bounding. */
  outputUsable?: boolean;
  /** Set when the bounded representation omits part of the raw output. */
  outputTruncated?: boolean;
  error?: string;
}

export interface AgentReActTool {
  name: string;
  baseInput?: Record<string, unknown>;
  /** Optional live Agent that should collect replacement evidence after this tool fails. */
  failureFallbackAgentKind?: AgentKind;
  failureFallbackCapability?: string;
  failureFallbackContextKey?: string;
  requiredInputs?: Array<{
    name: string;
    type: "string" | "string[]" | "number" | "number[]" | "boolean" | "boolean[]" | "object" | "object[]";
    nonEmpty?: boolean;
  }>;
  execute(request: {
    agent: Agent;
    step: WorkbenchWorkflowStep;
    context: SharedTaskContext;
    observations: AgentReActObservation[];
    input?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface AgentReActDecision {
  status: "continue" | "completed" | "failed" | "request_input";
  toolName?: string;
  input?: Record<string, unknown>;
  reason: string;
  output?: unknown;
  requestedContextKeys?: string[];
  requestedAgentKind?: AgentKind;
  usage?: AgentTokenUsage;
}

export interface AgentReActLoopOptions {
  agent: Agent;
  step: WorkbenchWorkflowStep;
  context: SharedTaskContext;
  tools: ReadonlyArray<AgentReActTool>;
  /** Agent kinds currently registered in this runtime. */
  liveAgentKinds?: ReadonlyArray<AgentKind>;
  maxIterations?: number;
  signal?: AbortSignal;
  decisionTimeoutMs?: number;
  toolTimeoutMs?: number;
  decideNext(request: {
    agent: Agent;
    step: WorkbenchWorkflowStep;
    context: SharedTaskContext;
    observations: AgentReActObservation[];
    availableToolNames: string[];
  }): Promise<AgentReActDecision> | AgentReActDecision;
  /** Called after each ReAct iteration (tool execution) to emit progress snapshots. */
  onIteration?: (iteration: number, observation: AgentReActObservation) => void;
  onToolEvent?: (event: AgentReActToolEvent) => void;
  onWaiting?: (phase: "waiting_model" | "waiting_tool", iteration: number, detail: string) => void;
  onTimeout?: (phase: "waiting_model" | "waiting_tool", iteration: number, detail: string) => void;
  onRunMetrics?: (metrics: AgentRuntimeRunMetrics) => void;
}

export interface AgentReActToolEvent {
  phase: "requested" | "started" | "completed" | "failed";
  toolCallId: string;
  toolName: string;
  reason?: string;
  outputTruncated?: boolean;
}

export interface AgentReActLoopResult {
  status: "completed" | "failed" | "request_input";
  output?: unknown;
  observations: AgentReActObservation[];
  reason: string;
  requestedContextKeys?: string[];
  requestedAgentKind?: AgentKind;
  metrics: AgentRuntimeRunMetrics;
}

export async function runAgentReActLoop(
  options: AgentReActLoopOptions,
): Promise<AgentReActLoopResult> {
  const startedAt = Date.now();
  let modelCalls = 0;
  let toolCalls = 0;
  let usage: AgentTokenUsage | undefined;
  try {
    const result = await runAgentReActLoopInternal({
      ...options,
      tools: options.tools.map((tool) => ({
        ...tool,
        execute: async (request) => {
          toolCalls += 1;
          return tool.execute(request);
        },
      })),
      decideNext: async (request) => {
        modelCalls += 1;
        const decision = await options.decideNext(request);
        usage = addAgentTokenUsage(usage, decision.usage);
        return decision;
      },
    });
    const metrics: AgentRuntimeRunMetrics = {
      backend: "legacy",
      status: result.status,
      durationMs: Date.now() - startedAt,
      modelCalls,
      toolCalls,
      ...(usage ? { usage } : {}),
    };
    notifyRunMetrics(options.onRunMetrics, metrics);
    return { ...result, metrics };
  } catch (error) {
    notifyRunMetrics(options.onRunMetrics, {
      backend: "legacy",
      status: options.signal?.aborted ? "cancelled" : "failed",
      durationMs: Date.now() - startedAt,
      modelCalls,
      toolCalls,
      ...(usage ? { usage } : {}),
    });
    throw error;
  }
}

function notifyRunMetrics(
  observer: AgentReActLoopOptions["onRunMetrics"],
  metrics: AgentRuntimeRunMetrics,
): void {
  try {
    observer?.(metrics);
  } catch {
    // Observability must never change the Agent result or mask its failure.
  }
}

async function runAgentReActLoopInternal(
  options: AgentReActLoopOptions,
): Promise<Omit<AgentReActLoopResult, "metrics">> {
  const {
    agent,
    step,
    context,
    tools,
    maxIterations = 6,
    signal,
    decisionTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    toolTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    decideNext,
  } = options;
  assertAgentOwnsStep(agent, step.agentKind);

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const availableToolNames = tools
    .map((tool) => tool.name)
    .filter((toolName) => agent.allowedToolNames.includes(toolName));
  const observations: AgentReActObservation[] = [];
  const inputValidation = validateStepInputContext(step, context);
  if (!inputValidation.valid) {
    return {
      status: "failed",
      observations,
      reason: formatStepInputValidationError(inputValidation),
    };
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    throwIfTaskAborted(signal, `ReAct ${step.id}`);
    options.onWaiting?.("waiting_model", iteration, "Waiting for ReAct decision.");
    const decisionObservations = boundObservationHistory(observations);
    const decision = await withTaskTimeout(
      () => Promise.resolve(decideNext({
        agent,
        step,
        context,
        observations: decisionObservations,
        availableToolNames,
      })),
      {
        label: `ReAct decision ${step.id} iteration ${iteration}`,
        timeoutMs: decisionTimeoutMs,
        signal,
        onTimeout: () => options.onTimeout?.("waiting_model", iteration, "ReAct decision timed out."),
      },
    );

    if (decision.status === "completed") {
      const lastObservation = observations[observations.length - 1];
      if (
        !lastObservation ||
        lastObservation.status !== "succeeded" ||
        lastObservation.outputUsable === false ||
        lastObservation.outputTruncated === true ||
        !hasUsableObservationOutput(lastObservation.output)
      ) {
        return {
          status: "failed",
          observations: boundObservationHistory(observations),
          reason: "Agent cannot complete before the latest tool observation succeeds with usable evidence.",
        };
      }
      return {
        status: "completed",
        output: agent.kind === "page-agent" && hasUsableObservationOutput(decision.output)
          ? sanitizeAgentReActOutput(decision.output)
          : lastObservation.output,
        observations: boundObservationHistory(observations),
        reason: decision.reason,
      };
    }

    if (decision.status === "failed") {
      return {
        status: "failed",
        output: sanitizeAgentReActOutput(decision.output),
        observations: boundObservationHistory(observations),
        reason: decision.reason,
      };
    }

    if (decision.status === "request_input") {
      const requestInput = validateRequestInputDecision(decision, options.liveAgentKinds);
      if (!requestInput.valid) {
        return {
          status: "failed",
          observations: boundObservationHistory(observations),
          reason: requestInput.reason,
        };
      }
      return {
        status: "request_input",
        output: sanitizeAgentReActOutput(decision.output),
        observations: boundObservationHistory(observations),
        reason: decision.reason,
        requestedContextKeys: requestInput.requestedContextKeys,
        requestedAgentKind: requestInput.requestedAgentKind,
      };
    }

    if (!decision.toolName) {
      return {
        status: "failed",
        observations: boundObservationHistory(observations),
        reason: "Agent requested another action without selecting a tool.",
      };
    }

    if (!agent.allowedToolNames.includes(decision.toolName)) {
      return {
        status: "failed",
        observations: boundObservationHistory(observations),
        reason: `Agent ${agent.kind} cannot use tool ${decision.toolName}.`,
      };
    }

    const tool = toolMap.get(decision.toolName);
    if (!tool) {
      return {
        status: "failed",
        observations: boundObservationHistory(observations),
        reason: `Tool ${decision.toolName} is not available in this runtime.`,
      };
    }

    const toolInput = {
      ...(tool.baseInput ?? {}),
      ...(decision.input ?? {}),
    };
    const inputError = validateRequiredToolInputs(tool, toolInput);
    if (inputError) {
      return {
        status: "failed",
        observations: boundObservationHistory(observations),
        reason: inputError,
      };
    }

    const toolCallId = `${step.id}:react:${iteration}`;
    options.onToolEvent?.({
      phase: "requested",
      toolCallId,
      toolName: decision.toolName,
    });
    let observation: AgentReActObservation;
    try {
      options.onToolEvent?.({
        phase: "started",
        toolCallId,
        toolName: decision.toolName,
      });
      options.onWaiting?.("waiting_tool", iteration, `Waiting for tool ${decision.toolName}.`);
      const output = await withTaskTimeout(
        () => tool.execute({
          agent,
          step,
          context,
          observations: decisionObservations,
          input: toolInput,
        }),
        {
          label: `ReAct tool ${decision.toolName} for ${step.id} iteration ${iteration}`,
          timeoutMs: toolTimeoutMs,
          signal,
          onTimeout: () => options.onTimeout?.("waiting_tool", iteration, `Tool ${decision.toolName} timed out.`),
        },
      );
      const rawOutputUsable = hasUsableObservationOutput(output);
      const boundedOutput = boundObservationOutput(output);
      observation = {
        iteration,
        toolName: decision.toolName,
        status: "succeeded",
        output: boundedOutput.value,
        ...(rawOutputUsable ? {} : { outputUsable: false }),
        ...(boundedOutput.truncated ? { outputTruncated: true } : {}),
      };
    } catch (error) {
      observation = {
        iteration,
        toolName: decision.toolName,
        status: "failed",
        output: undefined,
        error: boundObservationError(error),
      };
    }
    observations.push(observation);
    options.onToolEvent?.({
      phase: observation.status === "succeeded" ? "completed" : "failed",
      toolCallId,
      toolName: decision.toolName,
      ...(observation.error ? { reason: observation.error } : {}),
      ...(observation.outputTruncated ? { outputTruncated: true } : {}),
    });
    writeBoundedObservationContext(context, step.id, observations);
    options.onIteration?.(iteration, observation);
    if (
      observation.status === "failed" &&
      tool.failureFallbackAgentKind &&
      options.liveAgentKinds?.includes(tool.failureFallbackAgentKind)
    ) {
      const requestedContextKey = tool.failureFallbackContextKey?.trim() || `fallbackEvidence:${step.id}`;
      return {
        status: "request_input",
        observations: boundObservationHistory(observations),
        reason: `Tool ${tool.name} failed; request replacement evidence from ${tool.failureFallbackAgentKind}` +
          (tool.failureFallbackCapability ? ` using capability ${tool.failureFallbackCapability}.` : "."),
        requestedContextKeys: [requestedContextKey],
        requestedAgentKind: tool.failureFallbackAgentKind,
      };
    }
  }

  return {
    status: "failed",
    observations: boundObservationHistory(observations),
    reason: `Agent ${agent.kind} reached the ReAct iteration limit (${maxIterations}).`,
  };
}

export const MAX_REACT_REQUESTED_CONTEXT_KEYS = 16;
export const MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS = 128;
const REQUESTED_CONTEXT_KEY_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u;

type RequestInputValidation =
  | {
      valid: true;
      requestedContextKeys: string[];
      requestedAgentKind?: AgentKind;
    }
  | { valid: false; reason: string };

export function validateAgentRequestInput(
  requestedContextKeys: unknown,
  requestedAgentKind: unknown,
  liveAgentKinds: ReadonlyArray<AgentKind> | undefined,
): RequestInputValidation {
  if (!Array.isArray(requestedContextKeys) || requestedContextKeys.length === 0) {
    return invalidRequestInput("requestedContextKeys must be a non-empty array.");
  }
  if (requestedContextKeys.length > MAX_REACT_REQUESTED_CONTEXT_KEYS) {
    return invalidRequestInput(
      `requestedContextKeys cannot contain more than ${MAX_REACT_REQUESTED_CONTEXT_KEYS} keys.`,
    );
  }

  const validatedKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (let index = 0; index < requestedContextKeys.length; index += 1) {
    const key: unknown = requestedContextKeys[index];
    if (typeof key !== "string") {
      return invalidRequestInput(`requestedContextKeys[${index}] must be a string.`);
    }
    if (
      key.length === 0 ||
      key.length > MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS ||
      key !== key.trim() ||
      !REQUESTED_CONTEXT_KEY_PATTERN.test(key)
    ) {
      return invalidRequestInput(
        `requestedContextKeys[${index}] must be a valid context key of at most ${MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS} characters.`,
      );
    }
    if (seenKeys.has(key)) {
      return invalidRequestInput("requestedContextKeys must not contain duplicates.");
    }
    seenKeys.add(key);
    validatedKeys.push(key);
  }

  if (requestedAgentKind === undefined) {
    return { valid: true, requestedContextKeys: validatedKeys };
  }
  if (
    typeof requestedAgentKind !== "string" ||
    !liveAgentKinds?.includes(requestedAgentKind as AgentKind)
  ) {
    return invalidRequestInput("requestedAgentKind must identify a live registered agent.");
  }

  return {
    valid: true,
    requestedContextKeys: validatedKeys,
    requestedAgentKind: requestedAgentKind as AgentKind,
  };
}

function validateRequestInputDecision(
  decision: AgentReActDecision,
  liveAgentKinds: ReadonlyArray<AgentKind> | undefined,
): RequestInputValidation {
  return validateAgentRequestInput(
    decision.requestedContextKeys,
    decision.requestedAgentKind,
    liveAgentKinds,
  );
}

function invalidRequestInput(reason: string): RequestInputValidation {
  return { valid: false, reason: `Invalid request_input decision: ${reason}` };
}

function validateRequiredToolInputs(
  tool: AgentReActTool,
  input: Record<string, unknown>,
): string | undefined {
  for (const required of tool.requiredInputs ?? []) {
    const value = input[required.name];
    const valid = required.type === "string"
      ? typeof value === "string" && (!required.nonEmpty || value.trim().length > 0)
      : required.type === "string[]"
        ? Array.isArray(value) && value.every((item) => typeof item === "string") &&
          (!required.nonEmpty || (value.length > 0 && value.every((item) => item.trim().length > 0)))
        : required.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : required.type === "number[]"
            ? Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
              (!required.nonEmpty || value.length > 0)
            : required.type === "boolean"
              ? typeof value === "boolean"
              : required.type === "boolean[]"
                ? Array.isArray(value) && value.every((item) => typeof item === "boolean") &&
                  (!required.nonEmpty || value.length > 0)
                : required.type === "object"
                  ? typeof value === "object" && value !== null && !Array.isArray(value)
                  : Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item)) &&
                    (!required.nonEmpty || value.length > 0);
    if (!valid) {
      return `Tool ${tool.name} requires input.${required.name} to match type ${required.type}${required.nonEmpty ? " (non-empty)" : ""}.`;
    }
  }
  return undefined;
}

const MAX_REACT_OBSERVATION_CHARS = 12_000;
export const MAX_REACT_OBSERVATION_TOTAL_CHARS = 32_000;
const MAX_REACT_OBSERVATION_ERROR_CHARS = 2_000;
const MAX_REACT_OUTPUT_VALIDATION_DEPTH = 32;
const IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu;
const EXPLICIT_FAILURE_STATUS = new Set([
  "cancelled",
  "canceled",
  "denied",
  "error",
  "errored",
  "fail",
  "failed",
  "failure",
  "rejected",
  "timed_out",
  "timeout",
]);
const EXPLICIT_NON_TERMINAL_STATUS = new Set([
  "in_progress",
  "pending",
  "processing",
  "queued",
  "running",
  "waiting",
]);
const EXPLICIT_FAILURE_TEXT_PATTERN = /^(?:cancelled|canceled|denied|error|failed|failure|rejected|timed out|timeout)(?:\b|\s|:)/iu;
const EXPLICIT_NON_TERMINAL_TEXT_PATTERN = /^(?:in[_ -]?progress|pending|processing|queued|running|waiting)(?:[.!?]?|:\s*.*)$/iu;
const EMPTY_RESULT_KEYS = new Set(["matches", "items", "results", "tools", "sources", "records", "entries"]);
const EMPTY_RESULT_TEXT_PATTERN = /^(?:no\s+(?:results?|matches?|items?|tools?|sources?|records?|entries?)|not\s+found|no\s+data|无结果|没有结果|未找到|未发现)(?:[.!:?：。！？]|\s|$)/iu;

function hasUsableObservationOutput(
  output: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): boolean {
  // A boolean false is a failure/negative sentinel, not positive evidence.
  if (output === undefined || output === null || output === false) return false;
  if (depth > MAX_REACT_OUTPUT_VALIDATION_DEPTH) return false;
  if (typeof output === "string") {
    const text = output.trim();
    return text.length > 0 &&
      !EXPLICIT_FAILURE_TEXT_PATTERN.test(text) &&
      !EXPLICIT_NON_TERMINAL_TEXT_PATTERN.test(text) &&
      !EMPTY_RESULT_TEXT_PATTERN.test(text);
  }
  if (typeof output === "number") return Number.isFinite(output);
  if (typeof output === "boolean") return output;
  if (typeof output !== "object") return false;
  if (Array.isArray(output)) {
    return output.length > 0 && output.every((item) =>
      hasUsableObservationOutput(item, depth + 1, seen),
    );
  }
  if (typeof output === "object") {
    if (seen.has(output)) return false;
    seen.add(output);
    const record = output as Record<string, unknown>;
    if (Object.keys(record).length === 0 || isExplicitFailureRecord(record)) {
      return false;
    }
    if (hasEmptyResultContainer(record, 2)) return false;
    if (hasInvalidNestedResultArray(record, depth + 1, new WeakSet<object>())) return false;
    return hasPositiveObservationPayload(record, depth + 1, seen);
  }
  return false;
}

function hasEmptyResultContainer(
  record: Record<string, unknown>,
  depth: number,
  seen = new WeakSet<object>(),
): boolean {
  if (seen.has(record)) return true;
  seen.add(record);
  for (const [key, value] of Object.entries(record)) {
    if (
      EMPTY_RESULT_KEYS.has(key.toLowerCase()) &&
      (value === null || value === undefined || value === false ||
        Array.isArray(value) && value.length === 0 ||
        typeof value === "string" && value.trim().length === 0)
    ) {
      return true;
    }
    if (depth > 0 && value && typeof value === "object" && !Array.isArray(value)) {
      if (hasEmptyResultContainer(value as Record<string, unknown>, depth - 1, seen)) return true;
    }
  }
  return false;
}

function hasInvalidNestedResultArray(
  record: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): boolean {
  if (depth > MAX_REACT_OUTPUT_VALIDATION_DEPTH) return true;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && !Number.isFinite(value)) return true;
    if (Array.isArray(value)) {
      const booleanDataArray = !EMPTY_RESULT_KEYS.has(key.toLowerCase()) &&
        value.length > 0 && value.every((item) => typeof item === "boolean");
      if (
        EMPTY_RESULT_KEYS.has(key.toLowerCase()) && value.length === 0 ||
        !booleanDataArray && value.some((item) =>
          !hasUsableObservationOutput(item, depth + 1, seen)
        )
      ) {
        return true;
      }
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (seen.has(value)) return true;
      seen.add(value);
      const nestedRecord = value as Record<string, unknown>;
      if (
        isExplicitFailureRecord(nestedRecord) ||
        hasInvalidNestedResultArray(nestedRecord, depth + 1, seen)
      ) {
        return true;
      }
    }
  }
  return false;
}

const OBSERVATION_CONTROL_KEYS = new Set([
  "status",
  "error",
  "errors",
  "failedcount",
  "progress",
  "position",
  "jobid",
]);

function hasPositiveObservationPayload(
  record: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): boolean {
  if (depth > MAX_REACT_OUTPUT_VALIDATION_DEPTH) return false;
  if (record.ok === true || record.success === true || record.passed === true) return true;
  if (record.completed === true || record.done === true || record.finished === true) {
    const result = record.result ?? record.output ?? record.data ?? record.value;
    if (hasUsableObservationOutput(result, depth + 1, seen)) return true;
  }
  if (record.exitCode === 0) return true;

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replace(/[\s_-]+/gu, "");
    if (
      OBSERVATION_CONTROL_KEYS.has(normalizedKey) ||
      normalizedKey === "ok" ||
      normalizedKey === "success" ||
      normalizedKey === "passed" ||
      normalizedKey === "completed" ||
      normalizedKey === "done" ||
      normalizedKey === "finished" ||
      normalizedKey === "exitcode"
    ) {
      continue;
    }
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "boolean")
    ) {
      return true;
    }
    if (hasUsableObservationOutput(value, depth + 1, seen)) return true;
  }
  return false;
}

function isExplicitFailureRecord(record: Record<string, unknown>): boolean {
  const status = typeof record.status === "string"
    ? record.status.trim().toLowerCase().replace(/[\s-]+/gu, "_")
    : "";
  if (status && EXPLICIT_FAILURE_STATUS.has(status)) return true;
  if (status && EXPLICIT_NON_TERMINAL_STATUS.has(status)) return true;
  if (record.ok === false || record.success === false || record.passed === false) return true;
  if (record.completed === false || record.done === false || record.finished === false) return true;
  if (typeof record.exitCode === "number" && record.exitCode !== 0) return true;
  if (Object.prototype.hasOwnProperty.call(record, "exitCode") && record.exitCode === null) return true;
  if (typeof record.failedCount === "number" && record.failedCount > 0) return true;
  return hasFailureValue(record.error) || hasFailureValue(record.errors);
}

function hasFailureValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function boundObservationHistory(
  observations: readonly AgentReActObservation[],
): AgentReActObservation[] {
  let totalChars = 2;
  const retained: AgentReActObservation[] = [];
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (!observation) continue;
    const size = observationBudgetSize(observation);
    const separatorChars = retained.length > 0 ? 1 : 0;
    if (
      retained.length > 0 &&
      totalChars + separatorChars + size > MAX_REACT_OBSERVATION_TOTAL_CHARS
    ) {
      break;
    }
    retained.unshift(observation);
    totalChars += separatorChars + size;
  }
  return retained;
}

function observationBudgetSize(observation: AgentReActObservation): number {
  try {
    return JSON.stringify(observation)?.length ?? 0;
  } catch {
    return MAX_REACT_OBSERVATION_TOTAL_CHARS;
  }
}

function writeBoundedObservationContext(
  context: SharedTaskContext,
  stepId: string,
  observations: readonly AgentReActObservation[],
): void {
  const retainedIterations = new Set(
    boundObservationHistory(observations).map((observation) => observation.iteration),
  );
  for (const observation of observations) {
    context.set(
      `react:${stepId}:${observation.iteration}`,
      retainedIterations.has(observation.iteration)
        ? observation
        : {
            iteration: observation.iteration,
            toolName: observation.toolName,
            status: observation.status,
            output: "[observation omitted by total budget]",
          },
    );
  }
}

interface BoundedObservationOutput {
  value: unknown;
  truncated: boolean;
}

function boundObservationOutput(output: unknown): BoundedObservationOutput {
  if (typeof output === "string") {
    const sanitized = sanitizeObservationText(output);
    return sanitized.length <= MAX_REACT_OBSERVATION_CHARS
      ? { value: sanitized, truncated: false }
      : {
          value: `${sanitized.slice(0, MAX_REACT_OBSERVATION_CHARS)}\n[observation truncated]`,
          truncated: true,
        };
  }
  try {
    const original = JSON.stringify(output);
    const serialized = JSON.stringify(output, (key, value: unknown) => {
      if (key && isSensitiveFieldName(key)) return "[redacted:secret]";
      return typeof value === "string" ? sanitizeObservationText(value) : value;
    });
    if (serialized === undefined) {
      return { value: undefined, truncated: false };
    }
    if (serialized.length > MAX_REACT_OBSERVATION_CHARS) {
      return {
        value: `${serialized.slice(0, MAX_REACT_OBSERVATION_CHARS)}\n[observation truncated]`,
        truncated: true,
      };
    }
    if (serialized === original) {
      return { value: output, truncated: false };
    }
    try {
      return { value: JSON.parse(serialized), truncated: false };
    } catch {
      return { value: serialized, truncated: false };
    }
  } catch {
    // A value that cannot be serialized is not auditable evidence. Do not
    // coerce it to a string, because that could let a completion decision
    // pass on an opaque placeholder such as "[object Object]".
    return { value: undefined, truncated: false };
  }
}

/** Apply the same bounded/redacted representation used in ReAct observations. */
export function sanitizeAgentReActOutput(output: unknown): unknown {
  return boundObservationOutput(output).value;
}

function sanitizeObservationText(value: string): string {
  return redactSensitiveText(
    value.replace(IMAGE_DATA_URL_PATTERN, "[redacted:image data URL]"),
  );
}

function boundObservationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeObservationText(message);
  return sanitized.length <= MAX_REACT_OBSERVATION_ERROR_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_REACT_OBSERVATION_ERROR_CHARS)}...[truncated]`;
}

function assertAgentOwnsStep(agent: Agent, stepAgentKind: AgentKind): void {
  if (agent.kind !== stepAgentKind) {
    throw new Error(`Agent ${agent.kind} cannot execute step assigned to ${stepAgentKind}.`);
  }
}
