import { describe, expect, it } from "vitest";
import {
  addStep,
  collectDependentSteps,
  findEntrySteps,
  removeStep,
  renameStepId,
  topologicalStepOrder,
  updateDependencies,
  validateWorkflowGraph,
  type EditableWorkflow,
} from "./workflow-editing";

/**
 * scan ──► inspect ──► analyse ──► write-report
 *                └──► capture ────┘
 */
function workflow(): EditableWorkflow {
  return {
    id: "review",
    steps: [
      { id: "scan", dependsOn: [] },
      { id: "inspect", dependsOn: ["scan"] },
      { id: "analyse", dependsOn: ["inspect"] },
      { id: "capture", dependsOn: ["inspect"] },
      { id: "write-report", dependsOn: ["analyse", "capture"] },
    ],
  };
}

describe("validateWorkflowGraph", () => {
  it("accepts a valid graph", () => {
    expect(validateWorkflowGraph(workflow())).toEqual([]);
  });

  it("rejects an empty workflow", () => {
    expect(validateWorkflowGraph({ steps: [] })[0].code).toBe("NO_STEPS");
  });

  it("detects duplicate ids, self-dependency and dangling references", () => {
    const codes = validateWorkflowGraph({
      steps: [
        { id: "a", dependsOn: [] },
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["b"] },
        { id: "c", dependsOn: ["ghost"] },
      ],
    }).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("DUPLICATE_STEP_ID");
    expect(codes).toContain("SELF_DEPENDENCY");
    expect(codes).toContain("DANGLING_DEPENDENCY");
  });

  it("detects a direct and an indirect cycle, reporting the path", () => {
    const direct = validateWorkflowGraph({
      steps: [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }],
    });
    expect(direct[0].code).toBe("CYCLE");
    expect(direct[0].message).toContain("→");

    const indirect = validateWorkflowGraph({
      steps: [
        { id: "a", dependsOn: ["c"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ],
    });
    expect(indirect.filter((diagnostic) => diagnostic.code === "CYCLE")).toHaveLength(1);
  });

  it("accepts a diamond, which is not a cycle", () => {
    expect(validateWorkflowGraph(workflow()).filter((d) => d.code === "CYCLE")).toEqual([]);
  });
});

describe("addStep", () => {
  it("appends a step and reports the wiring it added", () => {
    const result = addStep(workflow(), { id: "publish", dependsOn: [] }, { afterStepId: "write-report" });
    expect(result.ok).toBe(true);
    expect(result.workflow.steps).toHaveLength(6);
    expect(result.workflow.steps.find((step) => step.id === "publish")?.dependsOn).toEqual(["write-report"]);
    expect(result.consequences[0]).toContain('will depend on "write-report"');
  });

  it("rejects a duplicate id and returns the original workflow", () => {
    const original = workflow();
    const result = addStep(original, { id: "scan", dependsOn: [] });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe("DUPLICATE_STEP_ID");
    expect(result.workflow).toBe(original);
  });

  it("does not mutate the input workflow", () => {
    const original = workflow();
    addStep(original, { id: "publish", dependsOn: [] }, { afterStepId: "scan" });
    expect(original.steps).toHaveLength(5);
  });
});

describe("removeStep", () => {
  it("names the steps left dangling, before the user confirms", () => {
    const result = removeStep(workflow(), "inspect");
    // `inspect` is deleted, so `analyse` and `capture` lose a dependency, and
    // `write-report` depends on those — the user should see all of it up front.
    expect(result.consequences[0]).toContain("leaves 2 step(s) with a dangling dependency");
    expect(result.consequences[0]).toContain("analyse");
    expect(result.consequences[1]).toContain("write-report");
  });

  it("drops the references so the result stays valid", () => {
    const result = removeStep(workflow(), "analyse");
    expect(result.ok).toBe(true);
    expect(result.workflow.steps.find((step) => step.id === "write-report")?.dependsOn).toEqual(["capture"]);
    expect(validateWorkflowGraph(result.workflow)).toEqual([]);
  });

  it("removes a leaf without consequences", () => {
    const result = removeStep(workflow(), "write-report");
    expect(result.ok).toBe(true);
    expect(result.consequences).toEqual([]);
  });

  it("rejects an unknown step", () => {
    expect(removeStep(workflow(), "nope").ok).toBe(false);
  });

  it("does not mutate the input workflow", () => {
    const original = workflow();
    removeStep(original, "inspect");
    expect(original.steps.find((step) => step.id === "analyse")?.dependsOn).toEqual(["inspect"]);
  });
});

