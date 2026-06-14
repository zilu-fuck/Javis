import type { Agent, AgentKind } from "../../index";
import { demoAgents, getAgentSystemPrompt } from "../../agents";
import { getCollaborationRules } from "./collaborationRules";
import { getCoreRules } from "./coreRules";
import { getOutputContract } from "./outputContracts";
import { getToolRules } from "./toolRules";
import { getUiGenerationDesignRules } from "./uiDesignRules";
import { AGENT_SYSTEM_PROMPT_SECTION_ORDER } from "./sectionRegistry";
import { normalizePromptLocale, wrapCustomStyle, type AgentPromptLocale, type AgentStyleRecord } from "./styleLoader";

export interface BuildAgentSystemPromptOptions {
  kind: AgentKind;
  locale?: string;
  agent?: Agent;
  customStyle?: string | AgentStyleRecord;
  runtimeContext?: string;
  workspaceProfile?: WorkspacePromptProfile;
  includeUiDesignRules?: boolean;
}

export interface WorkspacePromptProfile {
  workspacePath?: string;
  type: string;
  signals: string[];
  guidance?: string;
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

  const sections: Record<(typeof AGENT_SYSTEM_PROMPT_SECTION_ORDER)[number], string> = {
    core: getCoreRules(locale),
    identity: getIdentityRules(locale),
    output_contract: getOutputContract(options.kind, locale),
    tool_rules: getToolRules(locale),
    collaboration: getCollaborationRules(locale),
    ui_design_rules: options.includeUiDesignRules ? getUiGenerationDesignRules(locale) : "",
    agent_definition: [`## ${sectionTitle(locale, "Agent Definition", "Agent 定义")}`, getAgentSystemPrompt(agent, locale)].join("\n"),
    workspace_profile: formatWorkspaceProfile(options.workspaceProfile, locale),
    custom_style: wrapCustomStyle(customStyle, locale),
    runtime_context: options.runtimeContext ? `## ${sectionTitle(locale, "Runtime Context", "运行时上下文")}\n${options.runtimeContext}` : "",
  };

  return AGENT_SYSTEM_PROMPT_SECTION_ORDER
    .map((key) => sections[key])
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function getIdentityRules(locale: AgentPromptLocale): string {
  if (locale === "zhCN") {
    return [
      "## 身份",
      "- 你是 Javis，正在以请求的 workbench Agent 角色行动。",
      "- 不要声称自己是底层模型、供应商或训练团队；被问及时，以 Javis 或当前 Javis Agent 的身份回答。",
    ].join("\n");
  }

  return [
    "## Identity",
    "- You are Javis acting through the requested workbench agent role.",
    "- Never claim to be the underlying model/provider/vendor/training team; if asked, answer as Javis or the current Javis agent.",
  ].join("\n");
}

function formatWorkspaceProfile(
  profile: WorkspacePromptProfile | undefined,
  locale: AgentPromptLocale,
): string {
  if (!profile || (!profile.type.trim() && profile.signals.length === 0)) {
    return "";
  }
  const lines = [
    `## ${sectionTitle(locale, "Workspace Profile", "Workspace Profile")}`,
    `- Workspace path: ${profile.workspacePath?.trim() || "(unknown)"}`,
    `- Workspace type: ${profile.type || "unknown"}`,
    `- Signals: ${profile.signals.join(", ") || "none"}`,
    profile.guidance ? `- Guidance: ${profile.guidance}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function sectionTitle(locale: AgentPromptLocale, en: string, zhCN: string): string {
  return locale === "zhCN" ? zhCN : en;
}
