import type { SharedTaskContext } from "./shared-context";
import {
  createSharedTaskContext,
  formatStepInputValidationError,
  validateContextValue,
  validateStepInputContext,
  writeStepOutput,
} from "./shared-context";
import {
  isArtifactEnvelope,
  validateArtifactEnvelope,
  type ArtifactEnvelopeExpectation,
} from "./artifact-envelope";
import {
  DEFAULT_TASK_TIMEOUT_MS,
  TaskTimeoutError,
  throwIfTaskAborted,
  withTaskTimeout,
} from "./task-wait";
import {
  createWriteLeaseRegistry,
  extractDeclaredWritePaths,
} from "./write-lease";
import type { WorkbenchWorkflow, WorkbenchWorkflowStep } from "./workflows";
import {
  createFailedStepResult,
  isTerminalStepResultStatus,
  normalizeStepResult,
  normalizeStepContract,
  type StepResult,
  type StepResultInput,
} from "./step-protocol";

export interface WorkflowStepExecutionResult {
  output?: unknown;
  status?: StepResultInput["status"];
  evidence?: StepResultInput["evidence"];
  assumptions?: string[];
  unresolvedQuestions?: string[];
  unmetCriteria?: string[];
  requestedContextKeys?: string[];
  requestedAgentKind?: string;
  blockedReason?: StepResultInput["blockedReason"];
  error?: string;
  errorDetail?: StepResultInput["errorDetail"];
}

export interface WorkflowExecutionResult {
  status: "completed" | "failed";
  completedStepIds: string[];
  abandonedStepIds?: string[];
  replannedStepIds?: string[];
  failedStepId?: string;
  error?: string;
  results: Map<string, unknown>;
  stepResults: Record<string, StepResult>;
  contextSnapshot: Record<string, unknown>;
}

export interface WorkflowStepFailureReplanAction {
  /**
   * Treat the failed step as satisfied for dependency purposes and continue
   * with degraded evidence. Defaults to false.
   */
  abandonFailedStep?: boolean;
  /** Additional recovery steps to append to the running workflow. */
  steps?: WorkbenchWorkflowStep[];
}

export interface WorkflowResumeState {
  completedStepIds?: string[];
  abandonedStepIds?: string[];
  retryStepIds?: string[];
  contextSnapshot?: Record<string, unknown>;
  results?: Record<string, unknown>;
  stepResults?: Record<string, StepResultInput>;
}

export interface WorkflowExecutionPolicy {
  maxConcurrency: number;
  stepTimeoutMs: number;
  maxStepRetries: number;
  retryBackoffMs: number;
  rateLimitPerSecond: number;
  maxReadyQueueSize: number;
  circuitBreakerFailureThreshold: number;
}

interface WorkflowSchedulerState {
  nextStartAt: number;
  consecutiveFailures: number;
}

export interface WorkflowExecutorOptions {
  workflow: WorkbenchWorkflow;
  context?: SharedTaskContext;
  resumeFrom?: WorkflowResumeState;
  /**
   * Optional identity binding for artifacts restored from a durable snapshot.
   * Generic workflows may omit this, but Commander supplies task/run identity
   * so a checkpoint from another execution cannot enter the live context.
   */
  artifactExpectation?: ArtifactEnvelopeExpectation;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  maxStepRetries?: number;
  executionPolicy?: Partial<WorkflowExecutionPolicy>;
  getExecutionPolicy?(): Partial<WorkflowExecutionPolicy> | undefined;
  shouldRetryStep?(request: {
    step: WorkbenchWorkflowStep;
    error: string;
    attempt: number;
    context: SharedTaskContext;
  }): boolean;
  executeStep(
    step: WorkbenchWorkflowStep,
    context: SharedTaskContext,
    signal?: AbortSignal,
  ): Promise<WorkflowStepExecutionResult>;
  onStepStarted?(step: WorkbenchWorkflowStep, context: SharedTaskContext): void;
  onStepCompleted?(
    step: WorkbenchWorkflowStep,
    output: unknown,
    context: SharedTaskContext,
    result?: StepResult,
  ): void;
  onStepFailed?(
    step: WorkbenchWorkflowStep,
    error: string,
    context: SharedTaskContext,
    result?: StepResult,
  ): void;
  /**
   * Called when a step returns `blocked` under `completionPolicy.blocked ===
   * "wait"` (with a wake condition) or `needs_clarification` under
   * `needsClarification === "ask_user"`. The scheduler pauses the step
   * (without failing it) until the returned promise resolves, then retries
   * the step. Resolving without the condition being satisfied is the
   * caller's responsibility (dual-kernel plan §7.2 scheduler matrix).
   */
  onStepWaiting?(
    step: WorkbenchWorkflowStep,
    result: StepResult,
    context: SharedTaskContext,
  ): Promise<void> | void;
  onStepFailureReplan?(request: {
    step: WorkbenchWorkflowStep;
    error: string;
    workflow: WorkbenchWorkflow;
    context: SharedTaskContext;
    completedStepIds: string[];
  }): Promise<WorkflowStepFailureReplanAction | undefined> | WorkflowStepFailureReplanAction | undefined;
  onStepReplanned?(
    step: WorkbenchWorkflowStep,
    error: string,
    action: WorkflowStepFailureReplanAction,
    context: SharedTaskContext,
  ): void;
  onStepHeartbeat?(step: WorkbenchWorkflowStep, elapsedMs: number, context: SharedTaskContext): void;
  onStepTimeout?(step: WorkbenchWorkflowStep, timeoutMs: number, context: SharedTaskContext): void;
  onStepRetry?(
    step: WorkbenchWorkflowStep,
    error: string,
    attempt: number,
    context: SharedTaskContext,
  ): void;
  onBackpressure?(request: {
    readyCount: number;
    admittedCount: number;
    policy: WorkflowExecutionPolicy;
  }): void;
  onCircuitBreakerOpen?(request: {
    step: WorkbenchWorkflowStep;
    error: string;
    consecutiveFailures: number;
    policy: WorkflowExecutionPolicy;
  }): void;
}

