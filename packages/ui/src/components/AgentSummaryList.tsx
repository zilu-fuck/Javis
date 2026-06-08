import type { WorkbenchAgent, WorkbenchLocale, WorkbenchTask } from "../types";
import { AgentSummaryCard, buildAgentSummary } from "./AgentSummaryCard";

interface AgentSummaryListProps {
  agents: WorkbenchAgent[];
  task: WorkbenchTask;
  /** ID of the currently selected agent (highlight in the list). */
  selectedAgentId?: string;
  locale: WorkbenchLocale;
  onSelectAgent: (agentId: string) => void;
}

/** Tasks that indicate no real work was assigned to the agent. */
const PLACEHOLDER_TASKS = [
  "未分配工作任务",
  "No workflow task assigned",
];

/** The Commander is the main orchestrator — its output goes in the conversation, not as a card. */
function isSubAgent(agent: WorkbenchAgent): boolean {
  const name = (agent.name + agent.role).toLowerCase();
  return !name.includes("commander");
}

export function AgentSummaryList({ agents, task, selectedAgentId, locale, onSelectAgent }: AgentSummaryListProps) {
  // Only show sub-agents that completed or failed with real work to report
  const visibleAgents = agents.filter(
    (a) =>
      isSubAgent(a) &&
      (a.status === "completed" || a.status === "failed") &&
      !PLACEHOLDER_TASKS.some((p) => a.task.includes(p)),
  );

  if (visibleAgents.length === 0) {
    return null;
  }

  return (
    <div className="javis-agent-summary-list" role="list" aria-label="Agent summaries">
      {visibleAgents.map((agent) => (
        <AgentSummaryCard
          key={agent.id}
          agent={agent}
          locale={locale}
          summary={buildAgentSummary(agent, task, locale)}
          selected={selectedAgentId === agent.id}
          onSelect={onSelectAgent}
        />
      ))}
    </div>
  );
}
