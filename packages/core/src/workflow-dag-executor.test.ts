import { describe, expect, it } from "vitest";
import { createSharedTaskContext } from "./shared-context";
import { executeWorkflow } from "./workflow-dag-executor";
import type { WorkbenchWorkflow } from "./workflows";

describe("executeWorkflow", () => {
  it("executes ready workflow steps by dependency order and stores outputs in context", async () => {
    const order: string[] = [];
    const workflow = createWorkflow([
      step("scan-files", [], true),
      step("inspect-project", ["scan-files"], true),
      step("analyze-code", ["scan-files", "inspect-project"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep, context) => {
        order.push(workflowStep.id);
        return {
          output: {
            id: workflowStep.id,
            previousScan: context.get("step:scan-files"),
          },
        };
      },
    });

    expect(result.status).toBe("completed");
    expect(order).toEqual(["scan-files", "inspect-project", "analyze-code"]);
    expect(result.completedStepIds).toEqual(["scan-files", "inspect-project", "analyze-code"]);
    expect(result.contextSnapshot["step:analyze-code"]).toEqual({
      id: "analyze-code",
      previousScan: { id: "scan-files" },
    });
  });

  it("runs independent parallel-ready steps in the same batch", async () => {
    const started: string[] = [];
    const workflow = createWorkflow([
      step("scan-files", [], true),
      step("search-docs", [], true),
      step("summarize", ["scan-files", "search-docs"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      onStepStarted: (workflowStep) => started.push(workflowStep.id),
      executeStep: async (workflowStep) => ({ output: workflowStep.id }),
    });

    expect(result.status).toBe("completed");
    expect(started.slice(0, 2).sort()).toEqual(["scan-files", "search-docs"]);
    expect(started[2]).toBe("summarize");
  });

  it("fails before execution when a step depends on a missing step", async () => {
    const workflow = createWorkflow([
      step("summarize", ["missing"], false),
    ]);

    await expect(executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => ({ output: workflowStep.id }),
    })).rejects.toThrow("depends on missing step");
  });

  it("returns failed status when a step execution fails", async () => {
    const failed: string[] = [];
    const context = createSharedTaskContext({ workflowId: "test-workflow" });
    const workflow = createWorkflow([
      step("scan-files", [], true),
      step("analyze-code", ["scan-files"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      context,
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "analyze-code") {
          throw new Error("analysis failed");
        }
        return { output: workflowStep.id };
      },
      onStepFailed: (workflowStep) => failed.push(workflowStep.id),
    });

    expect(result.status).toBe("failed");
    expect(result.completedStepIds).toEqual(["scan-files"]);
    expect(result.failedStepId).toBe("analyze-code");
    expect(result.error).toBe("analysis failed");
    expect(result.contextSnapshot.workflowId).toBe("test-workflow");
    expect(failed).toEqual(["analyze-code"]);
  });
});

function createWorkflow(steps: WorkbenchWorkflow["steps"]): WorkbenchWorkflow {
  return {
    id: "read-current-project",
    title: "Test workflow",
    triggerExamples: [],
    goal: "Test workflow execution",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "file", "shell", "code", "verifier"],
    currentSupport: "partial",
    safetyNotes: [],
    steps,
  };
}

function step(
  id: string,
  dependsOn: string[],
  canRunInParallel: boolean,
): WorkbenchWorkflow["steps"][number] {
  return {
    id,
    title: id,
    agentKind: "file",
    input: "input",
    output: "output",
    permissionLevel: "read",
    dependsOn,
    canRunInParallel,
  };
}
