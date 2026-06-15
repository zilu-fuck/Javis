import { describe, expect, it } from "vitest";
import {
  buildPlanGenerationTrace,
  classifyCompileStatus,
  type PlanGenerationStageRecord,
  type PlanRecoveryCompileRecord,
} from "../plan-generation-trace";
import { PlanGenerationTraceShape } from "../schema";

describe("classifyCompileStatus", () => {
  it("returns compiled when ok and no warnings", () => {
    expect(classifyCompileStatus(true, false, [])).toBe("compiled");
  });

  it("returns compiled_with_warnings when ok with warnings", () => {
    expect(
      classifyCompileStatus(true, false, [
        { code: "UNKNOWN_CAPABILITY", severity: "warning", message: "y" },
      ]),
    ).toBe("compiled_with_warnings");
  });

  it("returns failed_repairable when not ok and repairable", () => {
    expect(classifyCompileStatus(false, true, [])).toBe("failed_repairable");
  });

  it("returns failed_non_repairable when not ok and not repairable", () => {
    expect(classifyCompileStatus(false, false, [])).toBe("failed_non_repairable");
  });
});

describe("buildPlanGenerationTrace", () => {
  it("flags initialCompiled=true when the initial stage compiled without warnings", () => {
    const initial: PlanGenerationStageRecord = {
      stage: "initial",
      attempt: 1,
      status: "compiled",
      diagnostics: [],
      stepIds: ["a", "b"],
    };
    const trace = buildPlanGenerationTrace({
      userGoal: "list files",
      stages: [initial],
      recoveryCompiles: [],
    });
    expect(trace.initialCompiled).toBe(true);
    expect(trace.repairAttemptCount).toBe(0);
    expect(trace.stages).toEqual([initial]);
  });

  it("flags initialCompiled=true when the initial stage compiled with warnings", () => {
    const trace = buildPlanGenerationTrace({
      userGoal: "x",
      stages: [
        { stage: "initial", attempt: 1, status: "compiled_with_warnings", diagnostics: [], stepIds: [] },
      ],
      recoveryCompiles: [],
    });
    expect(trace.initialCompiled).toBe(true);
  });

  it("flags initialCompiled=false when the initial stage failed", () => {
    const trace = buildPlanGenerationTrace({
      userGoal: "x",
      stages: [
        { stage: "initial", attempt: 1, status: "failed_repairable", diagnostics: [], stepIds: [] },
        { stage: "repair", attempt: 1, status: "compiled", diagnostics: [], stepIds: [] },
      ],
      recoveryCompiles: [],
    });
    expect(trace.initialCompiled).toBe(false);
    expect(trace.repairAttemptCount).toBe(1);
  });

  it("counts only repair stages in repairAttemptCount", () => {
    const trace = buildPlanGenerationTrace({
      userGoal: "x",
      stages: [
        { stage: "initial", attempt: 1, status: "failed_repairable", diagnostics: [], stepIds: [] },
        { stage: "repair", attempt: 1, status: "failed_repairable", diagnostics: [], stepIds: [] },
        { stage: "repair", attempt: 2, status: "compiled", diagnostics: [], stepIds: [] },
      ],
      recoveryCompiles: [],
    });
    expect(trace.repairAttemptCount).toBe(2);
  });

  it("preserves the recovery compile record on the trace", () => {
    const recovery: PlanRecoveryCompileRecord = {
      stage: "recovery",
      attempt: 1,
      failedStepId: "scan",
      status: "failed_non_repairable",
      diagnostics: [
        { code: "UNKNOWN_AGENT", severity: "error", message: "x" },
      ],
      stepIds: ["recover-1"],
    };
    const trace = buildPlanGenerationTrace({
      userGoal: "x",
      stages: [
        { stage: "initial", attempt: 1, status: "compiled", diagnostics: [], stepIds: ["scan"] },
      ],
      recoveryCompiles: [recovery],
    });
    expect(trace.recoveryCompiles).toEqual([recovery]);
    expect(trace.recoveryCompiles[0].failedStepId).toBe("scan");
  });

  it("stamps the schema + plan versions on every trace", () => {
    const trace = buildPlanGenerationTrace({
      userGoal: "x",
      stages: [
        { stage: "initial", attempt: 1, status: "compiled", diagnostics: [], stepIds: [] },
      ],
      recoveryCompiles: [],
    });
    expect(trace.schemaVersion).toBe("1.0.0");
    expect(trace.planSchemaVersion).toBe("1.0.0");
  });

  it("preserves extractedJson, normalizedPlan, promptVersion when provided", () => {
    const normalizedPlan = {
      title: "Plan",
      reasoning: "Because",
      steps: [
        {
          id: "scan",
          title: "Scan",
          assignedAgentKind: "code",
          requiredCapabilities: [],
          dependsOn: [],
          successCriteria: "Done.",
        },
      ],
    };
    const trace = buildPlanGenerationTrace({
      userGoal: "x",
      stages: [
        { stage: "initial", attempt: 1, status: "compiled", diagnostics: [], stepIds: ["scan"] },
      ],
      recoveryCompiles: [],
      extractedJson: JSON.stringify(normalizedPlan),
      normalizedPlan,
      promptVersion: "1.2.3",
    });
    expect(trace.extractedJson).toBe(JSON.stringify(normalizedPlan));
    expect(trace.normalizedPlan).toBe(normalizedPlan);
    expect(trace.promptVersion).toBe("1.2.3");
  });

  it("builder output passes PlanGenerationTraceShape Zod schema (contract test)", () => {
    const trace = buildPlanGenerationTrace({
      userGoal: "Search repo and summarize",
      stages: [
        { stage: "initial", attempt: 1, status: "compiled_with_warnings", diagnostics: [
          { code: "UNKNOWN_CAPABILITY", severity: "warning", message: "unknown cap" },
        ], stepIds: ["search"] },
        { stage: "repair", attempt: 1, status: "compiled", diagnostics: [], stepIds: ["search"] },
      ],
      recoveryCompiles: [
        { stage: "recovery", attempt: 1, failedStepId: "search", status: "compiled", diagnostics: [], stepIds: ["retry"] },
      ],
      extractedJson: '{"title":"T"}',
      promptVersion: "1.0.0",
    });
    const parsed = PlanGenerationTraceShape.safeParse(trace);
    if (!parsed.success) {
      throw new Error(
        `PlanGenerationTraceShape rejected builder output: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    expect(parsed.success).toBe(true);
    expect(parsed.data.initialCompiled).toBe(true); // compiled_with_warnings → true
    expect(parsed.data.repairAttemptCount).toBe(1);
    expect(parsed.data.stages).toHaveLength(2);
    expect(parsed.data.recoveryCompiles).toHaveLength(1);
    expect(parsed.data.promptVersion).toBe("1.0.0");
  });
});
