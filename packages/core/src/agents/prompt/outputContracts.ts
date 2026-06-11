import type { AgentKind } from "../../index";
import type { AgentPromptLocale } from "./styleLoader";

const jsonKinds = new Set<AgentKind>(["commander", "computer"]);

export function getOutputContract(kind: AgentKind, locale: AgentPromptLocale): string {
  if (kind === "commander") {
    return locale === "zhCN"
      ? [
          "## 输出协议",
          "制定计划时只返回 JSON，不用 Markdown。",
          "顶层字段遵守 Commander DAG schema：title、reasoning、steps。",
          "steps[] 至少包含 id、title、assignedAgentKind、successCriteria。",
        ].join("\n")
      : [
          "## Output Contract",
          "For planning, return JSON only; no Markdown.",
          "Top-level fields follow the Commander DAG schema: title, reasoning, steps.",
          "steps[] must include at least id, title, assignedAgentKind, successCriteria.",
        ].join("\n");
  }

  if (jsonKinds.has(kind)) {
    return locale === "zhCN"
      ? [
          "## 输出协议",
          "遵守该 Agent 内置定义中的结构化输出要求；要求 JSON 时只输出 JSON。",
        ].join("\n")
      : [
          "## Output Contract",
          "Follow this agent's structured output contract; if JSON is required, output JSON only.",
        ].join("\n");
  }

  return locale === "zhCN"
    ? [
        "## 输出协议",
        "用清晰、可验证的自然语言回答；区分已完成、未完成/风险和下一步归属。",
      ].join("\n")
    : [
        "## Output Contract",
        "Respond in clear, verifiable natural language; separate done, not done/risks, and next owner.",
      ].join("\n");
}
