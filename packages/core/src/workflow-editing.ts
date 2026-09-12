/**
 * Editing a workflow as a graph (C7).
 *
 * A workflow can currently only be produced by the model. Letting a user edit one means
 * every edit is a graph mutation, and the failure mode of a graph editor is not "it
 * refuses" — it is "it accepts, and the breakage appears later as a step that never runs".
 * Deleting a step, for example, is *locally* fine and only leaves a dangling dependency
 * somewhere else.
 *
 * So every operation here returns `consequences` alongside validity: the steps that will
 * be left dangling, the cycle that was created, the references that a rename rewrote. The
 * editor can then show "removing this breaks 2 steps: build, verify" before the user
 * confirms, instead of after the run fails.
 *
 * Operations are pure and never mutate their input, so an editor can hold an undo stack
 * of workflow values without defensive copying.
 */

export interface EditableStep {
  id: string;
  dependsOn: readonly string[];
  agentKind?: string;
  canRunInParallel?: boolean;
  /** Carried through untouched, so this works on the real step type. */
  [key: string]: unknown;
}

export interface EditableWorkflow {
  id?: string;
  steps: EditableStep[];
}

export type WorkflowDiagnosticCode =
  | "NO_STEPS"
  | "DUPLICATE_STEP_ID"
  | "DANGLING_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "CYCLE";

export interface WorkflowDiagnostic {
  severity: "error" | "warning";
  code: WorkflowDiagnosticCode;
  stepId?: string;
  message: string;
}

export interface WorkflowEditResult {
  ok: boolean;
  /** The resulting workflow, or the unchanged input when the edit was rejected. */
  workflow: EditableWorkflow;
  diagnostics: WorkflowDiagnostic[];
  /** What changed beyond the edit itself, for the editor to show before confirming. */
  consequences: string[];
}

/** Structural problems in a workflow, independent of any edit. */
export function validateWorkflowGraph(workflow: EditableWorkflow): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  if (workflow.steps.length === 0) {
    diagnostics.push({ severity: "error", code: "NO_STEPS", message: "a workflow needs at least one step." });
    return diagnostics;
  }

  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (seen.has(step.id)) {
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_STEP_ID",
        stepId: step.id,
        message: `step id "${step.id}" is used more than once.`,
      });
    }
    seen.add(step.id);
  }

  for (const step of workflow.steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) {
        diagnostics.push({
          severity: "error",
          code: "SELF_DEPENDENCY",
          stepId: step.id,
          message: `step "${step.id}" depends on itself.`,
        });
        continue;
      }
      if (!seen.has(dependency)) {
        diagnostics.push({
          severity: "error",
          code: "DANGLING_DEPENDENCY",
          stepId: step.id,
          message: `step "${step.id}" depends on "${dependency}", which does not exist.`,
        });
      }
    }
  }

  for (const cycle of findCycles(workflow)) {
    diagnostics.push({
      severity: "error",
      code: "CYCLE",
      stepId: cycle[0],
      message: `dependency cycle: ${cycle.join(" → ")}.`,
    });
  }

  return diagnostics;
}

/** Every dependency cycle, each reported once as a closed path. */
function findCycles(workflow: EditableWorkflow): string[][] {
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (id: string) => {
    if (state.get(id) === "done") {
      return;
    }
    if (state.get(id) === "visiting") {
      const start = path.indexOf(id);
      if (start >= 0) {
        cycles.push([...path.slice(start), id]);
      }
      return;
    }
    state.set(id, "visiting");
    path.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) {
        visit(dependency);
      }
    }
    path.pop();
    state.set(id, "done");
  };

  for (const step of workflow.steps) {
    visit(step.id);
  }
  return cycles;
}

/** Steps that depend on `stepId`, directly or transitively. */
export function collectDependentSteps(
  workflow: EditableWorkflow,
  stepId: string,
): { direct: string[]; transitive: string[] } {
  const direct = workflow.steps
    .filter((step) => step.dependsOn.includes(stepId))
    .map((step) => step.id);
  const transitive = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of workflow.steps) {
      if (step.id === stepId || transitive.has(step.id)) {
        continue;
      }
      if (step.dependsOn.some((dependency) => dependency === stepId || transitive.has(dependency))) {
        transitive.add(step.id);
        grew = true;
      }
    }
  }
  return { direct: direct.sort(), transitive: [...transitive].sort() };
}

export function addStep(
  workflow: EditableWorkflow,
  step: EditableStep,
  options: { afterStepId?: string } = {},
): WorkflowEditResult {
  if (workflow.steps.some((existing) => existing.id === step.id)) {
    return rejected(workflow, [{
      severity: "error",
      code: "DUPLICATE_STEP_ID",
      stepId: step.id,
      message: `step id "${step.id}" already exists.`,
    }]);
  }
  const consequences: string[] = [];
  const resolved: EditableStep = options.afterStepId
    ? {
        ...step,
        // Declaring "after X" is the editor's way of saying "depends on X".
        dependsOn: [...new Set([...step.dependsOn, options.afterStepId])],
      }
    : { ...step };
  if (options.afterStepId && !step.dependsOn.includes(options.afterStepId)) {
    consequences.push(`"${step.id}" will depend on "${options.afterStepId}".`);
  }

  const next: EditableWorkflow = { ...workflow, steps: [...workflow.steps, resolved] };
  const diagnostics = validateWorkflowGraph(next);
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { ok: false, workflow, diagnostics, consequences }
    : { ok: true, workflow: next, diagnostics, consequences };
}

