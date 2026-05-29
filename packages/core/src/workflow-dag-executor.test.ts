import { describe, expect, it } from "vitest";
import { createSharedTaskContext } from "./shared-context";
import { executeWorkflow } from "./workflow-dag-executor";
import type { AgentCapabilityTag } from "./agent-capability";
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

  it("runs the read-current-project DAG: 3 parallel → barrier → final", async () => {
    const started: string[] = [];
    const completedOrder: string[] = [];
    const workflow = createWorkflow([
      step("scan-files", [], true),
      step("inspect-project", [], true),
      step("analyze-code", [], true),
      step("summarize-project", ["scan-files", "inspect-project", "analyze-code"], false),
      step("commander-synthesize", ["summarize-project"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      onStepStarted: (workflowStep) => started.push(workflowStep.id),
      executeStep: async (workflowStep, context) => {
        if (workflowStep.id === "summarize-project") {
          // Verify all three parallel outputs are in context
          const scan = context.get("step:scan-files");
          const inspect = context.get("step:inspect-project");
          const code = context.get("step:analyze-code");
          expect(scan).toBeDefined();
          expect(inspect).toBeDefined();
          expect(code).toBeDefined();
        }
        completedOrder.push(workflowStep.id);
        return { output: { stepId: workflowStep.id } };
      },
    });

    expect(result.status).toBe("completed");
    // The three parallel steps must all start before summarize-project
    expect(started.slice(0, 3).sort()).toEqual(["analyze-code", "inspect-project", "scan-files"]);
    expect(started[3]).toBe("summarize-project");
    expect(started[4]).toBe("commander-synthesize");
    // All five steps completed
    expect(result.completedStepIds).toHaveLength(5);
    // Context stores outputs for all steps
    expect(result.contextSnapshot["step:scan-files"]).toEqual({ stepId: "scan-files" });
    expect(result.contextSnapshot["step:summarize-project"]).toEqual({ stepId: "summarize-project" });
    expect(result.contextSnapshot["step:commander-synthesize"]).toEqual({ stepId: "commander-synthesize" });
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

describe("capability-based dispatch", () => {
  it("executes step with requiredCapabilities field", async () => {
    const dispatched: string[] = [];
    const requiredCapabilities: AgentCapabilityTag[] = ["file_scan"];
    const workflow = createWorkflow([
      {
        ...step("scan", [], false),
        requiredCapabilities,
      },
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (s) => {
        dispatched.push(s.id);
        expect(s.requiredCapabilities).toEqual(["file_scan"]);
        return { output: s.id };
      },
    });

    expect(result.status).toBe("completed");
    expect(dispatched).toEqual(["scan"]);
  });

  it("step without requiredCapabilities still executes (backward compat)", async () => {
    const workflow = createWorkflow([
      step("legacy-step", [], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (s) => {
        expect(s.requiredCapabilities).toBeUndefined();
        return { output: s.id };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.completedStepIds).toEqual(["legacy-step"]);
  });

  it("step with unrecognized requiredCapabilities still executes via fallback", async () => {
    const requiredCapabilities = ["nonexistent_tag"] as unknown as AgentCapabilityTag[];
    const workflow = createWorkflow([
      {
        ...step("unknown-cap", [], false),
        requiredCapabilities,
      },
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (s) => {
        // Callback receives the step regardless — fallback happens in caller
        expect(s.requiredCapabilities).toEqual(["nonexistent_tag"]);
        return { output: s.id };
      },
    });

    expect(result.status).toBe("completed");
  });
});
