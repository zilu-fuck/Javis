import { describe, expect, it, vi } from "vitest";
import { createArtifactEnvelope } from "./artifact-envelope";
import { createSharedTaskContext } from "./shared-context";
import { executeWorkflow } from "./workflow-dag-executor";
import type { AgentCapabilityTag } from "./agent-capability";
import type { WorkbenchWorkflow } from "./workflows";

describe("executeWorkflow", () => {
  it("rejects cyclic dependencies before executing any workflow step", async () => {
    let executed = false;
    const workflow = createWorkflow([
      step("first", ["second"], false),
      step("second", ["first"], false),
    ]);

    await expect(executeWorkflow({
      workflow,
      executeStep: async () => {
        executed = true;
        return { output: "unexpected" };
      },
    })).rejects.toThrow(/cyclic dependency: first -> second -> first/);
    expect(executed).toBe(false);
  });

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
    expect(result.stepResults["analyze-code"]).toMatchObject({
      status: "completed",
      evidence: [{ kind: "artifact", reference: "step:analyze-code" }],
      assumptions: [],
      unresolvedQuestions: [],
    });
  });

  it("allows partial results to continue while preserving evidence and gaps", async () => {
    const workflow = createWorkflow([
      {
        ...step("collect", [], false),
        outputContextKey: "evidence",
        completionPolicy: {
          partial: "publish_and_continue",
          blocked: "replan",
          needsClarification: "replan",
        },
      },
      { ...step("verify", ["collect"], false), inputContextKeys: ["evidence"] },
    ]);
    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep) => workflowStep.id === "collect"
        ? {
            status: "partial",
            output: { files: ["README.md"] },
            evidence: [{ kind: "file", label: "README", reference: "README.md" }],
            assumptions: ["The manifest is unchanged."],
            unresolvedQuestions: ["Should generated files be included?"],
          }
        : { output: "verified" },
    });

    expect(result.status).toBe("completed");
    expect(result.completedStepIds).toEqual(["collect", "verify"]);
    expect(result.stepResults.collect).toMatchObject({
      status: "partial",
      evidence: [{ kind: "file", reference: "README.md" }],
      unresolvedQuestions: ["Should generated files be included?"],
    });
    expect(result.contextSnapshot["stepResult:collect"]).toMatchObject({ status: "partial" });
  });

  it("stops and withholds partial output unless publication is explicit", async () => {
    const downstream = vi.fn(async () => ({ output: "must not run" }));
    const result = await executeWorkflow({
      workflow: createWorkflow([
        { ...step("collect", [], false), outputContextKey: "evidence" },
        { ...step("verify", ["collect"], false), inputContextKeys: ["evidence"] },
      ]),
      executeStep: async (workflowStep) => workflowStep.id === "collect"
        ? {
            status: "partial",
            output: { files: ["README.md"] },
            unmetCriteria: ["package manifest was not inspected"],
          }
        : downstream(),
    });

    expect(result.status).toBe("failed");
    expect(result.failedStepId).toBe("collect");
    expect(result.contextSnapshot.evidence).toBeUndefined();
    expect(result.contextSnapshot["step:collect"]).toBeUndefined();
    expect(result.stepResults.collect).toMatchObject({
      status: "partial",
      unmetCriteria: ["package manifest was not inspected"],
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("stops downstream work for blocked results and keeps the blocker", async () => {
    const downstream = vi.fn(async () => ({ output: "must not run" }));
    const result = await executeWorkflow({
      workflow: createWorkflow([
        step("clarify", [], false),
        step("execute", ["clarify"], false),
      ]),
      executeStep: async (workflowStep) => workflowStep.id === "clarify"
        ? {
            status: "needs_clarification",
            evidence: [{ kind: "manual", label: "Missing target" }],
            assumptions: [],
            unresolvedQuestions: ["Which workspace should be used?"],
            error: "Target workspace is required.",
          }
        : downstream(),
    });

    expect(result.status).toBe("failed");
    expect(result.failedStepId).toBe("clarify");
    expect(downstream).not.toHaveBeenCalled();
    expect(result.stepResults.clarify).toMatchObject({
      status: "needs_clarification",
      unresolvedQuestions: ["Which workspace should be used?"],
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

  it("clears failed-attempt outputs and observations before retrying", async () => {
    let attempts = 0;
    const workflow = createWorkflow([{
      ...step("fetch-source", [], false),
      outputContextKey: "searchResults",
    }]);

    const result = await executeWorkflow({
      workflow,
      executeStep: async (workflowStep, context) => {
        attempts += 1;
        if (attempts === 1) {
          context.set("searchResults", { stale: true });
          context.set(`step:${workflowStep.id}`, { stale: true });
          context.set(`react:${workflowStep.id}:0`, { output: "stale" });
          throw new Error("network timeout");
        }
        expect(context.has("searchResults")).toBe(false);
        expect(context.has(`step:${workflowStep.id}`)).toBe(false);
        expect(context.has(`react:${workflowStep.id}:0`)).toBe(false);
        return { output: [] };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.contextSnapshot.searchResults).toEqual([]);
  });

  it("does not expose an abandoned step's partial output to recovery work", async () => {
    const workflow = createWorkflow([
      { ...step("collect", [], false), outputContextKey: "searchResults" },
    ]);

    const result = await executeWorkflow({
      workflow,
      maxStepRetries: 0,
      executeStep: async (workflowStep, context) => {
        if (workflowStep.id === "collect") {
          context.set("searchResults", [{ stale: true }]);
          context.set(`react:${workflowStep.id}:0`, { output: "stale" });
          throw new Error("collection failed");
        }
        expect(context.has("searchResults")).toBe(false);
        expect(context.has("react:collect:0")).toBe(false);
        return { output: "recovered" };
      },
      onStepFailureReplan: () => ({
        abandonFailedStep: true,
        steps: [step("recover", ["collect"], false)],
      }),
    });

    expect(result.status).toBe("completed");
    expect(result.contextSnapshot.searchResults).toBeUndefined();
    expect(result.contextSnapshot["react:collect:0"]).toBeUndefined();
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
    expect(result.completedStepIds).toEqual([]);
    expect(result.abandonedStepIds).toEqual(["inspect", "verify"]);
    expect(result.contextSnapshot.diffPreview).toBeUndefined();
    expect(replanned[0]).toContain("inspect:Handoff validation failed after step inspect");
    expect(replanned[0]).toContain("expected object { diff: string, changedFiles: string[] }");
  });

  it("lets a recovery step replace an invalid handoff value under the same context key", async () => {
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
        if (workflowStep.id === "repair-diff") {
          return { output: { diff: "diff --git", changedFiles: ["src/app.ts"] } };
        }
        return { output: workflowStep.id };
      },
      onStepFailureReplan: ({ step: failedStep }) => {
        if (failedStep.id !== "inspect") {
          return undefined;
        }
        return {
          abandonFailedStep: true,
          steps: [
            {
              ...step("repair-diff", ["inspect"], false),
              outputContextKey: "diffPreview",
            },
          ],
        };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.completedStepIds).toEqual(["repair-diff", "verify"]);
    expect(result.abandonedStepIds).toEqual(["inspect"]);
    expect(result.contextSnapshot.diffPreview).toEqual({
      diff: "diff --git",
      changedFiles: ["src/app.ts"],
    });
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

  it("fails closed when a recovery plan reuses an existing step id", async () => {
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

    expect(result.status).toBe("failed");
    expect(executed).toEqual(["scan-files"]);
    expect(result.completedStepIds).toEqual([]);
    expect(result.abandonedStepIds).toBeUndefined();
    expect(result.error).toContain("duplicate or existing step id");
    expect(result.replannedStepIds).toBeUndefined();
  });

  it("resumes from completed checkpoint steps without rerunning upstream work", async () => {
    const executed: string[] = [];
    const workflow = createWorkflow([
      {
        ...step("scan-files", [], false),
        outputContextKey: "diffPreview",
      },
      {
        ...step("verify", ["scan-files"], false),
        inputContextKeys: ["diffPreview"],
      },
    ]);

    const result = await executeWorkflow({
      workflow,
      resumeFrom: {
        completedStepIds: ["scan-files"],
        contextSnapshot: {
          "step:scan-files": { scanned: true },
          diffPreview: {
            diff: "diff --git a/src/app.ts b/src/app.ts",
            changedFiles: ["src/app.ts"],
          },
        },
      },
      executeStep: async (workflowStep, context) => {
        executed.push(workflowStep.id);
        expect(context.get("diffPreview")).toEqual({
          diff: "diff --git a/src/app.ts b/src/app.ts",
          changedFiles: ["src/app.ts"],
        });
        return { output: workflowStep.id };
      },
    });

    expect(result.status).toBe("completed");
    expect(executed).toEqual(["verify"]);
    expect(result.completedStepIds).toEqual(["scan-files", "verify"]);
    expect(result.results.get("scan-files")).toEqual({ scanned: true });
  });

  it("normalizes legacy step results restored from checkpoints", async () => {
    const workflow = createWorkflow([
      {
        ...step("scan-files", [], false),
        outputContextKey: "diffPreview",
      },
      step("verify", ["scan-files"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      resumeFrom: {
        completedStepIds: ["scan-files"],
        contextSnapshot: {
          "step:scan-files": { scanned: true },
          diffPreview: { scanned: true },
          stepResults: {
            "scan-files": { output: { scanned: true } },
          },
          "stepResult:scan-files": { output: { scanned: true } },
        },
      },
      executeStep: async (workflowStep, context) => {
        expect(context.get("stepResult:scan-files")).toEqual({
          status: "completed",
          output: { scanned: true },
          evidence: [{
            kind: "artifact",
            label: "Step scan-files output",
            reference: "diffPreview",
          }],
          assumptions: [],
          unresolvedQuestions: [],
        });
        return { output: workflowStep.id };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.stepResults["scan-files"]).toMatchObject({
      status: "completed",
      evidence: [{ kind: "artifact", reference: "diffPreview" }],
    });
  });

  it("restores artifact envelopes from resume checkpoints", async () => {
    const workflow = createWorkflow([
      {
        ...step("scan-files", [], false),
        outputContextKey: "diffPreview",
      },
      {
        ...step("verify", ["scan-files"], false),
        inputContextKeys: ["diffPreview"],
      },
    ]);
    const envelope = createArtifactEnvelope(
      { diff: "diff --git a/src/app.ts b/src/app.ts", changedFiles: ["src/app.ts"] },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { workflowId: workflow.id, stepId: "scan-files", agentKind: "file" },
      },
    );

    const result = await executeWorkflow({
      workflow,
      context: createSharedTaskContext({ taskId: "task-1" }),
      artifactExpectation: {
        taskId: "task-1",
        runId: "run-1",
        producer: { workflowId: workflow.id },
      },
      resumeFrom: {
        completedStepIds: ["scan-files"],
        contextSnapshot: {
          diffPreview: envelope,
          "step:scan-files": envelope.payload,
        },
      },
      executeStep: async (workflowStep, context) => {
        if (workflowStep.id === "verify") {
          expect(context.get("diffPreview")).toEqual({
            diff: "diff --git a/src/app.ts b/src/app.ts",
            changedFiles: ["src/app.ts"],
          });
          expect(context.getEnvelope("diffPreview")).toBe(envelope);
        }
        return { output: workflowStep.id };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.completedStepIds).toEqual(["scan-files", "verify"]);
  });

  it("rejects a resume artifact bound to another task or run", async () => {
    const workflow = createWorkflow([
      {
        ...step("scan-files", [], false),
        outputContextKey: "diffPreview",
      },
    ]);
    const envelope = createArtifactEnvelope(
      { diff: "diff", changedFiles: [] },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: {
          workflowId: workflow.id,
          stepId: "scan-files",
          agentKind: "file",
        },
      },
    );

    await expect(executeWorkflow({
      workflow,
      artifactExpectation: {
        taskId: "task-1",
        runId: "run-2",
        producer: { workflowId: workflow.id },
      },
      resumeFrom: {
        completedStepIds: ["scan-files"],
        contextSnapshot: { diffPreview: envelope },
      },
      executeStep: async () => ({ output: "unreachable" }),
    })).rejects.toThrow("invalid artifact envelope");
  });

  it("rejects partially-shaped artifact data instead of downgrading it to context", async () => {
    const workflow = createWorkflow([step("scan-files", [], false)]);

    await expect(executeWorkflow({
      workflow,
      resumeFrom: {
        contextSnapshot: {
          diffPreview: {
            artifactId: "art-invalid",
            payload: { diff: "tampered" },
          },
        },
      },
      executeStep: async () => ({ output: "unreachable" }),
    })).rejects.toThrow("malformed artifact envelope");
  });

  it("rejects unknown and overlapping resume step states at the executor boundary", async () => {
    const workflow = createWorkflow([
      step("scan-files", [], false),
      step("verify", ["scan-files"], false),
    ]);

    await expect(executeWorkflow({
      workflow,
      resumeFrom: { completedStepIds: ["unknown-step"] },
      executeStep: async () => ({ output: "unreachable" }),
    })).rejects.toThrow("references unknown step unknown-step");

    await expect(executeWorkflow({
      workflow,
      resumeFrom: {
        contextSnapshot: {
          stepResults: { "unknown-step": { output: "untrusted" } },
        },
      },
      executeStep: async () => ({ output: "unreachable" }),
    })).rejects.toThrow("stepResults references unknown step unknown-step");

    await expect(executeWorkflow({
      workflow,
      resumeFrom: {
        contextSnapshot: {
          stepResults: { "scan-files": null },
        },
      },
      executeStep: async () => ({ output: "unreachable" }),
    })).rejects.toThrow("stepResults for scan-files is malformed");

    await expect(executeWorkflow({
      workflow,
      resumeFrom: {
        completedStepIds: ["scan-files"],
        abandonedStepIds: ["scan-files"],
      },
      executeStep: async () => ({ output: "unreachable" }),
    })).rejects.toThrow("appears in both completed and abandoned state");

    await expect(executeWorkflow({
      workflow,
      resumeFrom: {
        completedStepIds: ["scan-files"],
        retryStepIds: ["scan-files"],
      },
      executeStep: async () => ({ output: "unreachable" }),
    })).rejects.toThrow("appears in both completed and retry state");
  });

  it("treats checkpoint running steps as retryable pending work", async () => {
    const executed: string[] = [];
    const workflow = createWorkflow([
      step("scan-files", [], false),
      step("preview-write", ["scan-files"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      resumeFrom: {
        completedStepIds: ["scan-files"],
        retryStepIds: ["preview-write"],
        contextSnapshot: {
          "step:scan-files": { scanned: true },
        },
      },
      executeStep: async (workflowStep) => {
        executed.push(workflowStep.id);
        return { output: { retried: workflowStep.id } };
      },
    });

    expect(result.status).toBe("completed");
    expect(executed).toEqual(["preview-write"]);
    expect(result.completedStepIds).toEqual(["scan-files", "preview-write"]);
    expect(result.contextSnapshot["step:preview-write"]).toEqual({ retried: "preview-write" });
  });

  it("runs an independent travel-planning fan-out through a bounded pool before synthesis", async () => {
    const completedRoots = new Set<string>();
    const backpressure: Array<{ readyCount: number; admittedCount: number }> = [];
    let active = 0;
    let maxActive = 0;
    const workflow = createWorkflow([
      step("find-flights", [], true),
      step("find-hotels", [], true),
      step("check-weather", [], true),
      step("build-trip-plan", ["find-flights", "find-hotels", "check-weather"], false),
    ]);

    const result = await executeWorkflow({
      workflow,
      executionPolicy: {
        maxConcurrency: 2,
        maxReadyQueueSize: 2,
      },
      onBackpressure: ({ readyCount, admittedCount }) => {
        backpressure.push({ readyCount, admittedCount });
      },
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "build-trip-plan") {
          expect([...completedRoots].sort()).toEqual([
            "check-weather",
            "find-flights",
            "find-hotels",
          ]);
          return { output: "trip-plan" };
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        completedRoots.add(workflowStep.id);
        active -= 1;
        return { output: workflowStep.id };
      },
    });

    expect(result.status).toBe("completed");
    expect(maxActive).toBe(2);
    expect(backpressure).toContainEqual({ readyCount: 3, admittedCount: 2 });
    expect(result.completedStepIds[result.completedStepIds.length - 1]).toBe("build-trip-plan");
  });

  it("rate-limits step starts while preserving parallel eligibility", async () => {
    const startedAt: number[] = [];
    const workflow = createWorkflow([
      step("first-source", [], true),
      step("second-source", [], true),
      step("third-source", [], true),
    ]);

    const result = await executeWorkflow({
      workflow,
      executionPolicy: {
        maxConcurrency: 3,
        rateLimitPerSecond: 20,
      },
      executeStep: async (workflowStep) => {
        startedAt.push(Date.now());
        return { output: workflowStep.id };
      },
    });

    expect(result.status).toBe("completed");
    expect(startedAt).toHaveLength(3);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(35);
    expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(35);
  });

  it("aborts a timed-out step attempt", async () => {
    let aborted = false;
    const workflow = createWorkflow([step("hung-step", [], false)]);

    const result = await executeWorkflow({
      workflow,
      executionPolicy: {
        stepTimeoutMs: 20,
        maxStepRetries: 0,
      },
      executeStep: async (_workflowStep, _context, attemptSignal) =>
        new Promise((_resolve, reject) => {
          attemptSignal?.addEventListener("abort", () => {
            aborted = true;
            reject(attemptSignal.reason);
          }, { once: true });
        }),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("timed out");
    expect(aborted).toBe(true);
  });

  it("opens the circuit and lets Commander recovery dynamically expand the pool", async () => {
    let policy = {
      maxConcurrency: 1,
      maxStepRetries: 0,
      circuitBreakerFailureThreshold: 1,
    };
    let circuitOpenCount = 0;
    let active = 0;
    let maxActive = 0;
    const workflow = createWorkflow([step("primary-provider", [], false)]);

    const result = await executeWorkflow({
      workflow,
      getExecutionPolicy: () => policy,
      onCircuitBreakerOpen: () => {
        circuitOpenCount += 1;
      },
      executeStep: async (workflowStep) => {
        if (workflowStep.id === "primary-provider") {
          throw new Error("provider unavailable");
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { output: workflowStep.id };
      },
      onStepFailureReplan: ({ step: failedStep }) => {
        policy = {
          maxConcurrency: 3,
          maxStepRetries: 1,
          circuitBreakerFailureThreshold: 2,
        };
        return {
          abandonFailedStep: true,
          steps: [
            step("fallback-flights", [failedStep.id], true),
            step("fallback-hotels", [failedStep.id], true),
            step("fallback-weather", [failedStep.id], true),
          ],
        };
      },
    });

    expect(result.status).toBe("completed");
    expect(circuitOpenCount).toBe(1);
    expect(maxActive).toBe(3);
    expect(result.abandonedStepIds).toEqual(["primary-provider"]);
    expect(result.completedStepIds.sort()).toEqual([
      "fallback-flights",
      "fallback-hotels",
      "fallback-weather",
    ]);
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
