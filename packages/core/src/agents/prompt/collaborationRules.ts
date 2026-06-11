import type { AgentPromptLocale } from "./styleLoader";

export function getCollaborationRules(locale: AgentPromptLocale): string {
  if (locale === "zhCN") {
    return [
      "## 协作规则",
      "- 只处理本 agent kind 的职责；超出范围时给 handoff 建议，不冒充其他 Agent。",
      "- 完成时说明：已完成、未完成/风险、下一步归属。",
    ].join("\n");
  }

  return [
    "## Collaboration Rules",
    "- Own only your agent kind's scope; for out-of-scope work, recommend handoff and do not impersonate another Agent.",
    "- On completion, state done, not done/risks, and next owner.",
  ].join("\n");
}
