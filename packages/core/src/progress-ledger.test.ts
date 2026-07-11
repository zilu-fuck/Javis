import { describe, expect, it } from "vitest";
import {
  buildProgressLedger,
  buildTaskLedger,
  createReplanShapeFingerprint,
  detectStuckSignals,
  extractMissingContextKeys,
} from "./progress-ledger";
import type { WorkbenchWorkflowStep } from "./workflows";

const baseStep: WorkbenchWorkflowStep = {
  id: "inspect",
  title: "Inspect repository",
  agentKind: "code",
  input: "workspace",
  output: "evidence",
  permissionLevel: "read",
  dependsOn: [],
  canRunInParallel: false,
};

describe("progress-ledger", () => {
  it("builds compact task and progress ledgers", () => {
    const task = buildTaskLedger({
      goal: "resume safely",
      facts: [" checkpoint exists ", "checkpoint exists"],
      acceptanceCriteria: ["no duplicate writes"],
    });
    expect(task.facts).toEqual(["checkpoint exists"]);
    expect(task.acceptanceCriteria).toEqual(["no duplicate writes"]);

    const progress = buildProgressLedger({
      goal: task.goal,
      workflowSteps: [
        { ...baseStep, id: "collect", outputContextKey: "repoEvidence" },
        { ...baseStep, id: "verify", dependsOn: ["collect"] },
      ],
      completedStepIds: ["collect"],
      failed: [
        {
          stepId: "verify",
          toolName: "verifier.check",
          inputFingerprint: "same",
          errorSummary: "missing artifact",
        },
        {
          stepId: "verify",
          toolName: "verifier.check",
          inputFingerprint: "same",
          errorSummary: "missing artifact",
        },
      ],
    });

    expect(progress.completed).toEqual([
      {
        stepId: "collect",
        title: "Inspect repository",
        agentKind: "code",
        outputContextKey: "repoEvidence",
      },
    ]);
    expect(progress.remainingWork).toEqual(["verify"]);
    expect(progress.repeatedActions).toEqual([
      expect.objectContaining({ kind: "tool", count: 2 }),
    ]);
  });

  it("detects repeated failed tool calls and returns a switch-tool hint", () => {
    const signals = detectStuckSignals({
      toolFailures: [
        {
          stepId: "search-1",
          toolName: "code.searchRepository",
          input: { query: "runtime_events" },
          error: "timeout",
        },
        {
          stepId: "search-2",
          toolName: "code.searchRepository",
          input: { query: "runtime_events" },
          error: "timeout again",
        },
      ],
    });

    expect(signals).toEqual([
      expect.objectContaining({
        kind: "repeated_tool_failure",
        severity: "blocked",
        hint: expect.stringContaining("switch tool"),
      }),
    ]);
  });

  it("detects duplicate replan shapes independent of step ids", () => {
    const first = {
      steps: [
        {
          ...baseStep,
          id: "recovery-a",
          inputContextKeys: ["diffPreview", "verificationResult"],
          outputContextKey: "recoveryResult",
        },
      ],
    };
    const second = {
      steps: [
        {
          ...baseStep,
          id: "recovery-b",
          inputContextKeys: ["verificationResult", "diffPreview"],
          outputContextKey: "recoveryResult",
        },
      ],
    };

    expect(createReplanShapeFingerprint(first)).toBe(createReplanShapeFingerprint(second));
    expect(detectStuckSignals({ replanShapes: [first, second] })).toEqual([
      expect.objectContaining({
        kind: "duplicate_replan_shape",
        hint: expect.stringContaining("change recovery strategy"),
      }),
    ]);
  });

  it("detects repeated missing context keys as handoff stuck signals", () => {
    const signals = detectStuckSignals({
      missingContextFailures: [
        { stepId: "verify-a", missingContextKeys: ["diffPreview"] },
        { stepId: "verify-b", missingContextKeys: ["diffPreview"] },
      ],
    });

    expect(signals).toEqual([
      expect.objectContaining({
        kind: "repeated_missing_context",
        severity: "blocked",
        hint: expect.stringContaining("missing upstream artifact"),
      }),
    ]);
  });

  it("extracts requested context keys from request_input errors", () => {
    expect(
      extractMissingContextKeys(
        "ReAct request_input for step verify: Need evidence. requestedContextKeys: [diffPreview, verificationResult]",
      ),
    ).toEqual(["diffPreview", "verificationResult"]);
  });
});
