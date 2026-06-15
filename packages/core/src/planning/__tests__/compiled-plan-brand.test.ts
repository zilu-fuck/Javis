/**
 * Contract tests for the CompiledCommanderPlan brand.
 *
 * The brand is the type-level enforcement that every plan reaching
 * `runCommanderDagTask`'s execution phases has cleared the compile
 * gate (semantic validation). These tests guard the helpers used to
 * construct / merge compiled plans, and they pin the escape-hatch
 * surface area so future refactors cannot silently widen it.
 *
 * The runtime contract is also covered indirectly by the existing
 * workflow-executor tests: any plan that fails to compile is rejected
 * by the compile gate before execution begins, so the brand cannot
 * be obtained for a broken plan via the normal path.
 */

import { describe, expect, it } from "vitest";
import type { CommanderDagPlan } from "../../commander-plan-schema";
import {
  appendStepsToCompiledPlan,
  isRepairable,
  trustAsCompiled,
  type CompiledCommanderPlan,
} from "../commander-plan-diagnostics";

function makeValidStep(id: string): CommanderDagPlan["steps"][number] {
  return {
    id,
    title: `Step ${id}`,
    assignedAgentKind: "commander",
    requiredCapabilities: ["synthesis"],
    dependsOn: [],
    successCriteria: "ok",
  };
}

function makeValidPlan(extraSteps: CommanderDagPlan["steps"][number][] = []): CommanderDagPlan {
  return {
    title: "Test plan",
    reasoning: "test",
    steps: [makeValidStep("step-1"), ...extraSteps],
  };
}

describe("CompiledCommanderPlan brand", () => {
  it("trustAsCompiled brands a plain CommanderDagPlan", () => {
    const plain = makeValidPlan();
    const branded: CompiledCommanderPlan = trustAsCompiled(plain);
    // Runtime identity preserved.
    expect(branded).toBe(plain);
    // Compile-gate escape-hatch is documented: callers must follow
    // the trustAsCompiled policy in commander-plan-diagnostics.ts.
    expect(branded.title).toBe("Test plan");
  });

  it("appendStepsToCompiledPlan preserves the brand and appends steps", () => {
    const base = trustAsCompiled(makeValidPlan());
    const extra = [makeValidStep("step-2"), makeValidStep("step-3")];
    const merged = appendStepsToCompiledPlan(base, extra);
    // Brand survives: the result is still a CompiledCommanderPlan.
    const branded: CompiledCommanderPlan = merged;
    expect(branded.steps.map((s) => s.id)).toEqual(["step-1", "step-2", "step-3"]);
    // Base is unchanged (immutability contract).
    expect(base.steps.map((s) => s.id)).toEqual(["step-1"]);
  });

  it("appendStepsToCompiledPlan with an empty slice returns a brand-preserving copy", () => {
    const base = trustAsCompiled(makeValidPlan());
    const merged = appendStepsToCompiledPlan(base, []);
    const branded: CompiledCommanderPlan = merged;
    expect(branded.steps).toHaveLength(1);
  });

  it("type-level: a plain CommanderDagPlan is not assignable to CompiledCommanderPlan", () => {
    // The compile-time contract: without going through compileCommanderPlan
    // (or trustAsCompiled) a CommanderDagPlan cannot flow into a slot
    // typed CompiledCommanderPlan. This is enforced by the unique
    // symbol brand; the @ts-expect-error block below is the test.
    const plain: CommanderDagPlan = makeValidPlan();
    // @ts-expect-error - CommanderDagPlan is not assignable to CompiledCommanderPlan (missing brand).
    const shouldFail: CompiledCommanderPlan = plain;
    // Force the binding to be material so unused-error doesn't swallow the @ts-expect-error.
    expect(shouldFail).toBeDefined();
  });

  it("isRepairable still works on diagnostics after refactor", () => {
    // Smoke test: make sure the diagnostics helpers exported from the
    // same file as the brand still work — guards against an accidental
    // re-export pruning.
    expect(
      isRepairable([{ code: "DUPLICATE_STEP_ID", severity: "error", message: "x" }]),
    ).toBe(true);
    expect(
      isRepairable([{ code: "UNKNOWN_AGENT", severity: "error", message: "x" }]),
    ).toBe(false);
  });
});

describe("compiled plan immutability", () => {
  it("appendStepsToCompiledPlan does not mutate the base", () => {
    const base = trustAsCompiled(makeValidPlan([makeValidStep("step-2")]));
    const beforeIds = base.steps.map((s) => s.id);
    appendStepsToCompiledPlan(base, [makeValidStep("step-3")]);
    expect(base.steps.map((s) => s.id)).toEqual(beforeIds);
  });
});
