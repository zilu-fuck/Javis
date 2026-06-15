/**
 * Commander plan schema — single source of truth.
 *
 * Every other surface that needs to know the shape of a Commander plan
 * (TS types, runtime structural validation, JSON Schema export, the
 * planner prompt) is derived from the Zod schemas in this file. Adding
 * a new step field is therefore a one-stop change: extend the Zod shape
 * here and the TS type, JSON Schema string, validator, and prompt will
 * pick it up automatically.
 *
 *  - `ToolRequiredInputShape` / `ToolInputShape` — derive the runtime
 *    shape of `ToolDescriptor.requiredInputs` so the same shape can be
 *    validated by Zod, mirrored in the validator, and surfaced in the
 *    planner prompt.
 *  - `CommanderDagStepShape` / `CommanderDagPlanShape` — the structural
 *    shape of a normalized plan. The validator's semantic rules
 *    (cycles, capability availability, etc.) live in
 *    `commander-plan-validator.ts`; this module only owns structure.
 *  - `PlanGenerationTraceShape` — the observable artifact written to
 *    `TaskSnapshot.planGenerationTrace`. Versioned via
 *    `PLAN_GENERATION_TRACE_SCHEMA_VERSION`.
 *  - `zodToPlanJsonSchema()` / `planShapeToPromptText()` — pure
 *    derivations, exported so tests can assert the output.
 */

import { z, toJSONSchema } from "zod";
import {
  CommanderPlanStepShape as ToolsCommanderPlanStep,
  CommanderPlanResultShape as ToolsCommanderPlanResult,
  AskUserChoiceShape as ToolsAskUserChoice,
  StepExecutionModeShape as ToolsStepExecutionMode,
} from "@javis/tools";

/** Bumped whenever the plan-generation-trace shape changes. */
export const PLAN_GENERATION_TRACE_SCHEMA_VERSION = "1.0.0";

/** Bumped whenever the commander plan shape changes. */
export const COMMANDER_PLAN_SCHEMA_VERSION = "1.0.0";

/**
 * Bumped whenever the planner prompt template text changes
 * (`COMMANDER_PLAN_SCHEMA_PROMPT` or the surrounding rule block in
 * `getCommanderPlanRules`). Persisted on `PlanGenerationTrace` so
 * post-mortem analytics can correlate plan success with prompt
 * version.
 */
export const COMMANDER_PLAN_PROMPT_VERSION = "1.0.0";

// --- Tool descriptor input shapes --------------------------------------------

export const ToolRequiredInputShape = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "string[]"]),
  nonEmpty: z.boolean().optional(),
});
export type ToolRequiredInputShapeT = z.infer<typeof ToolRequiredInputShape>;

/**
 * Zod schema for a complete `toolInput` object, derived from a list of
 * required input specs. Used by the planner prompt and plan compiler;
 * the runtime dispatch guard retains hand-written checks as defense in
 * depth. Tools with no required inputs get the empty object shape.
 */
export function buildToolInputShape(
  requiredInputs: ReadonlyArray<ToolRequiredInputShapeT> = [],
): z.ZodTypeAny {
  if (requiredInputs.length === 0) {
    return z.object({}).passthrough();
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const req of requiredInputs) {
    if (req.type === "string") {
      shape[req.name] = req.nonEmpty
        ? z.string().trim().min(1)
        : z.string();
    } else {
      // string[]
      const arr = req.nonEmpty
        ? z.array(z.string().trim().min(1)).min(1)
        : z.array(z.string());
      shape[req.name] = arr;
    }
  }
  return z.object(shape).passthrough();
}

// --- Commander plan shapes ---------------------------------------------------

/**
 * Step execution mode — re-exported from `@javis/tools` so the single Zod
 * source in the tools package is canonical. The tools package defines the
 * LLM-facing contract; this module uses it for the strict normalized shape.
 */
export const StepExecutionModeShape = ToolsStepExecutionMode;
export type StepExecutionModeT = z.infer<typeof StepExecutionModeShape>;

/**
 * Ask-user choice shape — re-exported from tools for the same reason.
 */
export const AskUserChoiceShape = ToolsAskUserChoice;

