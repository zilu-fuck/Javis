/**
 * "Prompt examples compile" contract test surface.
 *
 * Every example embedded in the planner prompt text must:
 *   1. parse through the Zod-derived `CommanderDagPlanShape`
 *      (single source of truth in ./schema.ts),
 *   2. compile through `compileCommanderPlan` without errors when the
 *      test fixture provides the right agents + tools,
 *   3. produce a stable JSON snapshot the project can lock in.
 *
 * If a future change to the prompt drops or restructures an example,
 * one of these tests will fail. That is the point.
 */

import { describe, expect, it } from "vitest";
import {
  buildCommanderPlanPrompt,
  COMMANDER_PLAN_PROMPT_EXAMPLE,
  COMMANDER_PLAN_PROMPT_EXAMPLE_FULL,
  COMMANDER_PLAN_SCHEMA_PROMPT,
  COMMANDER_PLAN_SCHEMA_VERSION,
  type CommanderDagPlan,
} from "../../commander-plan-schema";
import { compileCommanderPlan, type CompileCommanderPlanInput } from "../commander-plan-compiler";
import {
  CommanderDagPlanShape,
  zodToPlanJsonSchema,
} from "../schema";
import type { ToolDescriptor } from "@javis/tools";

function makeToolDescriptor(
  name: string,
  overrides: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    name,
    permissionLevel: "read",
    summary: `Tool: ${name}`,
    capabilityTags: [],
    ownerAgentKinds: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<CompileCommanderPlanInput> & { plan: CommanderDagPlan }): CompileCommanderPlanInput {
  return {
    availableAgents: [
      { kind: "commander", allowedToolNames: ["commander.synthesize"], capabilities: ["synthesis", "clarification"] },
      { kind: "code", allowedToolNames: ["code.searchRepository"], capabilities: ["code_search"] },
      { kind: "verifier", allowedToolNames: ["verifier.check"], capabilities: ["evidence_check"] },
    ],
    availableTools: [
      makeToolDescriptor("commander.synthesize", { capabilityTags: ["synthesis"], ownerAgentKinds: ["commander"] }),
      makeToolDescriptor("code.searchRepository", { capabilityTags: ["code_search"], ownerAgentKinds: ["code"] }),
      makeToolDescriptor("verifier.check", { capabilityTags: ["evidence_check"], ownerAgentKinds: ["verifier"] }),
    ],
    supportedApprovalGatedTools: [],
    preloadedContextKeys: ["userGoal", "taskId"],
    ...overrides,
  };
}

describe("Prompt examples compile", () => {
  it("the tiny clarification example parses through the Zod shape", () => {
    const parsed = CommanderDagPlanShape.safeParse(COMMANDER_PLAN_PROMPT_EXAMPLE);
    expect(parsed.success).toBe(true);
  });

  it("the tiny clarification example compiles cleanly", () => {
    const result = compileCommanderPlan(
      makeInput({ plan: COMMANDER_PLAN_PROMPT_EXAMPLE as unknown as CommanderDagPlan }),
    );
    expect(result.ok).toBe(true);
  });

  it("the full synthetic example parses through the Zod shape", () => {
    const parsed = CommanderDagPlanShape.safeParse(COMMANDER_PLAN_PROMPT_EXAMPLE_FULL);
    expect(parsed.success).toBe(true);
  });

  it("the full synthetic example compiles cleanly", () => {
    const result = compileCommanderPlan(
      makeInput({ plan: COMMANDER_PLAN_PROMPT_EXAMPLE_FULL as unknown as CommanderDagPlan }),
    );
    expect(result.ok).toBe(true);
  });

  it("the prompt text embeds the clarification example verbatim (no drift)", () => {
    // If a future change edits the rules text without updating the
    // exported example, this test fires. The prompt shape and the
    // exported example are derived from the same Zod source, so they
    // cannot drift unless one is hand-edited.
    const compact = JSON.stringify(COMMANDER_PLAN_PROMPT_EXAMPLE);
    const fullPrompt = buildCommanderPlanPrompt({
      userGoal: "List a directory",
      workflowId: "test",
      availableAgents: [],
    });
    expect(fullPrompt).toContain(compact);
    // And the schema shape is part of the prompt too.
    expect(fullPrompt).toContain(COMMANDER_PLAN_SCHEMA_PROMPT);
  });

  it("the JSON Schema derived from Zod is stable", () => {
    // Snapshot the JSON Schema so a future contributor who adds a new
    // field to CommanderDagStepShape sees exactly which downstream
    // consumers (validators, prompts, runtime guards) need updating.
    const json = JSON.stringify(zodToPlanJsonSchema());
    expect(json).toMatchSnapshot();
  });

  it("the schema version is declared and matches the snapshot", () => {
    expect(COMMANDER_PLAN_SCHEMA_VERSION).toBe("1.0.0");
  });
});
