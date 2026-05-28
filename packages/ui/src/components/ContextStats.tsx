import type { WorkbenchLocale, WorkbenchTask } from "../types";

interface ContextStatsProps {
  task: WorkbenchTask;
  labels: WorkbenchLocale["labels"];
}

export function ContextStats({ task, labels }: ContextStatsProps) {
  const items: string[] = [];

  if (task.plan.length > 0) {
    const completed = task.plan.filter((s) => s.status === "completed").length;
    items.push(`${completed}/${task.plan.length} ${labels.plan}`);
  }
  if (task.agents.length > 0) {
    items.push(`${task.agents.length} ${labels.agentStates}`);
  }
  if (task.documents && task.documents.length > 0) {
    items.push(`${task.documents.length} ${labels.documents}`);
  }
  if (task.commands && task.commands.length > 0) {
    const passed = task.commands.filter((c) => c.exitCode === 0).length;
    items.push(`${passed}/${task.commands.length} ${labels.commandResults}`);
  }
  if (task.sources && task.sources.length > 0) {
    items.push(`${task.sources.length} ${labels.source}`);
  }
  if (task.researchReport) {
    items.push(`${task.researchReport.rows.length} ${labels.researchReport}`);
  }
  if (task.codeReviewPreview && task.codeReviewPreview.changedFiles.length > 0) {
    items.push(`${task.codeReviewPreview.changedFiles.length} ${labels.changedFiles}`);
  }
  if (task.project) {
    const pkg = task.project.packageManager;
    if (pkg) items.push(pkg);
  }

  if (items.length === 0) return null;

  return <p className="javis-context-stats">{items.join("  路  ")}</p>;
}
