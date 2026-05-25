import type { SharedTaskContext } from "./shared-context";
import { createSharedTaskContext } from "./shared-context";
import type { WorkbenchWorkflow, WorkbenchWorkflowStep } from "./workflows";

export interface WorkflowStepExecutionResult {
  output: unknown;
}

export interface WorkflowExecutionResult {
  status: "completed" | "failed";
  completedStepIds: string[];
  failedStepId?: string;
  error?: string;
  results: Map<string, unknown>;
  contextSnapshot: Record<string, unknown>;
}

export interface WorkflowExecutorOptions {
  workflow: WorkbenchWorkflow;
  context?: SharedTaskContext;
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
}

export async function executeWorkflow({
  workflow,
  context = createSharedTaskContext(),
  executeStep,
  onStepStarted,
  onStepCompleted,
  onStepFailed,
}: WorkflowExecutorOptions): Promise<WorkflowExecutionResult> {
  validateWorkflowDag(workflow);

  const completed = new Set<string>();
  const runningOrFinished = new Set<string>();
  const results = new Map<string, unknown>();

  while (completed.size < workflow.steps.length) {
    const ready = workflow.steps.filter(
      (step) =>
        !runningOrFinished.has(step.id) &&
        step.dependsOn.every((dependency) => completed.has(dependency)),
    );

    if (ready.length === 0) {
      return failedResult({
        completed,
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
        context,
        completed,
        runningOrFinished,
        results,
        executeStep,
        onStepStarted,
        onStepCompleted,
        onStepFailed,
      );
      if (parallelResult) {
        return parallelResult;
      }
    }

    for (const step of serialSteps) {
      const serialResult = await executeReadySteps(
        [step],
        context,
        completed,
        runningOrFinished,
        results,
        executeStep,
        onStepStarted,
        onStepCompleted,
        onStepFailed,
      );
      if (serialResult) {
        return serialResult;
      }
    }
  }

  return {
    status: "completed",
    completedStepIds: [...completed],
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
  context: SharedTaskContext,
  completed: Set<string>,
  runningOrFinished: Set<string>,
  results: Map<string, unknown>,
  executeStep: WorkflowExecutorOptions["executeStep"],
  onStepStarted: WorkflowExecutorOptions["onStepStarted"],
  onStepCompleted: WorkflowExecutorOptions["onStepCompleted"],
  onStepFailed: WorkflowExecutorOptions["onStepFailed"],
): Promise<WorkflowExecutionResult | undefined> {
  for (const step of steps) {
    runningOrFinished.add(step.id);
    onStepStarted?.(step, context);
  }

  const settled = await Promise.allSettled(
    steps.map(async (step) => ({
      step,
      result: await executeStep(step, context),
    })),
  );

  let firstFailure: { step?: WorkbenchWorkflowStep; error: string } | undefined;
  for (let index = 0; index < settled.length; index += 1) {
    const item = settled[index];
    if (item.status === "rejected") {
      const step = steps[index];
      const error = item.reason instanceof Error ? item.reason.message : String(item.reason);
      firstFailure ??= { step, error };
      continue;
    }

    const { step, result } = item.value;
    results.set(step.id, result.output);
    context.set(`step:${step.id}`, result.output);
    completed.add(step.id);
    onStepCompleted?.(step, result.output, context);
  }

  if (firstFailure) {
    if (firstFailure.step) {
      onStepFailed?.(firstFailure.step, firstFailure.error, context);
    }
    return failedResult({
      completed,
      context,
      results,
      failedStepId: firstFailure.step?.id,
      error: firstFailure.error,
    });
  }

  return undefined;
}

function failedResult({
  completed,
  context,
  results,
  failedStepId,
  error,
}: {
  completed: Set<string>;
  context: SharedTaskContext;
  results: Map<string, unknown>;
  failedStepId?: string;
  error: string;
}): WorkflowExecutionResult {
  return {
    status: "failed",
    completedStepIds: [...completed],
    failedStepId,
    error,
    results,
    contextSnapshot: context.snapshot(),
  };
}