export const CommanderDagStepShape = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, "id must be kebab-case"),
  title: z.string().min(1),
  assignedAgentKind: z.string().min(1),
  toolName: z.string().optional(),
  capability: z.string().optional(),
  requiredCapabilities: z.array(z.string()),
  dependsOn: z.array(z.string()),
  inputContextKeys: z.array(z.string()).optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  outputContextKey: z.string().optional(),
  choices: z.array(z.union([z.string(), AskUserChoiceShape])).optional(),
  executionMode: StepExecutionModeShape.optional(),
  successCriteria: z.string().min(1),
});
export type CommanderDagStepT = z.infer<typeof CommanderDagStepShape>;

export const CommanderDagPlanShape = z.object({
  title: z.string().min(1).max(120),
  reasoning: z.string().min(1),
  steps: z.array(CommanderDagStepShape).min(1).max(12),
});
export type CommanderDagPlanT = z.infer<typeof CommanderDagPlanShape>;

// --- LLM raw output shape (CommanderPlanResult) -----------------------------
//
// The LLM-facing contract. Lives in `@javis/tools` as the canonical source;
// this module derives a partial variant so the normalizer can accept model
// output even when optional fields are omitted.
//
// Field names match the prompt schema exactly so the planner prompt + JSON
// Schema + this shape are always in sync.
export const CommanderPlanStepShape = ToolsCommanderPlanStep.partial();
export type CommanderPlanStepT = z.infer<typeof CommanderPlanStepShape>;

export const CommanderPlanResultShape = ToolsCommanderPlanResult.partial();
export type CommanderPlanResultT = z.infer<typeof CommanderPlanResultShape>;

// --- PlanGenerationTrace shape ----------------------------------------------

const PlanDiagnosticShape = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  path: z.string().optional(),
  stepId: z.string().optional(),
  message: z.string(),
  suggestedFix: z.string().optional(),
});

const PlanGenerationStageStatusShape = z.enum([
  "compiled",
  "compiled_with_warnings",
  "failed_repairable",
  "failed_non_repairable",
]);

const PlanGenerationStageRecordShape = z.object({
  stage: z.enum(["initial", "repair"]),
  attempt: z.number().int().positive(),
  status: PlanGenerationStageStatusShape,
  diagnostics: z.array(PlanDiagnosticShape),
  stepIds: z.array(z.string()),
  detail: z.string().optional(),
});

const PlanRecoveryCompileRecordShape = z.object({
  stage: z.literal("recovery"),
  attempt: z.number().int().positive(),
  failedStepId: z.string(),
  status: PlanGenerationStageStatusShape,
  diagnostics: z.array(PlanDiagnosticShape),
  stepIds: z.array(z.string()),
  detail: z.string().optional(),
});

export const PlanGenerationTraceShape = z.object({
  schemaVersion: z.literal(PLAN_GENERATION_TRACE_SCHEMA_VERSION),
  planSchemaVersion: z.literal(COMMANDER_PLAN_SCHEMA_VERSION),
  generatedAt: z.string(),
  userGoal: z.string(),
  initialCompiled: z.boolean(),
  repairAttemptCount: z.number().int().nonnegative(),
  stages: z.array(PlanGenerationStageRecordShape),
  recoveryCompiles: z.array(PlanRecoveryCompileRecordShape),
  /** Identifier of the planner prompt that produced this trace. */
  promptVersion: z.string().optional(),
  /** Raw model output JSON captured before normalization. Optional because the
   * trace may be assembled before the model output is available (e.g. on a
   * runtime failure that happens before the first plan call returns). */
  extractedJson: z.string().optional(),
  /** The post-normalize plan (post-defaulting). Captured once for the
   * initial plan; absent for repair / recovery stages where the
   * previous plan is preserved. */
  normalizedPlan: CommanderDagPlanShape.optional(),
});
export type PlanGenerationTraceT = z.infer<typeof PlanGenerationTraceShape>;

// --- Derivations -------------------------------------------------------------

/**
 * Convert the CommanderDagPlanShape Zod schema to a JSON Schema object
 * suitable for use as a validator contract or for `JSON.stringify` into
 * the planner prompt. The output is a plain object — callers decide
 * whether to stringify, send over the wire, or persist.
 */
