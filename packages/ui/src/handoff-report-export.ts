import type { WorkbenchHandoffReport } from "./types";

export interface WorkbenchHandoffReportArtifact {
  filename: string;
  contentType: "application/json" | "text/markdown";
  content: string;
}

export function createWorkbenchHandoffReportArtifacts(
  report: WorkbenchHandoffReport,
  options: { baseName?: string } = {},
): WorkbenchHandoffReportArtifact[] {
  const baseName = sanitizeArtifactBaseName(options.baseName ?? "agent-handoff-report");
  return [{
    filename: `${baseName}.json`,
    contentType: "application/json",
    content: `${JSON.stringify(report, null, 2)}\n`,
  }, {
    filename: `${baseName}.md`,
    contentType: "text/markdown",
    content: formatWorkbenchHandoffReportMarkdown(report),
  }];
}

export function formatWorkbenchHandoffReportMarkdown(report: WorkbenchHandoffReport): string {
  const lines = [
    "# Agent Handoff Report",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Status: ${report.status}`,
    `- Handoffs: ${report.handoffs.length}`,
    `- Missing inputs: ${formatList(report.missingInputContextKeys)}`,
    `- Unconsumed outputs: ${formatList(report.unconsumedOutputContextKeys)}`,
    "",
    "## Handoffs",
    "",
    "| Context key | Producer | Consumers | Status | Value |",
    "| --- | --- | --- | --- | --- |",
    ...report.handoffs.map((handoff) => [
      escapeMarkdownTableCell(handoff.contextKey),
      escapeMarkdownTableCell(handoff.producedByStepId ?? "external"),
      escapeMarkdownTableCell(handoff.consumedByStepIds.join(", ") || "none"),
      escapeMarkdownTableCell(handoff.status),
      escapeMarkdownTableCell(formatHandoffValueSummary(handoff.valueSummary)),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Steps",
    "",
    "| Step | Agent | Inputs | Output | Missing inputs | Success criteria |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.steps.map((step) => [
      escapeMarkdownTableCell(step.title ? `${step.stepId} (${step.title})` : step.stepId),
      escapeMarkdownTableCell(step.assignedAgentKind),
      escapeMarkdownTableCell(formatList(step.inputContextKeys)),
      escapeMarkdownTableCell(step.outputContextKey ?? "none"),
      escapeMarkdownTableCell(formatList(step.missingInputContextKeys)),
      escapeMarkdownTableCell(step.successCriteria ?? ""),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function downloadWorkbenchHandoffReportArtifact(
  artifact: WorkbenchHandoffReportArtifact,
  doc: Document = document,
): boolean {
  const view = doc.defaultView;
  const urlApi = view?.URL ?? globalThis.URL;
  if (!doc.body || typeof Blob === "undefined" || !urlApi?.createObjectURL) {
    return false;
  }

  const blob = new Blob([artifact.content], { type: artifact.contentType });
  const url = urlApi.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = artifact.filename;
  link.style.display = "none";
  doc.body.appendChild(link);
  link.click();
  link.remove();
  urlApi.revokeObjectURL?.(url);
  return true;
}

function sanitizeArtifactBaseName(value: string): string {
  const sanitized = value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return sanitized || "agent-handoff-report";
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatHandoffValueSummary(value: {
  type: string;
  present: boolean;
  itemCount?: number;
  keyCount?: number;
  preview?: string;
}): string {
  if (!value.present) return value.type;
  if (value.type === "array") return `${value.type}: ${value.itemCount ?? 0} item(s)`;
  if (value.type === "object") return `${value.type}: ${value.keyCount ?? 0} key(s)`;
  if (value.preview) return `${value.type}: ${value.preview}`;
  return value.type;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
