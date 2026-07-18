import { describe, expect, it } from "vitest";
import { createWorkflowRegistry } from "./workflow-registry";
import type { WorkbenchWorkflow } from "./workflows";

function workflow(id: string, title: string): WorkbenchWorkflow {
  return {
    id: id as WorkbenchWorkflow["id"],
    title,
    triggerExamples: [],
    goal: title,
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander"],
    steps: [],
    currentSupport: "partial",
    safetyNotes: [],
  };
}

describe("createWorkflowRegistry", () => {
  it("rejects duplicate registrations without replacing the original workflow", () => {
    const original = workflow("read-current-project", "Original");
    const registry = createWorkflowRegistry([original]);

    expect(() => registry.register(workflow("read-current-project", "Replacement")))
      .toThrow(/already registered and cannot be shadowed/);
    expect(registry.get("read-current-project")).toBe(original);
  });
});
