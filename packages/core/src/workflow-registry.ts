import type { WorkbenchWorkflow } from "./workflows";

export interface WorkflowRegistry {
  /** Register a workflow. Duplicate ids are rejected until explicitly unregistered. */
  register(workflow: WorkbenchWorkflow): void;
  /** Remove a workflow by id. No-op if not found. */
  unregister(id: string): void;
  /** Get a workflow by id. */
  get(id: string): WorkbenchWorkflow | undefined;
  /** List all registered workflows. */
  list(): ReadonlyArray<WorkbenchWorkflow>;
}

export function createWorkflowRegistry(initial?: WorkbenchWorkflow[]): WorkflowRegistry {
  const workflows = new Map<string, WorkbenchWorkflow>();
  for (const w of initial ?? []) {
    if (workflows.has(w.id)) {
      throw new Error(`Workflow ${w.id} is already registered and cannot be shadowed.`);
    }
    workflows.set(w.id, w);
  }

  return {
    register(workflow) {
      if (workflows.has(workflow.id)) {
        throw new Error(`Workflow ${workflow.id} is already registered and cannot be shadowed.`);
      }
      workflows.set(workflow.id, workflow);
    },

    unregister(id) {
      workflows.delete(id);
    },

    get(id) {
      return workflows.get(id);
    },

    list() {
      return [...workflows.values()];
    },
  };
}
