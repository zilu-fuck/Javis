import { describe, expect, it } from "vitest";
import { planResume, type ResumeStep } from "./resume-plan";

/**
 * A five-step chain with one branch:
 *
 *   scan ──► inspect ──► analyse ──► write-report
 *                  └──► capture-ui ──┘
 *
 * `analyse` and `capture-ui` both feed `write-report`, which is what makes the
 * cascade interesting: rolling back `inspect` must dirty `analyse`, `capture-ui` and
 * `write-report`, but not `scan`.
 */
const STEPS: ResumeStep[] = [
  { id: "scan", outputContextKey: "scanResult" },
  { id: "inspect", dependsOn: ["scan"], inputContextKeys: ["scanResult"], outputContextKey: "inspectResult" },
  { id: "analyse", dependsOn: ["inspect"], inputContextKeys: ["inspectResult"], outputContextKey: "analysis" },
  { id: "capture-ui", dependsOn: ["inspect"], inputContextKeys: ["inspectResult"], outputContextKey: "uiEvidence" },
  { id: "write-report", dependsOn: ["analyse", "capture-ui"], inputContextKeys: ["analysis", "uiEvidence"], outputContextKey: "report" },
];

describe("planResume: resume", () => {
  it("re-runs exactly the unfinished steps", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: {
        completedStepIds: ["scan", "inspect", "analyse"],
        abandonedStepIds: ["capture-ui"],
        pendingStepIds: ["write-report"],
        contextKeys: ["scanResult", "inspectResult", "analysis"],
      },
    });
    expect(plan.mode).toBe("resume");
    expect(plan.stepsToRun).toEqual(["capture-ui", "write-report"]);
    expect(plan.skippedStepIds).toEqual(["scan", "inspect", "analyse"]);
    expect(plan.reason).toContain("Resuming 2 unfinished step(s)");
  });

  it("orders the plan by dependency, not by declaration order", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: ["scan"], pendingStepIds: ["write-report", "inspect", "analyse", "capture-ui"] },
    });
    expect(plan.stepsToRun.indexOf("inspect")).toBeLessThan(plan.stepsToRun.indexOf("analyse"));
    expect(plan.stepsToRun.indexOf("analyse")).toBeLessThan(plan.stepsToRun.indexOf("write-report"));
    expect(plan.stepsToRun.indexOf("capture-ui")).toBeLessThan(plan.stepsToRun.indexOf("write-report"));
  });

  it("invalidates the output key of every step that will run again", () => {
    // The correctness point: leaving `uiEvidence` in the restored context would let
    // `write-report` read an artifact from the attempt that just failed.
    const plan = planResume({
      steps: STEPS,
      checkpoint: {
        completedStepIds: ["scan", "inspect", "analyse"],
        abandonedStepIds: ["capture-ui"],
        pendingStepIds: ["write-report"],
        contextKeys: ["scanResult", "inspectResult", "analysis", "uiEvidence"],
      },
    });
    expect(plan.invalidatedContextKeys).toEqual(["report", "uiEvidence"]);
  });

  it("does not report a key as missing when a step in the run will produce it", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: {
        completedStepIds: ["scan", "inspect"],
        abandonedStepIds: ["analyse", "capture-ui"],
        pendingStepIds: ["write-report"],
        contextKeys: ["scanResult", "inspectResult"],
      },
    });
    expect(plan.missingInputContextKeys).toEqual([]);
  });

  it("reports an unobtainable input instead of planning an impossible resume", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: {
        completedStepIds: ["scan", "inspect", "analyse", "capture-ui"],
        abandonedStepIds: ["write-report"],
        // `capture-ui` completed but its artifact was never checkpointed.
        contextKeys: ["scanResult", "inspectResult", "analysis"],
      },
    });
    expect(plan.missingInputContextKeys).toEqual(["uiEvidence"]);
    expect(plan.warnings.join(" ")).toContain("Re-plan rather than resume");
  });

  it("ignores step ids in the checkpoint that are not in the workflow", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: ["scan", "removed-step"], pendingStepIds: ["inspect"] },
    });
    expect(plan.stepsToRun).not.toContain("removed-step");
    expect(plan.skippedStepIds).toContain("scan");
  });

  it("plans nothing when the checkpoint shows everything completed", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: STEPS.map((step) => step.id) },
    });
    expect(plan.stepsToRun).toEqual([]);
    expect(plan.invalidatedContextKeys).toEqual([]);
    expect(plan.skippedStepIds).toHaveLength(STEPS.length);
  });
});

