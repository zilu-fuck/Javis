/**
 * Resume, retry and rollback planning (E7).
 *
 * A long run that fails at step 6 of 9 should not be restarted from scratch, and a
 * user who watched steps 1–5 succeed should be able to say "go back and redo that one".
 * Both need the same computation, and the part that is easy to get wrong is not the
 * *selection* of steps — it is the **context invalidation** that must accompany it.
 *
 * If step 3 re-runs and its output key stays in the restored context, step 7 reads a
 * value from a run that no longer describes the current attempt. Worse, it reads it
 * silently: the artifact is present and schema-valid, just stale. So every re-run step
 * with an `outputContextKey` contributes that key to `invalidatedContextKeys`, and the
 * caller is expected to *drop* those keys rather than trust them.
 *
 * The module is pure: it plans, it does not execute, checkpoint or restore.
 */

export type ResumeMode = "resume" | "retry_failed" | "rollback";

/** The minimal step shape this needs, so it works on a workflow or a checkpoint snapshot. */
export interface ResumeStep {
  id: string;
  dependsOn?: readonly string[];
  inputContextKeys?: readonly string[];
  outputContextKey?: string;
}

export interface ResumeCheckpointState {
  completedStepIds: readonly string[];
  abandonedStepIds?: readonly string[];
  pendingStepIds?: readonly string[];
  runningStepIds?: readonly string[];
  /** Context keys present in the checkpoint. */
  contextKeys?: readonly string[];
}

export interface ResumePlanInput {
  steps: readonly ResumeStep[];
  checkpoint: ResumeCheckpointState;
  /** Required for `rollback`; the step to redo. */
  rollbackToStepId?: string;
  /** Defaults to `resume`, or `rollback` when `rollbackToStepId` is given. */
  mode?: ResumeMode;
}

export interface ResumePlan {
  mode: ResumeMode;
  /** Steps to execute, in dependency order. */
  stepsToRun: string[];
  /** Steps taken from the checkpoint as-is. */
  skippedStepIds: string[];
  /**
   * Context keys that must be **dropped**, because a step that produces them will run
   * again. Keeping them would let a downstream step read a stale artifact.
   */
  invalidatedContextKeys: string[];
  /** Inputs the resumed run needs but cannot obtain. A non-empty list means it will fail. */
  missingInputContextKeys: string[];
  warnings: string[];
  reason: string;
}

