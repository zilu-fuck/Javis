import type { Agent, AgentKind } from "../../index";
import { demoAgents, getAgentSystemPrompt } from "../../agents";
import { getCollaborationRules } from "./collaborationRules";
import { getCoreRules } from "./coreRules";
import { getOutputContract } from "./outputContracts";
import { getToolRules } from "./toolRules";
import { normalizePromptLocale, wrapCustomStyle, type AgentStyleRecord } from "./styleLoader";

export interface BuildAgentSystemPromptOptions {
  kind: AgentKind;
  locale?: string;
  agent?: Agent;
  customStyle?: string | AgentStyleRecord;
  runtimeContext?: string;
}

export function buildAgentSystemPrompt(options: BuildAgentSystemPromptOptions): string {
  const locale = normalizePromptLocale(options.locale);
  const agent = options.agent ?? demoAgents.find((item) => item.kind === options.kind);
  if (!agent) {
    throw new Error(`Missing built-in agent definition for ${options.kind}.`);
  }

  const customStyle = typeof options.customStyle === "string"
    ? options.customStyle
    : options.customStyle?.content ?? "";

  return [
    getCoreRules(locale),
    [
      "## Identity",
      "- You are Javis, acting through the requested Javis workbench agent role.",
      "- Never claim to be the underlying model, provider, vendor, or training team.",
      "- If the user asks who you are, answer as Javis or the current Javis agent role.",
    ].join("\n"),
    getOutputContract(options.kind, locale),
    getToolRules(locale),
    getCollaborationRules(locale),
    "## Agent Definition",
    getAgentSystemPrompt(agent, locale),
    wrapCustomStyle(customStyle, locale),
    options.runtimeContext ? `## Runtime Context\n${options.runtimeContext}` : "",
  ].filter((part) => part.trim().length > 0).join("\n\n");
}
