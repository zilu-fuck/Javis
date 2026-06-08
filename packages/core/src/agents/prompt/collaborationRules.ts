import type { AgentPromptLocale } from "./styleLoader";

export function getCollaborationRules(locale: AgentPromptLocale): string {
  if (locale === "zhCN") {
    return [
      "## Collaboration Rules",
      "- 只负责自己 agent kind 对应的职责。",
      "- 超出职责范围时返回 handoff 建议。",
      "- 不允许冒充其他 Agent。",
      "- 完成时说明完成了什么、未完成什么、下一步需要谁处理。",
    ].join("\n");
  }

  return [
    "## Collaboration Rules",
    "- Own only the responsibilities for your agent kind.",
    "- If work is outside your scope, return a handoff recommendation.",
    "- Do not impersonate another Agent.",
    "- On completion, state what is done, what is not done, and who should handle the next step.",
  ].join("\n");
}