export function planResume(input: ResumePlanInput): ResumePlan {
  const { steps, checkpoint } = input;
  const mode: ResumeMode = input.mode
    ?? (input.rollbackToStepId ? "rollback" : "resume");

  const byId = new Map(steps.map((step) => [step.id, step]));
  const completed = new Set(checkpoint.completedStepIds);
  const abandoned = new Set(checkpoint.abandonedStepIds ?? []);
  const pending = new Set(checkpoint.pendingStepIds ?? []);
  const running = new Set(checkpoint.runningStepIds ?? []);
  const warnings: string[] = [];

  // Steps that did not finish, and therefore must run again in any mode.
  const unfinished = new Set<string>();
  for (const id of [...abandoned, ...pending, ...running]) {
    if (byId.has(id)) {
      unfinished.add(id);
    }
  }

  const dirty = new Set<string>(unfinished);

  if (mode === "rollback") {
    const target = input.rollbackToStepId;
    if (!target) {
      return blocked("rollback requires a target step.", steps, completed, warnings);
    }
    if (!byId.has(target)) {
      return blocked(`rollback target "${target}" is not part of this workflow.`, steps, completed, warnings);
    }
    // The target and *everything downstream* are dirty: a downstream step consumed an
    // artifact the re-run may change, so it cannot be reused.
    dirty.add(target);
    for (const dependent of collectDependents(target, steps)) {
      dirty.add(dependent);
    }
    // The target itself is what the user asked to redo, so it is not collateral damage.
    const collateral = [...dirty].filter((id) => id !== target && completed.has(id));
    if (collateral.length > 0) {
      warnings.push(
        `Rolling back invalidates ${collateral.length} already-completed downstream step(s): `
        + `${collateral.sort().join(", ")}.`,
      );
    }
  }

  // `retry_failed` re-runs the unfinished steps and nothing else. `dirty` already holds
  // exactly those, so no further filtering is correct here: a step listed as both
  // completed and abandoned is a retry that failed, and the failure is the newer fact.

  const stepsToRun = topologicalOrder(steps, dirty);
  const stepsToRunSet = new Set(stepsToRun);
  const skippedStepIds = steps
    .filter((step) => !stepsToRunSet.has(step.id))
    .map((step) => step.id);

  // Context invalidation: any key produced by a step that will run again is suspect.
  const invalidatedContextKeys = [...new Set(
    steps
      .filter((step) => stepsToRunSet.has(step.id) && step.outputContextKey)
      .map((step) => step.outputContextKey as string),
  )].sort();

  const invalidated = new Set(invalidatedContextKeys);
  const availableKeys = new Set(
    (checkpoint.contextKeys ?? []).filter((key) => !invalidated.has(key)),
  );
  // Keys produced by the steps we are about to run are not "missing" — they will appear.
  const willBeProduced = new Set(
    steps
      .filter((step) => stepsToRunSet.has(step.id) && step.outputContextKey)
      .map((step) => step.outputContextKey as string),
  );

  const missingInputContextKeys: string[] = [];
  for (const step of steps) {
    if (!stepsToRunSet.has(step.id)) {
      continue;
    }
    for (const key of step.inputContextKeys ?? []) {
      if (availableKeys.has(key) || willBeProduced.has(key)) {
        continue;
      }
      if (!missingInputContextKeys.includes(key)) {
        missingInputContextKeys.push(key);
      }
    }
  }
  if (missingInputContextKeys.length > 0) {
    warnings.push(
      `The resumed run cannot obtain ${missingInputContextKeys.join(", ")}: no producer runs `
      + "and the checkpoint does not hold it. Re-plan rather than resume.",
    );
  }

  const reason = mode === "rollback"
    ? `Rolling back to "${input.rollbackToStepId}" re-runs it and ${stepsToRun.length - 1} downstream step(s).`
    : mode === "retry_failed"
      ? `Retrying ${stepsToRun.length} unfinished step(s) without re-running their consumers.`
      : `Resuming ${stepsToRun.length} unfinished step(s) from the checkpoint.`;

  return {
    mode,
    stepsToRun,
    skippedStepIds,
    invalidatedContextKeys,
    missingInputContextKeys,
    warnings,
    reason,
  };
}

/**
 * Orders `selected` by dependency.
 *
 * Dependencies outside the selection are treated as satisfied (they are either
 * completed or skipped), which is what makes a partial re-run expressible at all.
 * The result is deterministic: a cycle or an unknown dependency degrades to the
 * workflow's own declaration order rather than throwing, because this runs on the
 * recovery path where failing hard is worse than proceeding conservatively.
 */
function topologicalOrder(steps: readonly ResumeStep[], selected: ReadonlySet<string>): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id) || visiting.has(id)) {
      return; // A cycle: stop rather than loop forever.
    }
    visiting.add(id);
    const step = steps.find((candidate) => candidate.id === id);
    for (const dependency of step?.dependsOn ?? []) {
      if (selected.has(dependency)) {
        visit(dependency);
      }
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  // Iterate the declared order so equal-ranked steps come out the same way each time.
  for (const step of steps) {
    if (selected.has(step.id)) {
      visit(step.id);
    }
  }
  return order;
}

/** Every step that transitively depends on `stepId`. */
function collectDependents(stepId: string, steps: readonly ResumeStep[]): string[] {
  const dependents = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of steps) {
      if (dependents.has(step.id) || step.id === stepId) {
        continue;
      }
      const dependsOnDirty = (step.dependsOn ?? []).some(
        (dependency) => dependency === stepId || dependents.has(dependency),
      );
      if (dependsOnDirty) {
        dependents.add(step.id);
        grew = true;
      }
    }
  }
  return [...dependents];
}

function blocked(
  reason: string,
  steps: readonly ResumeStep[],
  completed: ReadonlySet<string>,
  warnings: string[],
): ResumePlan {
  return {
    mode: "rollback",
    stepsToRun: [],
    skippedStepIds: steps.map((step) => step.id).filter((id) => completed.has(id)),
    invalidatedContextKeys: [],
    missingInputContextKeys: [],
    warnings: [...warnings, reason],
    reason,
  };
}
