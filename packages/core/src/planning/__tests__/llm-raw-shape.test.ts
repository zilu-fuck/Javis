/**
 * Contract test: LLM-raw CommanderPlanResult ↔ strict CommanderDagPlan.
 *
 * The Commander pipeline has two distinct shapes:
 *
 *  1. LLM-raw shape — what the model is asked to produce. Lives in
 *     `@javis/tools/src/plan-schema.ts` as `CommanderPlanResultShape`.
 *     Optional-everywhere (the model is allowed to omit fields; the
 *     planner normalizer supplies defaults).
 *
 *  2. Strict shape — what the validator compiles. Lives in
 *     `@javis/core/src/planning/schema.ts` as `CommanderDagPlanShape`.
 *     Required-everywhere (post-normalize, pre-execute).
 *
 * A drift between the two surfaces causes:
 *  - LLM outputs that the planner prompt claims are valid get
 *    rejected by the normalizer (false-negative);
 *  - LLM outputs the normalizer accepts but the strict validator
 *    rejects at compile time (wasted repair attempts).
 *
 * This test pins the contract:
 *  - The LLM-raw Zod shape is a permissive subset of the strict
 *    Zod shape: every required field in the strict shape has a
 *    same-name field in the LLM-raw shape, and the LLM-raw shape
 *    is a superset of optional fields.
 *  - A hand-written "fully populated LLM raw output" parses through
 *    the LLM-raw Zod shape (proving the field names are correct).
 *  - After defaulting, that same LLM raw output parses through
 *    the strict Zod shape (proving the bridge is sound).
 */

import { describe, expect, it } from "vitest";
import { CommanderPlanResultShape, type CommanderPlanResult } from "@javis/tools";
import { CommanderDagPlanShape, CommanderDagStepShape } from "../schema";

const LLM_RAW_FIELDS = new Set(
  Object.keys(CommanderPlanResultShape.shape.steps.element.shape),
);

const STRICT_STEP_FIELDS = new Set(
  Object.keys(CommanderDagStepShape.shape),
);