describe("planResume: retry_failed", () => {
  it("re-runs the failed step alone, without its consumers", () => {
    // This is the "just try it again" mode: re-running downstream steps would discard
    // work that is still valid.
    const plan = planResume({
      steps: STEPS,
      checkpoint: {
        completedStepIds: ["scan", "inspect", "analyse", "capture-ui", "write-report"],
        abandonedStepIds: ["analyse"],
        contextKeys: ["scanResult", "inspectResult"],
      },
      mode: "retry_failed",
    });
    // `analyse` appears as both completed and abandoned — a retry that failed. The
    // failure is the newer fact, so it runs; its downstream consumers do not.
    expect(plan.stepsToRun).toEqual(["analyse"]);
    expect(plan.invalidatedContextKeys).toEqual(["analysis"]);
    expect(plan.skippedStepIds).toContain("write-report");
  });

  it("still runs genuinely unfinished steps", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: {
        completedStepIds: ["scan", "inspect"],
        pendingStepIds: ["analyse", "capture-ui", "write-report"],
      },
      mode: "retry_failed",
    });
    expect(plan.stepsToRun).toHaveLength(3);
  });
});

describe("planResume: rollback", () => {
  it("defaults to rollback mode when a target step is given", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: STEPS.map((step) => step.id) },
      rollbackToStepId: "inspect",
    });
    expect(plan.mode).toBe("rollback");
  });

  it("re-runs the target and every downstream step, but not upstream ones", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: {
        completedStepIds: STEPS.map((step) => step.id),
        contextKeys: ["scanResult", "inspectResult", "analysis", "uiEvidence", "report"],
      },
      rollbackToStepId: "inspect",
    });
    expect(plan.stepsToRun).toEqual(["inspect", "analyse", "capture-ui", "write-report"]);
    expect(plan.skippedStepIds).toEqual(["scan"]);
    expect(plan.invalidatedContextKeys).toEqual(["analysis", "inspectResult", "report", "uiEvidence"]);
  });

  it("warns how much already-completed downstream work the rollback discards", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: STEPS.map((step) => step.id) },
      rollbackToStepId: "analyse",
    });
    // `analyse` is the requested target, so only its downstream consumers count as
    // collateral: `write-report` (and `capture-ui` is not downstream of `analyse`).
    expect(plan.warnings.join(" ")).toContain("invalidates 1 already-completed downstream step(s)");
    expect(plan.warnings.join(" ")).toContain("write-report");
  });

  it("rolls back to the final step without touching anything upstream", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: STEPS.map((step) => step.id), contextKeys: ["analysis", "uiEvidence"] },
      rollbackToStepId: "write-report",
    });
    expect(plan.stepsToRun).toEqual(["write-report"]);
    expect(plan.warnings).toEqual([]);
  });

  it("refuses a target that is not in the workflow, with a reason", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: ["scan"] },
      rollbackToStepId: "does-not-exist",
    });
    expect(plan.stepsToRun).toEqual([]);
    expect(plan.reason).toContain("not part of this workflow");
    expect(plan.warnings.join(" ")).toContain("not part of this workflow");
  });

  it("reports an unknown dependency order without hanging or throwing", () => {
    // A corrupted checkpoint can describe a cycle; the recovery path must still answer.
    const cyclic: ResumeStep[] = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    const plan = planResume({
      steps: cyclic,
      checkpoint: { completedStepIds: [], pendingStepIds: ["a", "b"] },
    });
    expect(plan.stepsToRun).toHaveLength(2);
    expect(new Set(plan.stepsToRun)).toEqual(new Set(["a", "b"]));
  });

  it("survives a dependency naming a step that is not in the workflow", () => {
    const plan = planResume({
      steps: [{ id: "solo", dependsOn: ["ghost"], outputContextKey: "x" }],
      checkpoint: { completedStepIds: [], pendingStepIds: ["solo"] },
    });
    expect(plan.stepsToRun).toEqual(["solo"]);
  });
});

describe("planResume invariants", () => {
  it("always accounts for every step exactly once", () => {
    const checkpoints = [
      { completedStepIds: ["scan"], pendingStepIds: ["inspect", "analyse", "capture-ui", "write-report"] },
      { completedStepIds: ["scan", "inspect"], abandonedStepIds: ["analyse"] },
      { completedStepIds: STEPS.map((step) => step.id) },
      { completedStepIds: [], runningStepIds: ["scan"] },
    ];
    for (const checkpoint of checkpoints) {
      const plan = planResume({ steps: STEPS, checkpoint });
      const accounted = [...plan.stepsToRun, ...plan.skippedStepIds].sort();
      expect(accounted).toEqual(STEPS.map((step) => step.id).sort());
      // Never both run and skip.
      for (const id of plan.stepsToRun) {
        expect(plan.skippedStepIds).not.toContain(id);
      }
    }
  });

  it("is deterministic across repeated calls", () => {
    const input = {
      steps: STEPS,
      checkpoint: { completedStepIds: ["scan"], pendingStepIds: ["inspect", "analyse", "capture-ui", "write-report"] },
    };
    expect(planResume(input).stepsToRun).toEqual(planResume(input).stepsToRun);
  });

  it("treats a running step as unfinished, so a crash mid-step is recoverable", () => {
    const plan = planResume({
      steps: STEPS,
      checkpoint: { completedStepIds: ["scan", "inspect"], runningStepIds: ["analyse"] },
    });
    expect(plan.stepsToRun).toContain("analyse");
  });
});
