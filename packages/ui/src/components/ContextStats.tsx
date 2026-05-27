import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { formatTokenCount } from "../utils";

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

  const hasStats = items.length > 0;
  const hasTokens = task.tokenUsage && task.tokenUsage.modelCalls > 0;

  if (!hasStats && !hasTokens) return null;

  return (
    <p className="javis-context-stats">
      {hasStats ? items.join("  ·  ") : null}
      {hasStats && hasTokens ? "  ·  " : null}
      {hasTokens ? (
        <span className="javis-context-tokens">
          {labels.tokenUsage}: {formatTokenCount(task.tokenUsage!.totalTokens)}
          {" "}({labels.tokenInput} {formatTokenCount(task.tokenUsage!.inputTokens)}
          {" / "}{labels.tokenOutput} {formatTokenCount(task.tokenUsage!.outputTokens)}
          {" / "}{labels.tokenCalls} {task.tokenUsage!.modelCalls})
        </span>
      ) : null}
    </p>
  );
}
