import type { WorkbenchLocale, WorkbenchTask } from "../../types";
import { isChineseLocale, translateWorkbenchText } from "../../utils";
import { agentIcon, agentKind, agentProgress, agentStatusLabel, normalizeStatus } from "./inspector-utils";

interface AgentGraphPanelProps {
  locale: WorkbenchLocale;
  onSelectAgent?: (agentId: string) => void;
  selectedAgentId?: string;
  task: WorkbenchTask;
}

export function AgentGraphPanel({ locale, onSelectAgent, selectedAgentId, task }: AgentGraphPanelProps) {
  const isChinese = isChineseLocale(locale);

  return (
    <section className="javis-agent-list javis-agent-graph" aria-label={locale.labels.agentStates}>
      <TaskStatusCard isChinese={isChinese} task={task} />
      <div className="javis-agent-graph-root" aria-label="Commander">
        <span className="javis-agent-icon agent-commander">C</span>
        <span>
          <strong>{locale.labels.commander}</strong>
          <small>{translateWorkbenchText(task.commanderMessage || task.title, locale)}</small>
        </span>
      </div>
      <AgentGraphLines agentCount={task.agents.length} />
      <div className="javis-agent-graph-body">
        {task.agents.map((agent) => (
          <button
            className={`javis-agent status-${normalizeStatus(agent.status)}${selectedAgentId === agent.id ? " active" : ""}`}
            key={agent.id}
            onClick={() => onSelectAgent?.(agent.id)}
            type="button"
          >
            <div className="javis-agent-card-main">
              <span className={`javis-agent-icon agent-${agentKind(agent)}`}>{agentIcon(agent)}</span>
              <span className="javis-agent-name">
                {translateWorkbenchText(agent.name, locale)}
              </span>
              <span className={`javis-agent-status status-${normalizeStatus(agent.status)}`}>
                {agentStatusLabel(agent.status, locale)}
              </span>
            </div>
            <p className="javis-agent-task">{translateWorkbenchText(agent.role, locale)}</p>
            <p className="javis-agent-task">{translateWorkbenchText(agent.task, locale)}</p>
            <div className="javis-agent-progress" aria-hidden="true">
              <span style={{ width: `${agentProgress(agent.status)}%` }} />
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TaskStatusCard({ isChinese, task }: { isChinese: boolean; task: WorkbenchTask }) {
  return (
    <section className="javis-overview-card javis-agent-graph-task-status">
      <div className="javis-overview-card-header">
        <strong>{isChinese ? "任务状态" : "Task Status"}</strong>
        <span className={`javis-badge status-${task.status}`}>{task.status}</span>
      </div>
      <div className="javis-overview-stats">
        <StatRow label={isChinese ? "Agent 数" : "Agents"} value={String(task.agents.length)} />
        <StatRow label={isChinese ? "日志条数" : "Log entries"} value={String(task.logs.length)} />
        {task.workspacePath ? (
          <StatRow label={isChinese ? "工作区" : "Workspace"} value={task.workspacePath} />
        ) : null}
      </div>
    </section>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="javis-stat-row">
      <span className="javis-stat-label">{label}</span>
      <span className="javis-stat-value">{value}</span>
    </div>
  );
}

function AgentGraphLines({ agentCount }: { agentCount: number }) {
  if (agentCount <= 0) return null;

  const paths = Array.from({ length: agentCount }, (_, index) => {
    const targetX = agentCount === 1 ? 160 : 30 + (260 / Math.max(1, agentCount - 1)) * index;
    const controlX = 160 + (targetX - 160) * 0.48;
    return `M160 4 C${controlX.toFixed(0)} 22 ${targetX.toFixed(0)} 24 ${targetX.toFixed(0)} 42`;
  });

  return (
    <svg
      aria-hidden="true"
      className="javis-agent-graph-lines"
      data-testid="inspector-agent-graph-lines"
      preserveAspectRatio="none"
      viewBox="0 0 320 46"
    >
      {paths.map((path, index) => <path d={path} key={`${path}-${index}`} />)}
    </svg>
  );
}