export async function executeWorkflow({
  workflow,
  context = createSharedTaskContext(),
  resumeFrom,
  artifactExpectation,
  signal,
  stepTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  maxStepRetries = 1,
  executionPolicy,
  getExecutionPolicy,
  shouldRetryStep = defaultShouldRetryStep,
  executeStep,
  onStepStarted,
  onStepCompleted,
  onStepFailed,
  onStepFailureReplan,
  onStepReplanned,
  onStepHeartbeat,
  onStepTimeout,
  onStepRetry,
  onStepWaiting,
  onBackpressure,
  onCircuitBreakerOpen,
}: WorkflowExecutorOptions): Promise<WorkflowExecutionResult> {
  const activeWorkflow: WorkbenchWorkflow = {
    ...workflow,
    steps: workflow.steps.map((step) => ({
      ...step,
      ...normalizeStepContract({
        title: step.title,
        instruction: step.instruction ?? step.input,
        hardConstraints: step.hardConstraints,
        preferences: step.preferences,
        acceptanceCriteria: step.acceptanceCriteria,
        outputSchemaRef: step.outputSchemaRef ?? step.outputContextKey,
        primaryCapability: step.primaryCapability,
        artifactObligation: step.artifactObligation,
        completionPolicy: step.completionPolicy,
        outputContextKey: step.outputContextKey,
        successCriteria: step.successCriteria ?? step.output,
      }),
      dependsOn: [...step.dependsOn],
    })),
  };
  validateWorkflowDag(activeWorkflow);

  hydrateContextFromSnapshot(context, resumeFrom?.contextSnapshot, artifactExpectation);
  const resumeStepIds = validateResumeStepIds(resumeFrom, activeWorkflow);
  const normalizedResumeStepResults = normalizeResumeStepResults(
    readRestoredStepResults(resumeFrom?.stepResults, context, activeWorkflow),
    activeWorkflow,
  );
  clearRestoredStepResults(context);
  if (normalizedResumeStepResults) {
    context.set("stepResults", normalizedResumeStepResults);
    for (const [stepId, result] of Object.entries(normalizedResumeStepResults)) {
      context.set(`stepResult:${stepId}`, result);
    }
  }
  const completed = new Set(resumeStepIds.completed);
  const abandoned = new Set(resumeStepIds.abandoned);
  const retry = new Set(resumeStepIds.retry);
  const runningOrFinished = new Set<string>();
  for (const stepId of completed) {
    runningOrFinished.add(stepId);
  }
  for (const stepId of abandoned) {
    runningOrFinished.add(stepId);
  }
  for (const stepId of retry) {
    runningOrFinished.delete(stepId);
  }
  const results = createResultMap(resumeFrom, completed, context);
  const replannedStepIds: string[] = [];
  const schedulerState: WorkflowSchedulerState = {
    nextStartAt: 0,
    consecutiveFailures: 0,
  };
  let lastSerialStepId: string | undefined;
  const resolveExecutionPolicy = () => normalizeWorkflowExecutionPolicy(
    {
      ...executionPolicy,
      ...getExecutionPolicy?.(),
    },
    stepTimeoutMs,
    maxStepRetries,
  );

  while (completed.size + abandoned.size < activeWorkflow.steps.length) {
    throwIfTaskAborted(signal, `Workflow ${activeWorkflow.id}`);
    const ready = activeWorkflow.steps.filter(
      (step) =>
        !runningOrFinished.has(step.id) &&
        step.dependsOn.every((dependency) => completed.has(dependency) || abandoned.has(dependency)),
    );

    if (ready.length === 0) {
      return failedResult({
        completed,
        abandoned,
        replannedStepIds,
        context,
        results,
        error: "Workflow deadlock: no ready steps but workflow is incomplete.",
      });
    }

    const parallelSteps = ready.filter((step) => step.canRunInParallel);
    const serialSteps = ready.filter((step) => !step.canRunInParallel);

    if (parallelSteps.length > 0) {
      const policy = resolveExecutionPolicy();
      const admittedParallelSteps = parallelSteps.slice(0, policy.maxReadyQueueSize);
      if (admittedParallelSteps.length < parallelSteps.length) {
        onBackpressure?.({
          readyCount: parallelSteps.length,
          admittedCount: admittedParallelSteps.length,
          policy,
        });
      }
      const parallelResult = await executeReadySteps(
        admittedParallelSteps,
        activeWorkflow,
        context,
        completed,
        abandoned,
        runningOrFinished,
        results,
        replannedStepIds,
        executeStep,
        signal,
        resolveExecutionPolicy,
        schedulerState,
        shouldRetryStep,
        onStepStarted,
        onStepCompleted,
        onStepFailed,
        onStepFailureReplan,
        onStepReplanned,
        onStepHeartbeat,
        onStepTimeout,
        onStepRetry,
        onStepWaiting,
        onCircuitBreakerOpen,
      );
      if (parallelResult) {
        return parallelResult;
      }
      if (admittedParallelSteps.length < parallelSteps.length) {
        continue;
      }
    }

    const preferredSerialDependency = lastSerialStepId;
    const nextSerialStep = preferredSerialDependency
      ? serialSteps.find((step) => step.dependsOn.includes(preferredSerialDependency)) ?? serialSteps[0]
      : serialSteps[0];
    if (nextSerialStep) {
      const serialResult = await executeReadySteps(
        [nextSerialStep],
        activeWorkflow,
        context,
        completed,
        abandoned,
        runningOrFinished,
        results,
        replannedStepIds,
        executeStep,
        signal,
        resolveExecutionPolicy,
        schedulerState,
        shouldRetryStep,
        onStepStarted,
        onStepCompleted,
        onStepFailed,
        onStepFailureReplan,
        onStepReplanned,
        onStepHeartbeat,
        onStepTimeout,
        onStepRetry,
        onStepWaiting,
        onCircuitBreakerOpen,
      );
      if (serialResult) {
        return serialResult;
      }
      lastSerialStepId = nextSerialStep.id;
    }
  }

  return {
    status: "completed",
    completedStepIds: [...completed],
    abandonedStepIds: abandoned.size > 0 ? [...abandoned] : undefined,
    replannedStepIds: replannedStepIds.length > 0 ? replannedStepIds : undefined,
    results,
    stepResults: readStepResults(context),
    contextSnapshot: context.snapshot(),
  };
}