export function zodToPlanJsonSchema(): Record<string, unknown> {
  return toJSONSchema(CommanderDagPlanShape) as Record<string, unknown>;
}

/** String form of `zodToPlanJsonSchema()` for transport. */
export function zodToPlanJsonSchemaString(): string {
  return JSON.stringify(zodToPlanJsonSchema());
}

/**
 * Compact prompt-shape text derived from the Zod schema. We don't dump
 * the full JSON Schema to the LLM (token cost) — instead we project to
 * a single-line "TypeScript-like" representation that lists the same
 * fields. The output mirrors the previous hand-written
 * `COMMANDER_PLAN_SCHEMA_PROMPT` shape but is now driven by the Zod
 * source. If a field is added to `CommanderDagStepShape` it shows up
 * here automatically.
 */
export function planShapeToPromptText(): string {
  const lines: string[] = [];
  lines.push("{title:string, reasoning:string, steps:Step[1..12]}");
  lines.push(
    "Step={"
      + "id:kebab-case, "
      + "title:string, "
      + "assignedAgentKind:string, "
      + "successCriteria:string, "
      + "requiredCapabilities?:string[], "
      + "capability?:string, "
      + "toolName?:string, "
      + "dependsOn?:string[], "
      + "inputContextKeys?:string[], "
      + "toolInput?:object, "
      + "outputContextKey?:string, "
      + "choices?:(string|{label,value,isRecommended?})[], "
      + "executionMode?:direct_response|direct_tool_call|react"
      + "}",
  );
  return lines.join("\n");
}

// --- Prompt examples (the "Prompt examples compile" contract) ---------------
//
// The examples below are embedded in the planner prompt text
// (see `getCommanderPlanRules` in commander-plan-schema.ts) and are
// also exported as stable JSON objects so the contract test surface can
// assert that they:
//
//   1. parse through `CommanderDagPlanShape` (Zod, single source of truth),
//   2. compile through `compileCommanderPlan` without errors,
//   3. produce a stable JSON snapshot the project can lock in.
//
// If you change either example, update the snapshot test alongside it.

/**
 * Tiny clarification example. Mirrors the string embedded in
 * `getCommanderPlanRules` (en + zh). The model is expected to use this
 * shape whenever it needs to ask the user one blocking question before
 * planning the rest of the work.
 */
export const COMMANDER_PLAN_PROMPT_EXAMPLE: CommanderDagPlanT = {
  title: "Clarify",
  reasoning: "Need target path.",
  steps: [
    {
      id: "clarify-path",
      title: "Which folder should I use?",
      assignedAgentKind: "commander",
      capability: "clarification",
      requiredCapabilities: [],
      dependsOn: [],
      choices: ["Current workspace", "Pick another folder"],
      successCriteria: "User chose a folder.",
    },
  ],
};

/**
 * A more complete synthetic plan that exercises every optional step
 * field (toolName, requiredCapabilities, dependsOn, inputContextKeys,
 * toolInput, outputContextKey, executionMode). Used as the snapshot
 * source for the "Prompt examples compile" contract test.
 */
export const COMMANDER_PLAN_PROMPT_EXAMPLE_FULL: CommanderDagPlanT = {
  title: "Search the repo and summarize the result",
  reasoning:
    "We need a focused repo search and a one-line summary written for the user.",
  steps: [
    {
      id: "search-code",
      title: "Search the repo for the requested change",
      assignedAgentKind: "code",
      toolName: "code.searchRepository",
      requiredCapabilities: ["code_search"],
      dependsOn: [],
      toolInput: { goal: "find launch code" },
      outputContextKey: "repoEvidence",
      successCriteria: "Repository search returns matching files.",
    },
    {
      id: "summarize",
      title: "Summarize the evidence for the user",
      assignedAgentKind: "commander",
      toolName: "commander.synthesize",
      requiredCapabilities: ["synthesis"],
      dependsOn: ["search-code"],
      inputContextKeys: ["repoEvidence"],
      outputContextKey: "summary",
      executionMode: "direct_response",
      successCriteria: "Summary names the files and what they do.",
    },
  ],
};
