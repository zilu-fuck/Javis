import type { WorkbenchAgent, WorkbenchLocale, WorkbenchLogEntry, WorkbenchTask } from "../types";
import { isChineseLocale, translateWorkbenchText } from "../utils";

interface AgentSummaryCardProps {
  agent: WorkbenchAgent;
  locale: WorkbenchLocale;
  summary: string;
  selected?: boolean;
  onSelect: (agentId: string) => void;
}

function agentIcon(agent: WorkbenchAgent): string {
  const name = (agent.name + agent.role).toLowerCase();
  if (name.includes("research") || name.includes("search") || name.includes("研究") || name.includes("检索")) return "R";
  if (name.includes("browser") || name.includes("web")) return "W";
  if (name.includes("verifier") || name.includes("verify") || name.includes("check") || name.includes("验证")) return "V";
  if (name.includes("file") || name.includes("write") || name.includes("文件") || name.includes("文档")) return "F";
  if (name.includes("code") || name.includes("program") || name.includes("代码")) return "C";
  if (name.includes("shell") || name.includes("command") || name.includes("命令")) return "S";
  if (name.includes("computer") || name.includes("电脑") || name.includes("桌面")) return "D";
  if (name.includes("commander") || name.includes("plan") || name.includes("指挥") || name.includes("计划")) return "P";
  if (name.includes("scheduler")) return "T";
  if (name.includes("vision") || name.includes("image")) return "I";
  return "A";
}

function statusBadge(status: string, locale: WorkbenchLocale): string {
  const isChinese = isChineseLocale(locale);
  switch (status) {
    case "completed":
      return isChinese ? "已完成" : "Completed";
    case "running":
      return isChinese ? "运行中" : "Running";
    case "failed":
      return isChinese ? "失败" : "Failed";
    default:
      return status;
  }
}

function joinParts(parts: string[], isChinese: boolean): string {
  return parts.join(isChinese ? "；" : "; ");
}

function truncate(text: string, maxLength = 120): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function computerLogSummary(logs: WorkbenchLogEntry[]): string | undefined {
  const desktopLogs = logs
    .filter((log) => {
      const text = `${log.kind} ${log.title} ${log.detail}`.toLowerCase();
      return (
        text.includes("computer") ||
        text.includes("desktop") ||
        text.includes("桌面") ||
        text.includes("控件") ||
        text.includes("鼠标") ||
        text.includes("窗口") ||
        text.includes("widget") ||
        text.includes("mouse") ||
        text.includes("window")
      );
    })
    .map((log) => log.detail.trim())
    .filter(Boolean);

  return desktopLogs.length > 0 ? desktopLogs[desktopLogs.length - 1] : undefined;
}

/**
 * Generate a natural language summary of what this agent actually did,
 * derived from the task's detail data.
 */