export function normalizeWorkflowExecutionPolicy(
  policy: Partial<WorkflowExecutionPolicy> | undefined,
  fallbackStepTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  fallbackMaxStepRetries = 1,
): WorkflowExecutionPolicy {
  const maxConcurrency = clampPolicyInteger(policy?.maxConcurrency, 1, 8, 4);
  return {
    maxConcurrency,
    stepTimeoutMs: clampPolicyInteger(
      policy?.stepTimeoutMs,
      10,
      300_000,
      fallbackStepTimeoutMs,
    ),
    maxStepRetries: clampPolicyInteger(
      policy?.maxStepRetries,
      0,
      3,
      fallbackMaxStepRetries,
    ),
    retryBackoffMs: clampPolicyInteger(policy?.retryBackoffMs, 0, 30_000, 0),
    rateLimitPerSecond: clampPolicyNumber(policy?.rateLimitPerSecond, 0, 20, 0),
    maxReadyQueueSize: Math.max(
      maxConcurrency,
      clampPolicyInteger(policy?.maxReadyQueueSize, 1, 24, Math.max(8, maxConcurrency)),
    ),
    circuitBreakerFailureThreshold: clampPolicyInteger(
      policy?.circuitBreakerFailureThreshold,
      1,
      8,
      8,
    ),
  };
}

function clampPolicyInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampPolicyNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function hydrateContextFromSnapshot(
  context: SharedTaskContext,
  snapshot: Record<string, unknown> | undefined,
  artifactExpectation?: ArtifactEnvelopeExpectation,
): void {
  if (!snapshot) {
    return;
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (isArtifactEnvelope(value)) {
      if (!artifactExpectation) {
        throw new Error(
          `Refusing to hydrate artifact envelope for context key "${key}" without task/run identity binding.`,
        );
      }
      if (!validateArtifactEnvelope(value, artifactExpectation)) {
        throw new Error(`Refusing to hydrate invalid artifact envelope for context key "${key}".`);
      }
      context.setEnvelope(key, value);
      continue;
    }
    // Do not silently downgrade a partially-shaped envelope to an ordinary
    // context value. That would bypass hash/provenance checks on resume.
    if (looksLikeArtifactEnvelope(value)) {
      throw new Error(`Refusing to hydrate malformed artifact envelope for context key "${key}".`);
    }
    context.set(key, value);
  }
}

function looksLikeArtifactEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "artifactId" in record || "contentHash" in record || "hashAlgorithm" in record;
}

function validateResumeStepIds(
  resumeFrom: WorkflowResumeState | undefined,
  workflow: WorkbenchWorkflow,
): { completed: string[]; abandoned: string[]; retry: string[] } {
  const knownStepIds = new Set(workflow.steps.map((step) => step.id));
  const seen = new Map<string, string>();
  const groups = {
    completed: resumeFrom?.completedStepIds ?? [],
    abandoned: resumeFrom?.abandonedStepIds ?? [],
    retry: resumeFrom?.retryStepIds ?? [],
  };
  for (const [state, stepIds] of Object.entries(groups)) {
    const withinState = new Set<string>();
    for (const stepId of stepIds) {
      if (!knownStepIds.has(stepId)) {
        throw new Error(`Workflow resume ${state} state references unknown step ${stepId}.`);
      }
      if (withinState.has(stepId)) {
        throw new Error(`Workflow resume ${state} state contains duplicate step ${stepId}.`);
      }
      withinState.add(stepId);
      const previous = seen.get(stepId);
      if (previous) {
        throw new Error(`Workflow resume step ${stepId} appears in both ${previous} and ${state} state.`);
      }
      seen.set(stepId, state);
    }
  }
  return groups;
}

