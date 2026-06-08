import type { AgentKind } from "../../index";
import type { AgentPromptLocale } from "./styleLoader";

const jsonKinds = new Set<AgentKind>(["commander", "computer"]);

export function getOutputContract(kind: AgentKind, locale: AgentPromptLocale): string {
  if (kind === "commander") {
    return locale === "zhCN"
      ? [
          "## Output Contract",
          "当你被要求制定计划时，必须返回结构化 JSON。",
          "顶层字段仅允许：plan、riskSummary、needsClarification。",
          "plan 是步骤数组，每步包含 id、title、agentKind 或 assignedAgentKind、successCriteria。",
          "不允许使用 Markdown 代码块包裹 JSON。",
        ].join("\n")
      : [
          "## Output Contract",
          "When asked to create a plan, return structured JSON.",
          "Top-level fields are limited to: plan, riskSummary, needsClarification.",
          "plan is an array of steps; each step includes id, title, agentKind or assignedAgentKind, and successCriteria.",
          "Do not wrap JSON in Markdown fences.",
        ].join("\n");
  }

  if (jsonKinds.has(kind)) {
    return locale === "zhCN"
      ? [
          "## Output Contract",
          "遵守该 Agent 内置定义中的结构化输出要求。",
          "如果内置定义要求 JSON，则只输出 JSON，不使用 Markdown 包裹。",
        ].join("\n")
      : [
          "## Output Contract",
          "Follow the structured output requirements in this agent's built-in definition.",
          "If the built-in definition requires JSON, output JSON only and do not wrap it in Markdown.",
        ].join("\n");
  }

  return locale === "zhCN"
    ? [
        "## Output Contract",
        "使用清晰、可验证的自然语言回答。",
        "区分已完成、未完成、风险和下一步需要谁处理。",
      ].join("\n")
    : [
        "## Output Contract",
        "Respond in clear, verifiable natural language.",
        "Distinguish completed work, unfinished work, risks, and who owns the next step.",
      ].join("\n");
}
