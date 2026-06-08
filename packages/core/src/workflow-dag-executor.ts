import type { SharedTaskContext } from "./shared-context";
import { createSharedTaskContext } from "./shared-context";
import { DEFAULT_TASK_TIMEOUT_MS, throwIfTaskAborted, withTaskTimeout } from "./task-wait";
import type { WorkbenchWorkflow, WorkbenchWorkflowStep } from "./workflows";

export interface WorkflowStepExecutionResult {
  output: unknown;
}

export interface WorkflowExecutionResult {
  status: "completed" | "failed";
  completedStepIds: string[];
  abandonedStepIds?: string[];
  replannedStepIds?: string[];
  failedStepId?: string;
  error?: string;
  results: Map<string, unknown>;
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

export interface WorkflowExecutorOptions {
  workflow: WorkbenchWorkflow;
  context?: SharedTaskContext;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  executeStep(
    step: WorkbenchWorkflowStep,
    context: SharedTaskContext,
  ): Promise<WorkflowStepExecutionResult>;
  onStepStarted?(step: WorkbenchWorkflowStep, context: SharedTaskContext): void;
  onStepCompleted?(
    step: WorkbenchWorkflowStep,
    output: unknown,
    context: SharedTaskContext,
  ): void;
  onStepFailed?(
    step: WorkbenchWorkflowStep,
    error: string,
    context: SharedTaskContext,
  ): void;
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
}

export async function executeWorkflow({
  workflow,
  context = createSharedTaskContext(),
  signal,
  stepTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  executeStep,
  onStepStarted,
  onStepCompleted,
  onStepFailed,
  onStepFailureReplan,
  onStepReplanned,
  onStepHeartbeat,
  onStepTimeout,
}: WorkflowExecutorOptions): Promise<WorkflowExecutionResult> {
  const activeWorkflow: WorkbenchWorkflow = {
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })),
  };
  validateWorkflowDag(activeWorkflow);

  const completed = new Set<string>();
  const abandoned = new Set<string>();
  const runningOrFinished = new Set<string>();
  const results = new Map<string, unknown>();
  const replannedStepIds: string[] = [];

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
      const parallelResult = await executeReadySteps(
        parallelSteps,
        activeWorkflow,
        context,
        completed,
        abandoned,
        runningOrFinished,
        results,
        replannedStepIds,
        executeStep,
        signal,
        stepTimeoutMs,
        onStepStarted,
        onStepCompleted,
        onStepFailed,
        onStepFailureReplan,
        onStepReplanned,
        onStepHeartbeat,
        onStepTimeout,
      );
      if (parallelResult) {
        return parallelResult;
      }
    }

    for (const step of serialSteps) {
      const serialResult = await executeReadySteps(
        [step],
        activeWorkflow,
        context,
        completed,
        abandoned,
        runningOrFinished,
        results,
        replannedStepIds,
        executeStep,
        signal,
        stepTimeoutMs,
        onStepStarted,
        onStepCompleted,
        onStepFailed,
        onStepFailureReplan,
        onStepReplanned,
        onStepHeartbeat,
        onStepTimeout,
      );
      if (serialResult) {
        return serialResult;
      }
    }
  }

  return {
    status: "completed",
    completedStepIds: [...completed],
    abandonedStepIds: abandoned.size > 0 ? [...abandoned] : undefined,
    replannedStepIds: replannedStepIds.length > 0 ? replannedStepIds : undefined,
    results,
    contextSnapshot: context.snapshot(),
  };
}

function validateWorkflowDag(workflow: WorkbenchWorkflow): void {
  const ids = new Set(workflow.steps.map((step) => step.id));
  for (const step of workflow.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Workflow step ${step.id} depends on missing step ${dependency}.`);
      }
    }
  }
}

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
  stepTimeoutMs: number,
  onStepStarted: WorkflowExecutorOptions["onStepStarted"],
  onStepCompleted: WorkflowExecutorOptions["onStepCompleted"],
  onStepFailed: WorkflowExecutorOptions["onStepFailed"],
  onStepFailureReplan: WorkflowExecutorOptions["onStepFailureReplan"],
  onStepReplanned: WorkflowExecutorOptions["onStepReplanned"],
  onStepHeartbeat: WorkflowExecutorOptions["onStepHeartbeat"],
  onStepTimeout: WorkflowExecutorOptions["onStepTimeout"],
): Promise<WorkflowExecutionResult | undefined> {
  const stepExecutions = steps.map((step) =>
    executeTrackedStep(
      step,
      context,
      runningOrFinished,
      executeStep,
      signal,
      stepTimeoutMs,
      onStepStarted,
      onStepHeartbeat,
      onStepTimeout,
    ),
  );

  const failures: Array<{ step: WorkbenchWorkflowStep; error: string }> = [];
  const pending = new Set(stepExecutions);
  while (pending.size > 0) {
    throwIfTaskAborted(signal, "Workflow step batch");
    const item = await Promise.race(pending);
    pending.delete(item.execution);
    if (item.status === "rejected") {
      const error = item.reason instanceof Error ? item.reason.message : String(item.reason);
      failures.push({ step: item.step, error });
      continue;
    }

    const { step, result } = item;
    results.set(step.id, result.output);
    context.set(`step:${step.id}`, result.output);
    completed.add(step.id);
    onStepCompleted?.(step, result.output, context);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      onStepFailed?.(failure.step, failure.error, context);
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
        abandoned.add(failure.step.id);
        context.set(`step:${failure.step.id}:abandoned`, {
          error: failure.error,
          recoveredAt: new Date().toISOString(),
        });
        if (replanAction.steps?.length) {
          try {
            appendReplannedSteps(activeWorkflow, replanAction.steps);
            replannedStepIds.push(...replanAction.steps.map((step) => step.id));
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
  stepTimeoutMs: number,
  onStepStarted: WorkflowExecutorOptions["onStepStarted"],
  onStepHeartbeat: WorkflowExecutorOptions["onStepHeartbeat"],
  onStepTimeout: WorkflowExecutorOptions["onStepTimeout"],
): TrackedStepExecution {
  runningOrFinished.add(step.id);
  const startedAt = Date.now();
  onStepStarted?.(step, context);
  const heartbeat = setInterval(() => {
    onStepHeartbeat?.(step, Date.now() - startedAt, context);
  }, Math.max(Math.min(stepTimeoutMs / 3, 15_000), 1_000));

  let execution: TrackedStepExecution;
  execution = withTaskTimeout(
    () => executeStep(step, context),
    {
      label: `workflow step ${step.id}`,
      timeoutMs: stepTimeoutMs,
      signal,
      onTimeout: () => onStepTimeout?.(step, stepTimeoutMs, context),
    },
  ).then(
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

function appendReplannedSteps(
  workflow: WorkbenchWorkflow,
  replannedSteps: WorkbenchWorkflowStep[],
): void {
  const ids = new Set(workflow.steps.map((step) => step.id));
  for (const step of replannedSteps) {
    if (ids.has(step.id)) {
      throw new Error(`Replanned workflow step duplicates existing step ${step.id}.`);
    }
    workflow.steps.push({ ...step, dependsOn: [...step.dependsOn] });
    ids.add(step.id);
  }
  validateWorkflowDag(workflow);
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
    contextSnapshot: context.snapshot(),
  };
}
