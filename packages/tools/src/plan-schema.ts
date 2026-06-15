/**
 * Commander plan LLM-raw contract — single source for @javis/tools.
 *
 * The shape here describes what the model is asked to produce, before
 * the core planner normalizes defaults. The normalized, stricter
 * shape (`CommanderDagPlanShape` / `CommanderDagStepShape`) lives in
 * `@javis/core/src/planning/schema.ts`. The two shapes are mirrored
 * in a contract test (see `core/src/planning/__tests__/llm-raw-shape.test.ts`)
 * so a field added to one is caught on the other.
 *
 * Field rules:
 *  - top-level: title / reasoning / steps are required (the model is
 *    expected to produce them; downstream normalizers also tolerate
 *    omissions defensively but the contract is "produce all three").
 *  - step: id / title / assignedAgentKind / successCriteria are
 *    required; everything else is optional because the model is
 *    allowed to leave them blank when not relevant.
 *  - executionMode is an enum: direct_response | direct_tool_call | react.
 *  - id is NOT constrained to kebab-case here. The strict shape in
 *    core does the constraint; the model is allowed to produce
 *    anything and the strict validator will reject bad ids.
 */

import { z } from "zod";

/** Bumped whenever this shape changes. */
export const COMMANDER_PLAN_RESULT_SCHEMA_VERSION = "1.0.0";

export const StepExecutionModeShape = z.enum([
  "direct_response",
  "direct_tool_call",
  "react",
]);
export type StepExecutionModeT = z.infer<typeof StepExecutionModeShape>;

export const AskUserChoiceShape = z.object({
  label: z.string(),
  value: z.string(),
  isRecommended: z.boolean().optional(),
});
export type AskUserChoiceT = z.infer<typeof AskUserChoiceShape>;

export const CommanderPlanStepShape = z.object({
  id: z.string(),
  title: z.string(),
  assignedAgentKind: z.string(),
  toolName: z.string().optional(),
  capability: z.string().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  inputContextKeys: z.array(z.string()).optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  outputContextKey: z.string().optional(),
  choices: z.array(z.union([z.string(), AskUserChoiceShape])).optional(),
  executionMode: StepExecutionModeShape.optional(),
  successCriteria: z.string(),
});
export type CommanderPlanStep = z.infer<typeof CommanderPlanStepShape>;
/** Alias kept for back-compat with the prior hand-written interface. */
export type CommanderPlanStepT = CommanderPlanStep;

export const CommanderPlanResultShape = z.object({
  title: z.string(),
  reasoning: z.string(),
  steps: z.array(CommanderPlanStepShape),
});
export type CommanderPlanResult = z.infer<typeof CommanderPlanResultShape>;
/** Alias kept for back-compat with the prior hand-written interface. */
export type CommanderPlanResultT = CommanderPlanResult;