describe("updateDependencies", () => {
  it("applies a legal change", () => {
    const result = updateDependencies(workflow(), "capture", ["scan"]);
    expect(result.ok).toBe(true);
    expect(result.workflow.steps.find((step) => step.id === "capture")?.dependsOn).toEqual(["scan"]);
  });

  it("rejects a change that would create a cycle and keeps the graph intact", () => {
    const original = workflow();
    const result = updateDependencies(original, "scan", ["write-report"]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "CYCLE")).toBe(true);
    // A rejected edit must not leak a broken graph.
    expect(result.workflow).toBe(original);
    expect(validateWorkflowGraph(result.workflow)).toEqual([]);
  });

  it("rejects a dangling dependency", () => {
    const result = updateDependencies(workflow(), "capture", ["ghost"]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "DANGLING_DEPENDENCY")).toBe(true);
  });

  it("rejects an unknown step", () => {
    expect(updateDependencies(workflow(), "nope", []).ok).toBe(false);
  });
});

describe("renameStepId", () => {
  it("rewrites every reference and says how many", () => {
    const result = renameStepId(workflow(), "inspect", "inspect-workspace");
    expect(result.ok).toBe(true);
    expect(result.workflow.steps.some((step) => step.id === "inspect-workspace")).toBe(true);
    expect(result.workflow.steps.find((step) => step.id === "analyse")?.dependsOn)
      .toEqual(["inspect-workspace"]);
    expect(result.consequences[0]).toContain("rewrote 2 dependency reference(s)");
    expect(validateWorkflowGraph(result.workflow)).toEqual([]);
  });

  it("is a no-op when the name is unchanged", () => {
    const original = workflow();
    const result = renameStepId(original, "scan", "scan");
    expect(result.workflow).toBe(original);
    expect(result.consequences).toEqual([]);
  });

  it("rejects a rename onto an existing id and a missing source", () => {
    expect(renameStepId(workflow(), "scan", "inspect").diagnostics[0].code).toBe("DUPLICATE_STEP_ID");
    expect(renameStepId(workflow(), "nope", "x").ok).toBe(false);
  });

  it("does not mutate the input", () => {
    const original = workflow();
    renameStepId(original, "scan", "scan-v2");
    expect(original.steps[0].id).toBe("scan");
  });
});

describe("graph helpers", () => {
  it("collects direct and transitive dependents", () => {
    const dependents = collectDependentSteps(workflow(), "inspect");
    expect(dependents.direct).toEqual(["analyse", "capture"]);
    expect(dependents.transitive).toEqual(["analyse", "capture", "write-report"]);
  });

  it("finds the entry steps", () => {
    expect(findEntrySteps(workflow())).toEqual(["scan"]);
  });

  it("orders steps by dependency", () => {
    const order = topologicalStepOrder(workflow());
    expect(order?.[0]).toBe("scan");
    expect(order?.indexOf("inspect")).toBeLessThan(order?.indexOf("analyse") ?? -1);
    expect(order?.indexOf("analyse")).toBeLessThan(order?.indexOf("write-report") ?? -1);
    expect(order?.indexOf("capture")).toBeLessThan(order?.indexOf("write-report") ?? -1);
  });

  it("returns no order for an invalid graph rather than a partial one", () => {
    expect(topologicalStepOrder({ steps: [{ id: "a", dependsOn: ["a"] }] })).toBeUndefined();
  });
});

describe("edits compose without accumulating damage", () => {
  it("survives a delete/rename/re-add sequence", () => {
    let current = workflow();
    current = removeStep(current, "capture").workflow;
    current = renameStepId(current, "analyse", "analysis").workflow;
    const added = addStep(current, { id: "capture-ui", dependsOn: [] }, { afterStepId: "inspect" });
    expect(added.ok).toBe(true);
    expect(validateWorkflowGraph(added.workflow)).toEqual([]);
    expect(topologicalStepOrder(added.workflow)).toHaveLength(5);
  });
});
