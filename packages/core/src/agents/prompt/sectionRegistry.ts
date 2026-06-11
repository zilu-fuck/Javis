import type { AgentKind } from "../../index";

export type PromptSectionScope = "global" | "agent_only" | "opt_in";

export interface PromptSectionDefinition {
  key: string;
  scope: PromptSectionScope;
  agentKinds?: readonly AgentKind[];
}

export const AGENT_SYSTEM_PROMPT_SECTION_ORDER = [
  "core",
  "identity",
  "output_contract",
  "tool_rules",
  "collaboration",
  "ui_design_rules",
  "agent_definition",
  "custom_style",
  "runtime_context",
] as const;

export const PROMPT_SECTION_REGISTRY: readonly PromptSectionDefinition[] = [
  { key: "core", scope: "global" },
  { key: "identity", scope: "global" },
  { key: "output_contract", scope: "global" },
  { key: "tool_rules", scope: "global" },
  { key: "collaboration", scope: "global" },
  { key: "ui_design_rules", scope: "opt_in" },
  { key: "agent_definition", scope: "agent_only" },
  { key: "custom_style", scope: "opt_in" },
  { key: "runtime_context", scope: "opt_in" },
  { key: "research_evidence_schema", scope: "agent_only", agentKinds: ["research"] },
  { key: "browser_origin_policy", scope: "agent_only", agentKinds: ["browser"] },
  { key: "code_verification_report", scope: "agent_only", agentKinds: ["code"] },
] as const;

export function getPromptSectionDefinition(key: string): PromptSectionDefinition | undefined {
  return PROMPT_SECTION_REGISTRY.find((section) => section.key === key);
}
