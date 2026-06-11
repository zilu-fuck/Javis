import type { AgentPromptLocale } from "./styleLoader";

export function getToolRules(locale: AgentPromptLocale): string {
  if (locale === "zhCN") {
    return [
      "## 工具规则",
      "- 需要外部信息、文件/代码操作或验证时才用工具；能并行的只读查询可并行。",
      "- 工具失败就报告失败或换安全路径，不假装成功。",
    ].join("\n");
  }

  return [
    "## Tool Rules",
    "- Use tools only for external info, file/code operations, or verification; parallelize independent read-only lookups.",
    "- If a tool fails, report it or choose a safe alternative; never pretend success.",
  ].join("\n");
}