function normalizeResumeStepResults(
  stepResults: unknown,
  workflow: WorkbenchWorkflow,
): Record<string, StepResult> | undefined {
  if (stepResults === undefined) return undefined;
  if (!stepResults || typeof stepResults !== "object" || Array.isArray(stepResults)) {
    throw new Error("Workflow resume stepResults is malformed.");
  }
  const knownStepIds = new Set(workflow.steps.map((step) => step.id));
  const normalized: Record<string, StepResult> = {};
  for (const [stepId, rawResult] of Object.entries(stepResults)) {
    if (!knownStepIds.has(stepId)) {
      throw new Error(`Workflow resume stepResults references unknown step ${stepId}.`);
    }
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
      throw new Error(`Workflow resume stepResults for ${stepId} is malformed.`);
    }
    const result = normalizeStepResult(rawResult);
    normalized[stepId] = result.output === undefined || result.evidence.length > 0
      ? result
      : {
          ...result,
          evidence: [{
            kind: "artifact",
            label: `Step ${stepId} output`,
            reference: workflow.steps.find((step) => step.id === stepId)?.outputContextKey ??
              `step:${stepId}`,
          }],
        };
  }
  return normalized;
}

function readRestoredStepResults(
  explicitStepResults: WorkflowResumeState["stepResults"],
  context: SharedTaskContext,
  workflow: WorkbenchWorkflow,
): unknown {
  const snapshot = context.snapshot();
  const knownStepIds = new Set(workflow.steps.map((step) => step.id));
  const individualResults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.startsWith("stepResult:")) continue;
    const stepId = key.slice("stepResult:".length);
    if (!knownStepIds.has(stepId)) {
      throw new Error(`Workflow resume stepResults references unknown step ${stepId}.`);
    }
    individualResults[stepId] = value;
  }
  return explicitStepResults ?? snapshot.stepResults ??
    (Object.keys(individualResults).length > 0 ? individualResults : undefined);
}

function clearRestoredStepResults(context: SharedTaskContext): void {
  for (const key of Object.keys(context.snapshot())) {
    if (key === "stepResults" || key.startsWith("stepResult:")) {
      context.delete(key);
    }
  }
}

function createResultMap(
  resumeFrom: WorkflowResumeState | undefined,
  completed: Set<string>,
  context: SharedTaskContext,
): Map<string, unknown> {
  const results = new Map<string, unknown>();
  if (resumeFrom?.results) {
    for (const [stepId, value] of Object.entries(resumeFrom.results)) {
      if (completed.has(stepId)) {
        results.set(stepId, value);
      }
    }
  }
  for (const stepId of completed) {
    if (!results.has(stepId)) {
      const value = context.get(`step:${stepId}`);
      if (value !== undefined) {
        results.set(stepId, value);
      }
    }
  }
  return results;
}

