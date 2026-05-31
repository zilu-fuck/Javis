import type { AgentReActObservation } from "./agent-react-loop";

export interface ReActDecisionRequest {
  agentKind: string;
  stepId: string;
  stepTitle: string;
  userGoal: string;
  /** Commander's success criteria for this step — guides the ReAct LLM on when to declare completion. */
  successCriteria?: string;
  /** Primary capability tag for this step — tells the ReAct LLM which tool category is expected. */
  capability?: string;
  observations: AgentReActObservation[];
  availableTools: Array<{
    name: string;
    summary: string;
    capabilityTags: string[];
  }>;
}

/** JSON Schema for the ReAct decision LLM output. */
const REACT_DECISION_SCHEMA = JSON.stringify({
  type: "object",
  required: ["status", "reason"],
  properties: {
    status: {
      type: "string",
      enum: ["continue", "completed", "failed"],
      description: "continue=take another action, completed=step is done, failed=step cannot be completed",
    },
    toolName: {
      type: "string",
      description: "Required when status=continue. The tool name to invoke next.",
    },
    reason: {
      type: "string",
      description: "Why this decision was made. For continue: what you hope to learn. For completed: what was accomplished. For failed: why it can't proceed.",
    },
    output: {
      description: "When status=completed: the final output of this step as a JSON value. When status=failed: error description.",
    },
  },
});

/**
 * Build the ReAct decision prompt sent to the LLM on each iteration.
 */
export function buildReActDecisionPrompt(request: ReActDecisionRequest): string {
  const observationLines = request.observations.length === 0
    ? ["(no prior observations — this is the first action)"]
    : request.observations.map((obs, i) => {
        const errorPart = obs.error ? ` | Error: ${obs.error}` : "";
        const outputPart = obs.status === "succeeded"
          ? `\n    Output: ${JSON.stringify(obs.output)}`
          : "";
        return `[${i + 1}] Tool: ${obs.toolName} | Status: ${obs.status}${errorPart}${outputPart}`;
      });

  return [
    "You are a ReAct decision agent. Decide the next action for the current step.",
    "Return ONLY a JSON object matching this schema:",
    REACT_DECISION_SCHEMA,
    "",
    "Rules:",
    "- Chosen toolName MUST be one of the Available tools listed below.",
    "- If prior observations already satisfy the step goal, return status=completed with a summary output.",
    "- If a tool failed, try an alternative approach or a different tool before giving up.",
    "- If all reasonable approaches have been tried and failed, return status=failed.",
    "- Prefer read-only tools. Only use write tools when the step explicitly requires producing output.",
    "- Observe results carefully — if a search returned nothing, try different keywords before failing.",
    "",
    `User goal: ${request.userGoal}`,
    `Current step: ${request.stepId} — ${request.stepTitle}`,
    `Agent: ${request.agentKind}`,
    `Success criteria: ${request.successCriteria ?? "Step completed with evidence."}`,
    `Primary capability: ${request.capability ?? "general"}`,
    "",
    "Prior observations:",
    ...observationLines,
    "",
    `Available tools: ${JSON.stringify(request.availableTools)}`,
  ].join("\n");
}
