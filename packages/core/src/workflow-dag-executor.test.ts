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

  it("can abandon a failed step and continue dependent work with degraded evidence", async () => {
    const started: string[] = [];
    const replanned: string[] = [];
    const workflow = createWorkflow([
      step("scan-files", [], false),
      step("summarize", ["scan-files"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      maxStepRetries: 0,
      onStepStarted: (workflowStep) => started.push(workflowStep.id),
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "scan-files") {
          throw new Error("scan timed out");
        }
        return { output: workflowStep.id };
      },
      onStepFailureReplan: ({ step: failedStep }) => {
        replanned.push(failedStep.id);
        return { abandonFailedStep: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(started).toEqual(["scan-files", "summarize"]);
    expect(result.completedStepIds).toEqual(["summarize"]);
    expect(result.abandonedStepIds).toEqual(["scan-files"]);
    expect(result.contextSnapshot["step:scan-files:abandoned"]).toMatchObject({
      error: "scan timed out",
    });
    expect(replanned).toEqual(["scan-files"]);
  });

  it("retries transient step failures once before marking the step completed", async () => {
    let attempts = 0;
    const retries: string[] = [];
    const workflow = createWorkflow([
      step("fetch-source", [], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("network timeout");
        }
        return { output: workflowStep.id };
      },
      onStepRetry: (workflowStep, error, attempt) => {
        retries.push(`${workflowStep.id}:${attempt}:${error}`);
      },
    });

    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(retries).toEqual(["fetch-source:1:network timeout"]);
    expect(result.completedStepIds).toEqual(["fetch-source"]);
  });

  it("does not retry non-transient permission failures", async () => {
    let attempts = 0;
    const workflow = createWorkflow([
      step("write-file", [], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async () => {
        attempts += 1;
        throw new Error("permission denied");
      },
    });

    expect(result.status).toBe("failed");
    expect(attempts).toBe(1);
    expect(result.error).toBe("permission denied");
  });

  it("fails before executing a step with missing input context", async () => {
    let executed = false;
    const workflow = createWorkflow([
      {
        ...step("verify", [], false),
        inputContextKeys: ["diffPreview"],
      },
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async () => {
        executed = true;
        return { output: "should not run" };
      },
    });

    expect(result.status).toBe("failed");
    expect(executed).toBe(false);
    expect(result.failedStepId).toBe("verify");
    expect(result.error).toContain("missing input context key(s): diffPreview");
  });

  it("triggers replan immediately when a completed handoff has invalid schema", async () => {
    const replanned: string[] = [];
    const workflow = createWorkflow([
      {
        ...step("inspect", [], false),
        outputContextKey: "diffPreview",
      },
      {
        ...step("verify", ["inspect"], false),
        inputContextKeys: ["diffPreview"],
      },
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "inspect") {
          return { output: { diff: "diff --git" } };
        }
        return { output: workflowStep.id };
      },
      onStepFailureReplan: ({ step: failedStep, error }) => {
        replanned.push(`${failedStep.id}:${error}`);
        return { abandonFailedStep: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.completedStepIds).toEqual(["inspect"]);
    expect(result.abandonedStepIds).toEqual(["verify"]);
    expect(replanned[0]).toContain("verify:Handoff validation failed after step inspect");
    expect(replanned[0]).toContain("expected object { diff: string, changedFiles: string[] }");
  });

  it("can append a recovery step after a failed step", async () => {
    const workflow = createWorkflow([
      step("scan-files", [], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "scan-files") {
          throw new Error("scan failed");
        }
        return { output: workflowStep.id };
      },
      onStepFailureReplan: ({ step: failedStep }) => ({
        abandonFailedStep: true,
        steps: [
          {
            ...step("fallback-scan", [failedStep.id], false),
            title: "Fallback scan",
          },
        ],
      }),
    });

    expect(result.status).toBe("completed");
    expect(result.completedStepIds).toEqual(["fallback-scan"]);
    expect(result.abandonedStepIds).toEqual(["scan-files"]);
    expect(result.replannedStepIds).toEqual(["fallback-scan"]);
    expect(result.contextSnapshot["step:fallback-scan"]).toBe("fallback-scan");
  });

  it("fails instead of deadlocking when replan adds steps without abandoning the failed step", async () => {
    const workflow = createWorkflow([
      step("scan-files", [], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "scan-files") {
          throw new Error("scan failed");
        }
        return { output: workflowStep.id };
      },
      onStepFailureReplan: ({ step: failedStep }) => ({
        steps: [step("fallback-scan", [failedStep.id], false)],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.failedStepId).toBe("scan-files");
    expect(result.error).toContain("must abandon the failed step");
  });

  it("accounts for every failed step in a parallel batch before continuing", async () => {
    const failed: string[] = [];
    const workflow = createWorkflow([
      step("scan-files", [], true),
      step("inspect-project", [], true),
      step("summarize", ["scan-files", "inspect-project"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "scan-files" || workflowStep.id === "inspect-project") {
          throw new Error(`${workflowStep.id} failed`);
        }
        return { output: workflowStep.id };
      },
      onStepFailureReplan: ({ step: failedStep }) => {
        failed.push(failedStep.id);
        return { abandonFailedStep: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(failed.sort()).toEqual(["inspect-project", "scan-files"]);
    expect(result.abandonedStepIds?.sort()).toEqual(["inspect-project", "scan-files"]);
    expect(result.completedStepIds).toEqual(["summarize"]);
  });

  it("does not let a hung parallel step block completed peers forever", async () => {
    const completed: string[] = [];
    const failed: string[] = [];
    const workflow = createWorkflow([
      step("fast", [], true),
      step("hung", [], true),
      step("summarize", ["fast", "hung"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      stepTimeoutMs: 10,
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "hung") {
          await new Promise(() => undefined);
        }
        return { output: workflowStep.id };
      },
      onStepCompleted: (workflowStep) => completed.push(workflowStep.id),
      onStepFailed: (workflowStep) => failed.push(workflowStep.id),
      onStepFailureReplan: ({ step: failedStep }) => ({
        abandonFailedStep: failedStep.id === "hung",
      }),
    });

    expect(result.status).toBe("completed");
    expect(completed).toEqual(["fast", "summarize"]);
    expect(failed).toEqual(["hung"]);
    expect(result.abandonedStepIds).toEqual(["hung"]);
  });

  it("skips duplicate replanned steps and continues existing downstream work", async () => {
    const workflow = createWorkflow([
      step("scan-files", [], false),
      step("fallback-scan", ["scan-files"], false),
    ]);

    const executed: string[] = [];
    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => {
        executed.push(workflowStep.id);
        if (workflowStep.id === "scan-files") {
          throw new Error("scan failed");
        }
        return { output: workflowStep.id };
      },
      onStepFailureReplan: () => ({
        abandonFailedStep: true,
        steps: [step("fallback-scan", ["scan-files"], false)],
      }),
    });

    expect(result.status).toBe("completed");
    expect(executed).toEqual(["scan-files", "fallback-scan"]);
    expect(result.completedStepIds).toEqual(["fallback-scan"]);
    expect(result.abandonedStepIds).toEqual(["scan-files"]);
    expect(result.replannedStepIds).toBeUndefined();
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
