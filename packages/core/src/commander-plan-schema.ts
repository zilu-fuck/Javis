import type { AgentCapabilityTag } from "./agent-capability";

/**
 * Commander Plan JSON Schema — strict structural contract for LLM output.
 *
 * The Commander must return a JSON object matching this schema.
 * `normalizeCommanderPlan` in the desktop app performs runtime validation
 * with permissive defaults for missing fields.
 */

export interface CommanderDagStep {
  id: string;
  title: string;
  assignedAgentKind: string;
  toolName?: string;
  /** Primary capability tag for capability-based dispatch. */
  capability?: AgentCapabilityTag;
  requiredCapabilities: string[];
  /** Step IDs this step must wait for before executing. Empty array = can run immediately. */
  dependsOn: string[];
  /** SharedContext keys to read as input for this step. */
  inputContextKeys?: string[];
  /** SharedContext key to write the step's output to. */
  outputContextKey?: string;
  successCriteria: string;
}

export interface CommanderDagPlan {
  title: string;
  reasoning: string;
  steps: CommanderDagStep[];
}

/** JSON Schema injected into the Commander's system prompt. */
export const COMMANDER_PLAN_SCHEMA_JSON = JSON.stringify({
  type: "object",
  required: ["title", "reasoning", "steps"],
  properties: {
    title: {
      type: "string",
      description: "Short title summarizing the plan (max 120 chars)",
      maxLength: 120,
    },
    reasoning: {
      type: "string",
      description: "Why these steps were chosen and how they satisfy the user's goal",
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["id", "title", "assignedAgentKind", "successCriteria"],
        properties: {
          id: {
            type: "string",
            description: "Unique kebab-case step identifier (e.g. 'search-github')",
            pattern: "^[a-z][a-z0-9-]*[a-z0-9]$",
          },
          title: {
            type: "string",
            description: "Human-readable step description",
          },
          assignedAgentKind: {
            type: "string",
            description: "Agent kind that should execute this step",
          },
          toolName: {
            type: "string",
            description: "Optional concrete tool name selected for this step. Must belong to assignedAgentKind and appear in that agent's allowedToolNames.",
          },
          requiredCapabilities: {
            type: "array",
            description: "Capability tags this step requires from the agent",
            items: { type: "string" },
          },
          capability: {
            type: "string",
            description: "Primary capability tag for tool dispatch (e.g. 'web_search', 'file_scan')",
          },
          dependsOn: {
            type: "array",
            description: "Step IDs that must complete before this step starts",
            items: { type: "string" },
          },
          inputContextKeys: {
            type: "array",
            description: "SharedContext keys to read as input for this step",
            items: { type: "string" },
          },
          outputContextKey: {
            type: "string",
            description: "SharedContext key to write the step's result to for downstream steps",
          },
          successCriteria: {
            type: "string",
            description: "How to verify this step completed successfully",
          },
        },
      },
    },
  },
});

/**
 * Build the Commander plan prompt with schema and available agents.
 * Injected into the prompt before the user goal.
 */
export function buildCommanderPlanPrompt(params: {
  userGoal: string;
  workflowId: string;
  availableAgents: Array<{
    kind: string;
    allowedToolNames: string[];
    capabilities: readonly string[];
  }>;
  availableTools?: Array<{
    name: string;
    permissionLevel: string;
    summary: string;
    capabilityTags: string[];
    ownerAgentKinds: string[];
  }>;
}): string {
  return [
    "You are Javis Commander Agent. Return ONLY a JSON object — no markdown, no explanation.",
    "Output must match this JSON Schema:",
    COMMANDER_PLAN_SCHEMA_JSON,
    "",
    "Rules:",
    "- steps[].id must be kebab-case and unique within the plan.",
    "- steps[].dependsOn lists step IDs this step waits for. Use [] for the first step(s).",
    "- steps[].capability MUST be set to the primary capability tag this step fulfills (from the available tools' capabilityTags). Every non-Commander step MUST include capability or requiredCapabilities so the executor can dispatch the correct tool.",
    "- steps[].inputContextKeys lists SharedContext keys this step reads from upstream steps' outputs.",
    "- steps[].outputContextKey is the SharedContext key where this step's result will be stored for downstream steps.",
    "- steps[].assignedAgentKind must match one of the Available agents' kind values.",
    "- steps[].toolName is optional, but when present it must be one of assignedAgentKind.allowedToolNames.",
    "- When the user goal is ambiguous (missing path, unclear scope, multiple valid interpretations), DO NOT guess. Instead, add a step with assignedAgentKind=commander and toolName=commander.askUser BEFORE any other steps, and stop the plan there. The user's answer will be available in SharedContext for re-planning.",
    "- Prefer read-only steps before write steps. Group independent steps together.",
    "- Each step's capability tag determines which tool is invoked. Choose from capabilityTags in the tools list below.",
    "",
    `User goal: ${params.userGoal}`,
    `Workflow id: ${params.workflowId}`,
    `Available agents: ${JSON.stringify(params.availableAgents)}`,
    `Available tools: ${JSON.stringify(params.availableTools ?? [])}`,
  ].join("\n");
}

/**
 * Build a Commander re-plan prompt after a step failure.
 * The Commander must produce recovery steps that work around the failure.
 */
export function buildCommanderReplanPrompt(params: {
  userGoal: string;
  contextSnapshot: Record<string, unknown>;
  failedStepId?: string;
  failureReason?: string;
  availableAgents: Array<{
    kind: string;
    allowedToolNames: string[];
    capabilities: readonly string[];
  }>;
  availableTools?: Array<{
    name: string;
    permissionLevel: string;
    summary: string;
    capabilityTags: string[];
    ownerAgentKinds: string[];
  }>;
}): string {
  const failureContext = params.failedStepId
    ? [
        `Failed step: ${params.failedStepId}`,
        `Failure reason: ${params.failureReason ?? "unknown error"}`,
        "",
        "Recovery rules:",
        "- Do NOT re-attempt the exact same step with the same parameters — it will fail again.",
        "- Try an ALTERNATIVE approach: use a different tool, different search terms, or a different data source.",
        "- If the failed step has no alternative, produce a 'record-failure' step that documents the gap.",
        "- Recovery steps should depend on already-completed steps (use completed step IDs as dependsOn).",
        "- Degrade gracefully: partial results are better than total failure.",
      ]
    : [
        "This is a clarification re-plan. The user provided additional context.",
        "Generate a new plan that incorporates the clarification.",
      ];

  return [
    "You are Javis Commander Agent. Return ONLY a JSON object — no markdown, no explanation.",
    `Output must match this JSON Schema:`,
    COMMANDER_PLAN_SCHEMA_JSON,
    "",
    ...failureContext,
    "",
    "Context from completed steps:",
    JSON.stringify(params.contextSnapshot),
    "",
    `User goal: ${params.userGoal}`,
    `Available agents: ${JSON.stringify(params.availableAgents)}`,
    `Available tools: ${JSON.stringify(params.availableTools ?? [])}`,
  ].join("\n");
}