export function assertValidWorkflowDag(
  steps: ReadonlyArray<Pick<WorkbenchWorkflowStep, "id" | "dependsOn">>,
): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new Error(`Workflow contains duplicate step id ${step.id}.`);
    }
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Workflow step ${step.id} depends on missing step ${dependency}.`);
      }
    }
  }

  const visitState = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (stepId: string): void => {
    const state = visitState.get(stepId);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = path.indexOf(stepId);
      const cycle = [...path.slice(cycleStart), stepId];
      throw new Error(`Workflow contains cyclic dependency: ${cycle.join(" -> ")}.`);
    }
    visitState.set(stepId, "visiting");
    path.push(stepId);
    for (const dependency of byId.get(stepId)?.dependsOn ?? []) {
      visit(dependency);
    }
    path.pop();
    visitState.set(stepId, "visited");
  };

  for (const step of steps) {
    visit(step.id);
  }
}

function validateWorkflowDag(workflow: WorkbenchWorkflow): void {
  assertValidWorkflowDag(workflow.steps);
}

/**
 * D4: process-wide write leases.
 *
 * Deliberately process-wide rather than per-workflow: two concurrent workflow runs
 * writing the same path is exactly the conflict this exists to catch, and leases
 * are released on step settle so nothing accumulates.
 */
const writeLeaseRegistry = createWriteLeaseRegistry();

async function executeReadySteps(
  steps: WorkbenchWorkflowStep[],
  activeWorkflow: WorkbenchWorkflow,
  context: SharedTaskContext,
  completed: Set<string>,
  abandoned: Set<string>,
  runningOrFinished: Set<string>,
  results: Map<string, unknown>,
  replannedStepIds: string[],
  executeStep: WorkflowExecutorOptions["executeStep"],
  signal: AbortSignal | undefined,
  resolveExecutionPolicy: () => WorkflowExecutionPolicy,
  schedulerState: WorkflowSchedulerState,
  shouldRetryStep: NonNullable<WorkflowExecutorOptions["shouldRetryStep"]>,
  onStepStarted: WorkflowExecutorOptions["onStepStarted"],
  onStepCompleted: WorkflowExecutorOptions["onStepCompleted"],
  onStepFailed: WorkflowExecutorOptions["onStepFailed"],
  onStepFailureReplan: WorkflowExecutorOptions["onStepFailureReplan"],
  onStepReplanned: WorkflowExecutorOptions["onStepReplanned"],
  onStepHeartbeat: WorkflowExecutorOptions["onStepHeartbeat"],
  onStepTimeout: WorkflowExecutorOptions["onStepTimeout"],
  onStepRetry: WorkflowExecutorOptions["onStepRetry"],
  onStepWaiting: WorkflowExecutorOptions["onStepWaiting"],
  onCircuitBreakerOpen: WorkflowExecutorOptions["onCircuitBreakerOpen"],
): Promise<WorkflowExecutionResult | undefined> {
  const queue = [...steps];
  const failures: Array<{ step: WorkbenchWorkflowStep; error: string; result: StepResult }> = [];
  const pending = new Set<TrackedStepExecution>();
  let circuitOpen = false;
  const recordFailure = (
    step: WorkbenchWorkflowStep,
    error: string,
    result = createFailedStepResult(error),
  ) => {
    recordStepResult(context, step.id, result);
    failures.push({ step, error, result });
    schedulerState.consecutiveFailures += 1;
    const policy = resolveExecutionPolicy();
    if (
      !circuitOpen &&
      schedulerState.consecutiveFailures >= policy.circuitBreakerFailureThreshold
    ) {
      circuitOpen = true;
      onCircuitBreakerOpen?.({
        step,
        error,
        consecutiveFailures: schedulerState.consecutiveFailures,
        policy,
      });
    }
  };

  /**
   * D4: a step that declares a write path claims it before dispatch, so two
   * parallel steps cannot write the same file (or a path inside the same
   * directory). The lease is released when the step settles, expires on its TTL if
   * the step is killed, and is scoped per workflow run so two different runs
   * writing the same path still conflict.
   */
  const leaseScopeId = `wf:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  // Forward every argument: `executeStep` also receives the attempt's abort signal,
  // and dropping it broke per-step timeout cancellation.
  const leasedExecuteStep: WorkflowExecutorOptions["executeStep"] = async (...args) => {
    const step = args[0];
    const declared = (step as { declaredWritePaths?: string[] }).declaredWritePaths;
    const paths = declared && declared.length > 0
      ? declared
      : extractDeclaredWritePaths((step as { toolInput?: Record<string, unknown> }).toolInput);
    if (paths.length === 0) {
      return executeStep(...args);
    }
    const acquired = writeLeaseRegistry.acquire({
      taskId: leaseScopeId,
      stepId: step.id,
      paths,
    });
    if (!acquired.ok) {
      const holder = acquired.conflicts[0];
      throw new Error(
        `Step ${step.id} cannot write ${holder.path}: it is claimed by step `
        + `${holder.heldBy.stepId}. Parallel writers must target different paths.`,
      );
    }
    try {
      return await executeStep(...args);
    } finally {
      writeLeaseRegistry.release(acquired.lease.leaseId);
    }
  };

  while (queue.length > 0 || pending.size > 0) {
    throwIfTaskAborted(signal, "Workflow step batch");
    while (queue.length > 0 && !circuitOpen) {
      const policy = resolveExecutionPolicy();
      if (pending.size >= policy.maxConcurrency) break;
      await waitForRateLimit(policy, schedulerState, signal);
      const nextStep = queue.shift();
      if (!nextStep) break;
      pending.add(executeTrackedStep(
        nextStep,
        context,
        runningOrFinished,
        leasedExecuteStep,
        signal,
        resolveExecutionPolicy,
        shouldRetryStep,
        onStepStarted,
        onStepHeartbeat,
        onStepTimeout,
        onStepRetry,
      ));
    }
    if (pending.size === 0) break;
    const item = await Promise.race(pending);
    pending.delete(item.execution);
    if (item.status === "rejected") {
      const error = item.reason instanceof Error ? item.reason.message : String(item.reason);
      clearFailedStepContext(item.step, context, results);
      recordFailure(item.step, error);
      continue;
    }

    const { step, result } = item;
    const normalizedStepResult = normalizeStepResult(result);
    const stepResult: StepResult = normalizedStepResult.evidence.length > 0 || normalizedStepResult.output === undefined
      ? normalizedStepResult
      : {
          ...normalizedStepResult,
          evidence: [{
            kind: "artifact",
            label: `Step ${step.id} output`,
            reference: step.outputContextKey ?? `step:${step.id}`,
          }],
        };
    recordStepResult(context, step.id, stepResult);
    if (stepResult.status === "partial" &&
        step.completionPolicy?.partial !== "publish_and_continue") {
      const policy = step.completionPolicy?.partial ?? "stop";
      recordFailure(
        step,
        stepResult.error ?? `Step ${step.id} returned partial output under ${policy} policy.`,
        stepResult,
      );
      continue;
    }
    if (stepResult.status === "blocked" &&
        step.completionPolicy?.blocked === "wait" &&
        stepResult.blockedReason?.wakeCondition &&
        onStepWaiting) {
      // Pause the step until the wake condition resolves, then retry it.
      // No failure is recorded; the step stays out of completed/abandoned.
      recordStepResult(context, step.id, stepResult);
      await onStepWaiting(step, stepResult, context);
      queue.unshift(step);
      continue;
    }
    if (stepResult.status === "needs_clarification" &&
        step.completionPolicy?.needsClarification === "ask_user" &&
        onStepWaiting) {
      recordStepResult(context, step.id, stepResult);
      await onStepWaiting(step, stepResult, context);
      queue.unshift(step);
      continue;
    }
    if (isTerminalStepResultStatus(stepResult.status)) {
      recordFailure(
        step,
        stepResult.error ?? `Step ${step.id} returned status ${stepResult.status}.`,
        stepResult,
      );
      continue;
    }
    results.set(step.id, stepResult.output);
    context.set(`step:${step.id}`, stepResult.output);
    writeStepOutput(step.outputContextKey, stepResult.output, context);
    const handoffFailure = validateCompletedStepHandoffs({
      step,
      workflow: activeWorkflow,
      context,
      completed,
      abandoned,
    });
    if (handoffFailure) {
      if (handoffFailure.step.id !== step.id) {
        completed.add(step.id);
        onStepCompleted?.(step, stepResult.output, context, stepResult);
      } else {
        clearFailedStepContext(step, context, results);
      }
      recordFailure(
        handoffFailure.step,
        handoffFailure.error,
        handoffFailure.step.id === step.id
          ? { ...stepResult, status: "failed", error: handoffFailure.error }
          : undefined,
      );
      continue;
    }
    completed.add(step.id);
    if (!circuitOpen) schedulerState.consecutiveFailures = 0;
    onStepCompleted?.(step, stepResult.output, context, stepResult);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      onStepFailed?.(failure.step, failure.error, context, failure.result);
      const replanAction = await onStepFailureReplan?.({
        step: failure.step,
        error: failure.error,
        workflow: activeWorkflow,
        context,
        completedStepIds: [...completed],
      });

      if (replanAction && (replanAction.abandonFailedStep || replanAction.steps?.length)) {
        if (!replanAction.abandonFailedStep) {
          return failedResult({
            completed,
            abandoned,
            replannedStepIds,
            context,
            results,
            failedStepId: failure.step.id,
            error: `Workflow replan for ${failure.step.id} must abandon the failed step before adding recovery steps.`,
          });
        }
        if (replanAction.steps?.length) {
          try {
            const appendedStepIds = appendReplannedSteps(
              activeWorkflow,
              replanAction.steps,
              failure.step.id,
            );
            replannedStepIds.push(...appendedStepIds);
          } catch (error) {
            return failedResult({
              completed,
              abandoned,
              replannedStepIds,
              context,
              results,
              failedStepId: failure.step.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        // Only mark the failed step abandoned after the recovery plan has
        // been validated and appended. A duplicate/invalid recovery plan must
        // leave the failed step failed, never silently convert it to success.
        abandoned.add(failure.step.id);
        schedulerState.consecutiveFailures = 0;
        context.set(`step:${failure.step.id}:abandoned`, {
          error: failure.error,
          recoveredAt: new Date().toISOString(),
        });
        onStepReplanned?.(failure.step, failure.error, replanAction, context);
        continue;
      }

      return failedResult({
        completed,
        abandoned,
        replannedStepIds,
        context,
        results,
        failedStepId: failure.step.id,
        error: failure.error,
      });
    }

    return undefined;
  }

  return undefined;
}

async function waitForRateLimit(
  policy: WorkflowExecutionPolicy,
  state: WorkflowSchedulerState,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (policy.rateLimitPerSecond <= 0) return;
  const intervalMs = Math.ceil(1_000 / policy.rateLimitPerSecond);
  const waitMs = Math.max(0, state.nextStartAt - Date.now());
  if (waitMs > 0) {
    await waitForSchedulerDelay(waitMs, signal);
  }
  state.nextStartAt = Math.max(Date.now(), state.nextStartAt) + intervalMs;
}

type TrackedStepExecution = Promise<TrackedStepSettlement>;

type TrackedStepSettlement =
  | {
      execution: TrackedStepExecution;
      status: "fulfilled";
      step: WorkbenchWorkflowStep;
      result: WorkflowStepExecutionResult;
    }
  | {
      execution: TrackedStepExecution;
      status: "rejected";
      step: WorkbenchWorkflowStep;
      reason: unknown;
    };

function executeTrackedStep(
  step: WorkbenchWorkflowStep,
  context: SharedTaskContext,
  runningOrFinished: Set<string>,
  executeStep: WorkflowExecutorOptions["executeStep"],
  signal: AbortSignal | undefined,
  resolveExecutionPolicy: () => WorkflowExecutionPolicy,
  shouldRetryStep: NonNullable<WorkflowExecutorOptions["shouldRetryStep"]>,
  onStepStarted: WorkflowExecutorOptions["onStepStarted"],
  onStepHeartbeat: WorkflowExecutorOptions["onStepHeartbeat"],
  onStepTimeout: WorkflowExecutorOptions["onStepTimeout"],
  onStepRetry: WorkflowExecutorOptions["onStepRetry"],
): TrackedStepExecution {
  runningOrFinished.add(step.id);
  const startedAt = Date.now();
  const initialPolicy = resolveExecutionPolicy();
  const heartbeat = setInterval(() => {
    onStepHeartbeat?.(step, Date.now() - startedAt, context);
  }, Math.max(Math.min(initialPolicy.stepTimeoutMs / 3, 15_000), 1_000));

  let execution: TrackedStepExecution;
  execution = executeStepWithRetry({
    step,
    context,
    executeStep,
    signal,
    resolveExecutionPolicy,
    shouldRetryStep,
    onStepStarted,
    onStepTimeout,
    onStepRetry,
  }).then(
    (result) => ({
      execution,
      status: "fulfilled" as const,
      step,
      result,
    }),
    (reason) => ({
      execution,
      status: "rejected" as const,
      step,
      reason,
    }),
  ).finally(() => {
    clearInterval(heartbeat);
  }) as TrackedStepExecution;

  return execution;
}

async function executeStepWithRetry({
  step,
  context,
  executeStep,
  signal,
  resolveExecutionPolicy,
  shouldRetryStep,
  onStepStarted,
  onStepTimeout,
  onStepRetry,
}: {
  step: WorkbenchWorkflowStep;
  context: SharedTaskContext;
  executeStep: WorkflowExecutorOptions["executeStep"];
  signal: AbortSignal | undefined;
  resolveExecutionPolicy: () => WorkflowExecutionPolicy;
  shouldRetryStep: NonNullable<WorkflowExecutorOptions["shouldRetryStep"]>;
  onStepStarted: WorkflowExecutorOptions["onStepStarted"];
  onStepTimeout: WorkflowExecutorOptions["onStepTimeout"];
  onStepRetry: WorkflowExecutorOptions["onStepRetry"];
}): Promise<WorkflowStepExecutionResult> {
  for (let attempt = 0; ; attempt += 1) {
    const policy = resolveExecutionPolicy();
    clearStepAttemptContext(step, context);
    onStepStarted?.(step, context);
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(signal?.reason);
    signal?.addEventListener("abort", abortAttempt, { once: true });
    try {
      const inputValidation = validateStepInputContext(step, context);
      if (!inputValidation.valid) {
        throw new Error(formatStepInputValidationError(inputValidation));
      }
      const runStep = () => executeStep(step, context, attemptController.signal);
      return step.executionTimeoutMode === "approval_managed"
        ? await runStep()
        : await withTaskTimeout(
            runStep,
            {
              label: attempt === 0 ? `workflow step ${step.id}` : `workflow step ${step.id} retry ${attempt}`,
              timeoutMs: policy.stepTimeoutMs,
              signal,
              onTimeout: () => {
                attemptController.abort(new TaskTimeoutError(`workflow step ${step.id}`, policy.stepTimeoutMs));
                onStepTimeout?.(step, policy.stepTimeoutMs, context);
              },
            },
          );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        step.executionTimeoutMode === "approval_managed" ||
        attempt >= policy.maxStepRetries ||
        !shouldRetryStep({ step, error: errorMessage, attempt, context })
      ) {
        throw error;
      }
      onStepRetry?.(step, errorMessage, attempt + 1, context);
      const backoffMs = Math.min(policy.retryBackoffMs * (2 ** attempt), 30_000);
      if (backoffMs > 0) {
        await waitForSchedulerDelay(backoffMs, signal);
      }
    } finally {
      signal?.removeEventListener("abort", abortAttempt);
    }
  }
}

async function waitForSchedulerDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfTaskAborted(signal, "Workflow scheduler wait");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error("Workflow scheduler wait cancelled."));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateCompletedStepHandoffs({
  step,
  workflow,
  context,
  completed,
  abandoned,
}: {
  step: WorkbenchWorkflowStep;
  workflow: WorkbenchWorkflow;
  context: SharedTaskContext;
  completed: Set<string>;
  abandoned: Set<string>;
}): { step: WorkbenchWorkflowStep; error: string } | undefined {
  if (step.outputContextKey) {
    const schemaKey = step.outputSchemaRef ?? step.outputContextKey;
    const outputValidation = validateContextValue(schemaKey, context.get(step.outputContextKey));
    if (!outputValidation.valid) {
      return {
        step,
        error: `Handoff validation failed after step ${step.id}: output context key ${step.outputContextKey}` +
          `${outputValidation.expectedType ? ` expected ${outputValidation.expectedType}` : ""}.`,
      };
    }
  }

  const completedWithStep = new Set([...completed, step.id]);
  const readyConsumers = workflow.steps.filter((candidate) =>
    candidate.id !== step.id &&
    (candidate.inputContextKeys?.length ?? 0) > 0 &&
    candidate.dependsOn.every((dependency) => completedWithStep.has(dependency) || abandoned.has(dependency)) &&
    (step.outputContextKey
      ? candidate.inputContextKeys?.includes(step.outputContextKey)
      : candidate.dependsOn.includes(step.id))
  );

  for (const consumer of readyConsumers) {
    const inputValidation = validateStepInputContext(consumer, context);
    if (!inputValidation.valid) {
      return {
        step: consumer,
        error: `Handoff validation failed after step ${step.id}: ${formatStepInputValidationError(inputValidation)}`,
      };
    }
  }

  return undefined;
}

