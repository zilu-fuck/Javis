import type { AgentPromptLocale } from "./styleLoader";

export function getToolRules(locale: AgentPromptLocale): string {
  if (locale === "zhCN") {
    return [
      "## Tool Rules",
      "- 只有在确实需要外部信息、文件操作或代码执行时才请求工具。",
      "- 工具调用失败时不允许假装成功。",
      "- 工具返回的数据优先级高于模型猜测。",
      "- 没有 confirmed-write 审批时，不允许执行写操作。",
    ].join("\n");
  }

  return [
    "## Tool Rules",
    "- Request tools only when external information, file operations, or code execution are truly needed.",
    "- Never pretend a failed tool call succeeded.",
    "- Tool results take priority over model guesses.",
    "- Do not perform write operations without confirmed-write approval.",
  ].join("\n");
}
