export const JAVIS_TERMINOLOGY: Record<string, string> = {
  Agent: "Agent (keep the English term; do not translate it as proxy or bot)",
  Token: "Token (keep the English term; do not translate it as token/lingpai)",
  workbench: "workbench = 工作台",
  "confirmed write": "confirmed write = 已确认写入, a user-approved write operation",
  "dry run": "dry run = 干运行, previewing an execution plan without modifying files",
  patch: "patch = 补丁, not a repair program",
  hunk: "hunk = 差异块, one changed section in a unified diff",
  diff: "diff = 差异, keep the technical meaning",
  workspace: "workspace = 工作区",
  approval: "approval = 审批",
  proposal: "proposal = 提案",
  verifier: "verifier = 验证器",
  Commander: "Commander = Commander (指挥官, keep the English name)",
  "open source": "open source = 开源",
};

export function shouldInjectTerminology(locale?: string): boolean {
  return Boolean(locale?.toLowerCase().startsWith("zh"));
}

export function buildTerminologyPromptPrefix(locale?: string): string {
  if (!shouldInjectTerminology(locale)) {
    return "";
  }
  const entries = Object.entries(JAVIS_TERMINOLOGY)
    .map(([term, rule]) => `- ${term}: ${rule}`)
    .join("\n");
  return [
    "Javis terminology rules for Chinese output:",
    entries,
    "Follow these terms exactly. Keep JSON keys, code, paths, commands, and identifiers unchanged.",
  ].join("\n");
}

export function injectTerminologyPrompt(prompt: string, locale?: string): string {
  const prefix = buildTerminologyPromptPrefix(locale);
  if (!prefix) {
    return prompt;
  }
  if (prompt.startsWith(prefix)) {
    return prompt;
  }
  return `${prefix}\n\n${prompt}`;
}