describe("LLM-raw ↔ strict shape contract", () => {
  it("LLM-raw Zod shape is a permissive superset of the strict step fields", () => {
    // Every field the strict shape requires must exist in the
    // LLM-raw shape (permissive = optional on the LLM side).
    for (const field of STRICT_STEP_FIELDS) {
      expect(
        LLM_RAW_FIELDS.has(field),
        `strict field "${field}" missing from LLM-raw shape`,
      ).toBe(true);
    }
  });

  it("LLM-raw Zod shape is a structural superset of the strict step fields", () => {
    // LLM-raw may have additional fields the strict shape doesn't
    // know about (forward compat), but the overlap must be exact.
    // (We don't constrain LLM-raw to be a subset — extra fields are
    // allowed so the LLM can experiment without breaking the
    // contract.)
    const intersection = [...LLM_RAW_FIELDS].filter((f) =>
      STRICT_STEP_FIELDS.has(f),
    );
    const union = new Set([...LLM_RAW_FIELDS, ...STRICT_STEP_FIELDS]);
    expect(intersection.length).toBe(STRICT_STEP_FIELDS.size);
    // Sanity: union is non-empty.
    expect(union.size).toBeGreaterThan(0);
  });

  it("LLM-raw Zod shape is permissive: optional fields can be omitted", () => {
    // LLM-raw is "permissive" in the sense that the optional fields
    // (everything except the planner-controlled required set) can
    // be omitted. The required set is the model contract: the
    // planner prompt asks for {title, reasoning, steps[]} at the
    // top level and {id, title, assignedAgentKind, successCriteria}
    // per step. This test pins the required-set and the optional
    // fields' optionality.
    const topShape = CommanderPlanResultShape.shape as unknown as Record<string, unknown>;
    const requiredTopLevel = ["title", "reasoning", "steps"];
    for (const field of requiredTopLevel) {
      expect(
        topShape[field],
        `top-level required field "${field}" missing from LLM-raw shape`,
      ).toBeDefined();
    }
    const stepShape = CommanderPlanResultShape.shape.steps.element.shape as unknown as Record<string, unknown>;
    const requiredStep = ["id", "title", "assignedAgentKind", "successCriteria"];
    for (const field of requiredStep) {
      expect(
        stepShape[field],
        `step required field "${field}" missing from LLM-raw shape`,
      ).toBeDefined();
    }
    // The optional fields are non-required; safeParse should
    // accept a step that omits them.
    const minimalStep = CommanderPlanResultShape.shape.steps.element.safeParse({
      id: "x",
      title: "t",
      assignedAgentKind: "commander",
      successCriteria: "ok",
    });
    expect(minimalStep.success).toBe(true);
  });

  it("strict Zod shape rejects a permissive LLM-raw output (sanity check)", () => {
    // The strict shape is the compile-gate contract. An LLM raw
    // output that omits required fields must NOT pass — that's the
    // normalizer's job to fill in.
    const llmRaw: Partial<CommanderPlanResult> = {
      title: "x",
      reasoning: "y",
      steps: [
        {
          id: "step-1",
          title: "step",
          assignedAgentKind: "commander",
          successCriteria: "ok",
        },
      ],
    };
    const strictResult = CommanderDagPlanShape.safeParse(llmRaw);
    // The LLM-raw shape is missing `requiredCapabilities` and
    // `dependsOn` (required by the strict shape), so the strict
    // parse must fail. This is the gap the normalizer bridges.
    expect(strictResult.success).toBe(false);
  });

  it("a hand-written fully populated LLM-raw output parses cleanly", () => {
    // Pin the LLM-raw contract with a concrete example that
    // exercises every field, including the optional ones.
    const llmRaw: CommanderPlanResult = {
      title: "Do the thing",
      reasoning: "I will do the thing.",
      steps: [
        {
          id: "step-1",
          title: "First step",
          assignedAgentKind: "commander",
          toolName: "commander.synthesize",
          capability: "synthesis",
          requiredCapabilities: ["synthesis"],
          dependsOn: [],
          inputContextKeys: ["userGoal"],
          toolInput: { foo: "bar" },
          outputContextKey: "evidence",
          choices: ["yes", "no"],
          executionMode: "direct_response",
          successCriteria: "Done.",
        },
      ],
    };
    const result = CommanderPlanResultShape.safeParse(llmRaw);
    if (!result.success) {
      // Surface the issues so the failure is debuggable.
      throw new Error(
        `LLM-raw shape rejected a fully populated input: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("after defaulting, an LLM-raw output passes the strict Zod shape", () => {
    // The normalizer (commander-plan-repair.normalizeResultToDagPlan)
    // is responsible for filling in defaults so the strict validator
    // accepts the plan. This test pins that the bridge is sound:
    // take an LLM-raw output with optional fields omitted, apply
    // the same defaulting rules the normalizer does, and verify the
    // strict shape accepts the result.
    const llmRaw: CommanderPlanResult = {
      title: "Minimal",
      reasoning: "Tiny plan.",
      steps: [
        {
          id: "step-1",
          title: "Single step",
          assignedAgentKind: "commander",
          successCriteria: "Done.",
          // requiredCapabilities and dependsOn intentionally omitted.
        },
      ],
    };
    // Mirror the normalizer's defaulting rules.
    const normalized = {
      title: llmRaw.title,
      reasoning: llmRaw.reasoning,
      steps: llmRaw.steps.map((step) => ({
        ...step,
        requiredCapabilities: step.requiredCapabilities ?? [],
        dependsOn: step.dependsOn ?? [],
      })),
    };
    const strictResult = CommanderDagPlanShape.safeParse(normalized);
    if (!strictResult.success) {
      throw new Error(
        `strict shape rejected a normalized LLM-raw output: ${JSON.stringify(strictResult.error.issues, null, 2)}`,
      );
    }
    expect(strictResult.success).toBe(true);
  });
});