function clearFailedStepContext(
  step: WorkbenchWorkflowStep,
  context: SharedTaskContext,
  results: Map<string, unknown>,
): void {
  results.delete(step.id);
  clearStepAttemptContext(step, context);
}

function clearStepAttemptContext(
  step: WorkbenchWorkflowStep,
  context: SharedTaskContext,
): void {
  const ownedKeys = new Set<string>([`step:${step.id}`]);
  if (step.outputContextKey) ownedKeys.add(step.outputContextKey);
  const reactPrefix = `react:${step.id}:`;
  for (const key of Object.keys(context.snapshot())) {
    if (key.startsWith(reactPrefix)) ownedKeys.add(key);
  }
  for (const key of ownedKeys) context.delete(key);
  removeStepResult(context, step.id);
}

function recordStepResult(context: SharedTaskContext, stepId: string, result: StepResult): void {
  context.set(`stepResult:${stepId}`, result);
  const existing = context.get<Record<string, StepResult>>("stepResults") ?? {};
  context.set("stepResults", { ...existing, [stepId]: result });
}

function removeStepResult(context: SharedTaskContext, stepId: string): void {
  context.delete(`stepResult:${stepId}`);
  const existing = context.get<Record<string, StepResult>>("stepResults");
  if (!existing || !(stepId in existing)) return;
  const next = { ...existing };
  delete next[stepId];
  context.set("stepResults", next);
}