export function removeStep(workflow: EditableWorkflow, stepId: string): WorkflowEditResult {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    return rejected(workflow, [{
      severity: "error",
      code: "DANGLING_DEPENDENCY",
      stepId,
      message: `step "${stepId}" does not exist.`,
    }]);
  }
  const { direct, transitive } = collectDependentSteps(workflow, stepId);
  const consequences: string[] = [];
  if (direct.length > 0) {
    // The user needs this before confirming: the deletion itself looks harmless.
    consequences.push(
      `removing "${stepId}" leaves ${direct.length} step(s) with a dangling dependency: ${direct.join(", ")}`,
    );
  }
  if (transitive.length > direct.length) {
    consequences.push(
      `${transitive.length - direct.length} further step(s) depend on those: `
      + `${transitive.filter((id) => !direct.includes(id)).join(", ")}`,
    );
  }

  const next: EditableWorkflow = {
    ...workflow,
    steps: workflow.steps
      .filter((candidate) => candidate.id !== stepId)
      .map((candidate) => (candidate.dependsOn.includes(stepId)
        // Drop the now-missing dependency rather than leaving a dangling reference.
        ? { ...candidate, dependsOn: candidate.dependsOn.filter((dependency) => dependency !== stepId) }
        : candidate)),
  };
  const diagnostics = validateWorkflowGraph(next);
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    workflow: next,
    diagnostics,
    consequences,
  };
}

export function updateDependencies(
  workflow: EditableWorkflow,
  stepId: string,
  dependsOn: readonly string[],
): WorkflowEditResult {
  if (!workflow.steps.some((step) => step.id === stepId)) {
    return rejected(workflow, [{
      severity: "error",
      code: "DANGLING_DEPENDENCY",
      stepId,
      message: `step "${stepId}" does not exist.`,
    }]);
  }
  const next: EditableWorkflow = {
    ...workflow,
    steps: workflow.steps.map((step) => (
      step.id === stepId ? { ...step, dependsOn: [...dependsOn] } : step
    )),
  };
  const diagnostics = validateWorkflowGraph(next);
  const consequences = diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    // Rejected edits must not leak a broken graph back to the caller.
    return { ok: false, workflow, diagnostics, consequences };
  }
  return { ok: true, workflow: next, diagnostics, consequences };
}

/** Renames a step and rewrites every reference to it. */
export function renameStepId(workflow: EditableWorkflow, from: string, to: string): WorkflowEditResult {
  if (from === to) {
    return { ok: true, workflow, diagnostics: [], consequences: [] };
  }
  if (!workflow.steps.some((step) => step.id === from)) {
    return rejected(workflow, [{
      severity: "error",
      code: "DANGLING_DEPENDENCY",
      stepId: from,
      message: `step "${from}" does not exist.`,
    }]);
  }
  if (workflow.steps.some((step) => step.id === to)) {
    return rejected(workflow, [{
      severity: "error",
      code: "DUPLICATE_STEP_ID",
      stepId: to,
      message: `step id "${to}" already exists.`,
    }]);
  }
  const referencing = workflow.steps
    .filter((step) => step.id !== from && step.dependsOn.includes(from))
    .map((step) => step.id);
  const next: EditableWorkflow = {
    ...workflow,
    steps: workflow.steps.map((step) => ({
      ...step,
      id: step.id === from ? to : step.id,
      dependsOn: step.dependsOn.map((dependency) => (dependency === from ? to : dependency)),
    })),
  };
  const diagnostics = validateWorkflowGraph(next);
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    workflow: next,
    diagnostics,
    consequences: referencing.length > 0
      ? [`rewrote ${referencing.length} dependency reference(s): ${referencing.join(", ")}`]
      : [],
  };
}

/** Steps that can run first (no dependencies), i.e. the entry points. */
export function findEntrySteps(workflow: EditableWorkflow): string[] {
  return workflow.steps.filter((step) => step.dependsOn.length === 0).map((step) => step.id);
}

/** A dependency-ordered step list, or `undefined` when no valid order exists. */
export function topologicalStepOrder(workflow: EditableWorkflow): string[] | undefined {
  if (validateWorkflowGraph(workflow).some((diagnostic) => diagnostic.severity === "error")) {
    return undefined;
  }
  const order: string[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress && order.length < workflow.steps.length) {
    progress = false;
    for (const step of workflow.steps) {
      if (done.has(step.id) || !step.dependsOn.every((dependency) => done.has(dependency))) {
        continue;
      }
      order.push(step.id);
      done.add(step.id);
      progress = true;
    }
  }
  return order.length === workflow.steps.length ? order : undefined;
}

function rejected(workflow: EditableWorkflow, diagnostics: WorkflowDiagnostic[]): WorkflowEditResult {
  return {
    ok: false,
    workflow,
    diagnostics,
    consequences: diagnostics.map((diagnostic) => diagnostic.message),
  };
}
