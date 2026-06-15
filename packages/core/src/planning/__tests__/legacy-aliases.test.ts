/**
 * Contract test: legacy CommanderDagStep / CommanderDagPlan /
 * StepExecutionMode aliases stay identical to the Zod-derived types.
 *
 * The legacy names in `@javis/core/src/commander-plan-schema.ts`
 * are now `type` aliases of the Zod-derived `CommanderDagStepT` /
 * `CommanderDagPlanT` / `StepExecutionModeT`. This contract pins
 * the equivalence so a future refactor that breaks the alias (e.g.
 * re-introduces a hand-written interface) fails the test.
 *
 * The test uses TS structural assignability:
 *  - A value of the legacy type must be assignable to the Zod type
 *    (so downstream code that uses the Zod name accepts the legacy).
 *  - A value of the Zod type must be assignable to the legacy type
 *    (so the alias doesn't narrow the type).
 *  - For string-literal unions (StepExecutionMode), each literal of
 *    the legacy type must exist in the Zod-derived union.
 */

import { describe, expect, it } from "vitest";
import type {
  CommanderDagPlan,
  CommanderDagStep,
  StepExecutionMode,
} from "../../commander-plan-schema";
import type {
  CommanderDagPlanT,
  CommanderDagStepT,
  StepExecutionModeT,
} from "../schema";

describe("legacy CommanderDagStep / CommanderDagPlan aliases", () => {
  it("legacy CommanderDagStep is assignable to CommanderDagStepT", () => {
    // A value typed as the legacy alias must be assignable to the
    // Zod-derived type. This catches any future refactor that
    // re-introduces a hand-written interface narrower than the
    // Zod shape.
    const legacy: CommanderDagStep = {} as CommanderDagStep;
    const zod: CommanderDagStepT = legacy;
    expect(zod).toBeDefined();
  });

  it("CommanderDagStepT is assignable to the legacy CommanderDagStep alias", () => {
    // Reverse direction: the alias must not narrow the Zod-derived
    // shape. If a future refactor changes the alias to a narrower
    // hand-written type, this fails.
    const zod: CommanderDagStepT = {} as CommanderDagStepT;
    const legacy: CommanderDagStep = zod;
    expect(legacy).toBeDefined();
  });

  it("legacy CommanderDagPlan is assignable to CommanderDagPlanT and vice versa", () => {
    const legacyAsZod: CommanderDagPlanT = {} as CommanderDagPlan;
    const zodAsLegacy: CommanderDagPlan = {} as CommanderDagPlanT;
    expect(legacyAsZod).toBeDefined();
    expect(zodAsLegacy).toBeDefined();
  });

  it("legacy StepExecutionMode matches the Zod-derived literal union", () => {
    // String-literal union equivalence: each value of the legacy
    // union must be assignable to the Zod-derived union, and vice
    // versa. The compile-time assignment is the actual contract;
    // we sanity-check that the literals are what we expect.
    const legacyValues: StepExecutionMode[] = [
      "direct_response",
      "direct_tool_call",
      "react",
    ];
    const zodValues: StepExecutionModeT[] = [
      "direct_response",
      "direct_tool_call",
      "react",
    ];
    expect(legacyValues).toEqual(zodValues);
  });
});