function readStepResults(context: SharedTaskContext): Record<string, StepResult> {
  const value = context.get<Record<string, StepResult>>("stepResults");
  return value && typeof value === "object" ? value : {};
}

function defaultShouldRetryStep(request: {
  error: string;
}): boolean {
  return isTransientWorkflowStepError(request.error);
}

function isTransientWorkflowStepError(error: string): boolean {
  const normalized = error.toLowerCase();
  if (
    /permission|approval|denied|forbidden|unauthorized|disabled|not available|missing|verification failed|invalid schema|outside .*allowed/i
      .test(normalized)
  ) {
    return false;
  }
  return /timed out|timeout|temporar|network|econnreset|etimedout|eai_again|rate limit|429|502|503|504|service unavailable|provider unavailable|model unavailable|fetch failed/i
    .test(normalized);
}

export function appendReplannedSteps(
  workflow: WorkbenchWorkflow,
  replannedSteps: WorkbenchWorkflowStep[],
  failedStepId: string,
): string[] {
  const ids = new Set(workflow.steps.map((step) => step.id));
  const requestedIds = new Set<string>();
  const duplicateIds: string[] = [];
  for (const step of replannedSteps) {
    if (ids.has(step.id) || requestedIds.has(step.id)) {
      duplicateIds.push(step.id);
    }
    requestedIds.add(step.id);
  }
  if (duplicateIds.length > 0) {
    throw new Error(
      `Recovery plan contains duplicate or existing step id(s): ${[...new Set(duplicateIds)].join(", ")}.`,
    );
  }

  const appendedStepIds: string[] = [];
  const nextSteps = [
    ...workflow.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })),
    ...replannedSteps.map((step) => {
      appendedStepIds.push(step.id);
      return { ...step, dependsOn: [...step.dependsOn] };
    }),
  ];
  const appendedSteps = nextSteps.filter((step) => appendedStepIds.includes(step.id));
  for (const recoveryStep of appendedSteps) {
    if (!recoveryStep.outputContextKey) continue;
    for (const consumer of nextSteps) {
      if (
        appendedStepIds.includes(consumer.id) ||
        !consumer.dependsOn.includes(failedStepId) ||
        !consumer.inputContextKeys?.includes(recoveryStep.outputContextKey) ||
        consumer.dependsOn.includes(recoveryStep.id)
      ) {
        continue;
      }
      consumer.dependsOn.push(recoveryStep.id);
    }
  }
  const candidateWorkflow: WorkbenchWorkflow = {
    ...workflow,
    steps: nextSteps,
  };
  validateWorkflowDag(candidateWorkflow);
  workflow.steps.splice(0, workflow.steps.length, ...nextSteps);
  return appendedStepIds;
}

function failedResult({
  completed,
  abandoned,
  replannedStepIds,
  context,
  results,
  failedStepId,
  error,
}: {
  completed: Set<string>;
  abandoned: Set<string>;
  replannedStepIds: string[];
  context: SharedTaskContext;
  results: Map<string, unknown>;
  failedStepId?: string;
  error: string;
}): WorkflowExecutionResult {
  return {
    status: "failed",
    completedStepIds: [...completed],
    abandonedStepIds: abandoned.size > 0 ? [...abandoned] : undefined,
    replannedStepIds: replannedStepIds.length > 0 ? replannedStepIds : undefined,
    failedStepId,
    error,
    results,
    stepResults: readStepResults(context),
    contextSnapshot: context.snapshot(),
  };
}