export function buildAgentSummary(agent: WorkbenchAgent, task: WorkbenchTask, locale: WorkbenchLocale): string {
  if (agent.summaryText?.trim()) {
    return agent.summaryText;
  }

  const name = (agent.name + agent.role).toLowerCase();
  const isChinese = isChineseLocale(locale);

  if (name.includes("research") || name.includes("search")) {
    const parts: string[] = [];
    if (task.sources?.length) {
      parts.push(isChinese ? `搜索了 ${task.sources.length} 个来源` : `Searched ${task.sources.length} source${task.sources.length > 1 ? "s" : ""}`);
    }
    if (task.researchReport) {
      parts.push(isChinese ? `生成研究报告：${task.researchReport.title}` : `Generated research report: ${task.researchReport.title}`);
    }
    if (parts.length > 0) return joinParts(parts, isChinese);
  }

  if (name.includes("code") || name.includes("program")) {
    const parts: string[] = [];
    if (task.codeReviewPreview?.changedFiles.length) {
      parts.push(isChinese ? `审查了 ${task.codeReviewPreview.changedFiles.length} 个文件` : `Reviewed ${task.codeReviewPreview.changedFiles.length} file${task.codeReviewPreview.changedFiles.length > 1 ? "s" : ""}`);
    }
    if (task.codeProposedEdit) {
      parts.push(isChinese ? `提出代码补丁：${task.codeProposedEdit.summary}` : `Proposed patch: ${task.codeProposedEdit.summary}`);
    }
    if (task.codeApplyResult) {
      parts.push(task.codeApplyResult.applied
        ? isChinese ? "补丁已应用" : "Patch applied"
        : isChinese ? "补丁未应用" : "Patch not applied");
    }
    if (parts.length > 0) return joinParts(parts, isChinese);
  }

  if (name.includes("file") || name.includes("write")) {
    const parts: string[] = [];
    if (task.documents?.length) {
      const names = task.documents.slice(0, 3).map((d) => d.path.split(/[/\\]/).pop() || d.path).join(", ");
      const suffix = task.documents.length > 3 ? (isChinese ? " 等" : ` +${task.documents.length - 3} more`) : "";
      parts.push(isChinese
        ? `扫描了 ${task.documents.length} 个文档：${names}${suffix}`
        : `Scanned ${task.documents.length} doc${task.documents.length > 1 ? "s" : ""}: ${names}${suffix}`);
    }
    if (task.fileOrganizationExecution) {
      parts.push(isChinese
        ? `整理了 ${task.fileOrganizationExecution.movedCount} 个文件`
        : `Organized ${task.fileOrganizationExecution.movedCount} file${task.fileOrganizationExecution.movedCount > 1 ? "s" : ""}`);
    }
    if (parts.length > 0) return joinParts(parts, isChinese);
  }

  if (name.includes("shell") || name.includes("command")) {
    if (task.commands?.length) {
      const cmds = task.commands.map((c) => c.command).join(", ");
      return isChinese
        ? `执行了 ${task.commands.length} 个命令：${cmds}`
        : `Ran ${task.commands.length} command${task.commands.length > 1 ? "s" : ""}: ${cmds}`;
    }
  }

  if (name.includes("browser") || name.includes("web")) {
    const browserSteps = task.plan.filter(
      (s) => s.title.toLowerCase().includes("browser") || s.title.toLowerCase().includes("web") || s.title.includes("网页"),
    );
    if (browserSteps.length > 0) {
      const titles = browserSteps.map((s) => s.title).join(", ");
      return isChinese ? `执行了网页任务：${titles}` : `Performed web tasks: ${titles}`;
    }
  }

  if (name.includes("verifier") || name.includes("verify") || name.includes("check")) {
    if (task.verificationSummary) {
      return truncate(task.verificationSummary, 100);
    }
  }

  if (name.includes("computer")) {
    const logSummary = computerLogSummary(task.logs);
    if (logSummary) {
      return truncate(logSummary);
    }
    const computerSteps = task.plan.filter((s) => {
      const title = s.title.toLowerCase();
      return title.includes("computer") || title.includes("desktop") || s.title.includes("桌面");
    });
    if (computerSteps.length > 0) {
      const completed = computerSteps.filter((s) => s.status === "completed").length;
      return isChinese
        ? `已通过桌面自动化执行 ${completed}/${computerSteps.length} 个步骤`
        : `Ran ${completed}/${computerSteps.length} desktop automation steps`;
    }
    if (task.commanderMessage?.trim()) {
      return truncate(task.commanderMessage.trim());
    }
  }

  const relatedSteps = task.plan.filter(
    (s) =>
      s.title.toLowerCase().includes(agent.name.toLowerCase()) ||
      agent.name.toLowerCase().includes(s.title.toLowerCase()),
  );
  if (relatedSteps.length > 0) {
    const titles = relatedSteps.map((s) => s.title).join(", ");
    return isChinese ? `完成了：${titles}` : `Completed: ${titles}`;
  }

  return translateWorkbenchText(agent.task, locale);
}

export function AgentSummaryCard({ agent, locale, summary, selected, onSelect }: AgentSummaryCardProps) {
  const badge = statusBadge(agent.status, locale);

  return (
    <button
      className={`javis-agent-summary-card${selected ? " active" : ""}`}
      onClick={() => onSelect(agent.id)}
      type="button"
      aria-label={`${agent.name}`}
    >
      <header className="javis-agent-summary-card-header">
        <span className="javis-agent-summary-card-icon">{agentIcon(agent)}</span>
        <span className="javis-agent-summary-card-name">
          {translateWorkbenchText(agent.name, locale)}
        </span>
        <span className={`javis-agent-summary-card-status status-${agent.status}`}>
          {badge}
        </span>
      </header>
      <p className="javis-agent-summary-card-body">{summary}</p>
    </button>
  );
}
