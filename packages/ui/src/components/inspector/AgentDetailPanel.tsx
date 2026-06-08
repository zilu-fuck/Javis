import type { WorkbenchAgent, WorkbenchLocale, WorkbenchTask, WorkbenchWorkspaceToolAction } from "../../types";
import { isChineseLocale, translateWorkbenchText } from "../../utils";
import { buildAgentDetailViewModel } from "./agent-detail-model";
import { agentIcon, agentKind, agentProgress, agentStatusLabel, normalizeStatus } from "./inspector-utils";

interface AgentDetailPanelProps {
  agent: WorkbenchAgent;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  onQuickAction?: (action: WorkbenchWorkspaceToolAction) => void;
  task: WorkbenchTask;
}

export function AgentDetailPanel({ agent, labels, locale, onQuickAction, task }: AgentDetailPanelProps) {
  const isChinese = isChineseLocale(locale);
  const viewModel = buildAgentDetailViewModel(task, agent);
  const quickTools = getAgentQuickTools(agentKind(agent), viewModel.artifacts.length);

  return (
    <>
      <section className="javis-selected-agent-detail" aria-label={translateWorkbenchText(agent.name, locale)}>
        <div className="javis-agent-card-main">
          <span className={`javis-agent-icon agent-${agentKind(agent)}`}>{agentIcon(agent)}</span>
          <span className="javis-agent-name">{translateWorkbenchText(agent.name, locale)}</span>
          <span className={`javis-agent-status status-${normalizeStatus(agent.status)}`}>
            {agentStatusLabel(agent.status, locale)}
          </span>
        </div>
        <p>{translateWorkbenchText(agent.role, locale)}</p>
        <p>{translateWorkbenchText(agent.task, locale)}</p>
        <div className="javis-agent-progress" aria-hidden="true">
          <span style={{ width: `${agentProgress(agent.status)}%` }} />
        </div>
      </section>
      <section className="javis-task-overview" aria-label={isChinese ? "Agent 运行详情" : "Agent run details"}>
        {viewModel.currentStep ? (
          <article className="javis-overview-card">
            <div className="javis-overview-card-header">
              <strong>{isChinese ? "当前步骤" : "Current step"}</strong>
              <span className={`javis-badge status-${viewModel.currentStep.status}`}>{viewModel.currentStep.status}</span>
            </div>
            <p>{translateWorkbenchText(viewModel.currentStep.title, locale)}</p>
            {viewModel.currentStep.successCriteria ? (
              <p>{translateWorkbenchText(viewModel.currentStep.successCriteria, locale)}</p>
            ) : null}
          </article>
        ) : null}
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{labels.plan}</strong>
            <span>{viewModel.steps.length}</span>
          </div>
          {viewModel.steps.length > 0 ? (
            <ol className="javis-task-step-list javis-agent-detail-step-list">
              {viewModel.steps.map((step) => (
                <li className={`javis-task-step javis-agent-detail-step status-${step.status}`} key={step.id}>
                  <span className="javis-task-step-main">
                    <strong>{translateWorkbenchText(step.title, locale)}</strong>
                    {step.successCriteria ? <small>{translateWorkbenchText(step.successCriteria, locale)}</small> : null}
                  </span>
                  <span className="javis-task-step-status">{step.status}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>{isChinese ? "暂无归属到该 Agent 的步骤。" : "No steps are linked to this agent yet."}</p>
          )}
        </article>
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{isChinese ? "相关事件" : "Related events"}</strong>
            <span>{viewModel.logs.length}</span>
          </div>
          {viewModel.logs.length > 0 ? (
            <ol className="javis-task-step-list javis-agent-event-list">
              {viewModel.logs.map((log) => (
                <li className="javis-task-step javis-agent-event" key={log.id}>
                  <span className="javis-task-step-main">
                    <strong>{translateWorkbenchText(log.title, locale)}</strong>
                    <small>{translateWorkbenchText(getLogMessage(log), locale)}</small>
                  </span>
                  <span className="javis-task-step-status">{log.kind}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>{isChinese ? "暂无归属到该 Agent 的事件。" : "No events are linked to this agent yet."}</p>
          )}
        </article>
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{isChinese ? "相关产物" : "Related artifacts"}</strong>
            <span>{viewModel.artifacts.length}</span>
          </div>
          {viewModel.artifacts.length > 0 ? (
            <div className="javis-overview-stats">
              {viewModel.artifacts.map((artifact) => (
                <div className="javis-stat-row" key={artifact.id}>
                  <span className="javis-stat-label">{artifact.kind}</span>
                  <span className="javis-stat-value">
                    {translateWorkbenchText(artifact.title, locale)}
                    {artifact.detail ? <small>{translateWorkbenchText(artifact.detail, locale)}</small> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p>{isChinese ? "暂无归属到该 Agent 的产物。" : "No artifacts are linked to this agent yet."}</p>
          )}
        </article>
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{isChinese ? "快捷工具" : "Quick tools"}</strong>
            <span>{quickTools.length}</span>
          </div>
          <div className="javis-agent-tool-shortcuts">
            {quickTools.map((tool) => (
              <button
                className="javis-agent-tool-shortcut"
                key={tool}
                onClick={() => onQuickAction?.(tool)}
                type="button"
              >
                <span aria-hidden="true">{getToolIcon(tool)}</span>
                <strong>{getToolLabel(tool, isChinese)}</strong>
              </button>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

function getAgentQuickTools(agentKindValue: string, artifactCount: number): WorkbenchWorkspaceToolAction[] {
  switch (agentKindValue) {
    case "code":
      return ["review", "terminal", "files"];
    case "command":
      return ["terminal", "files"];
    case "computer":
      return ["browser", "terminal", "files"];
    case "research":
      return ["browser", "sideChat"];
    case "file":
      return ["files", artifactCount > 0 ? "sideChat" : "terminal"];
    default:
      return ["sideChat", "files"];
  }
}

function getToolLabel(tool: WorkbenchWorkspaceToolAction, isChinese: boolean): string {
  if (isChinese) {
    switch (tool) {
      case "browser": return "浏览器";
      case "files": return "文件";
      case "review": return "审查";
      case "sideChat": return "侧聊";
      case "terminal": return "终端";
      default: return tool;
    }
  }
  switch (tool) {
    case "browser": return "Browser";
    case "files": return "Files";
    case "review": return "Review";
    case "sideChat": return "Side chat";
    case "terminal": return "Terminal";
    default: return tool;
  }
}

function getLogMessage(log: { userMessage?: string; detail: string }): string {
  const userMessage = log.userMessage?.trim();
  if (userMessage && !looksLikeStructuredText(userMessage)) {
    return userMessage;
  }
  return log.detail;
}

function looksLikeStructuredText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /\"(?:plan|toolName|assignedAgentKind|successCriteria)\"/.test(trimmed);
}

function getToolIcon(tool: WorkbenchWorkspaceToolAction): string {
  switch (tool) {
    case "browser": return "B";
    case "files": return "F";
    case "review": return "R";
    case "sideChat": return "S";
    case "terminal": return ">";
    default: return "+";
  }
}
