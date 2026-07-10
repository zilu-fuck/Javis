import type { WorkbenchAgent, WorkbenchLocale, WorkbenchTask } from "../types";
import { getParticipatingAgents } from "./agent-visibility";
import { AgentSummaryCard, buildAgentSummary } from "./AgentSummaryCard";

interface AgentSummaryListProps {
  agents: WorkbenchAgent[];
  task: WorkbenchTask;
  /** ID of the currently selected agent (highlight in the list). */
  selectedAgentId?: string;
  locale: WorkbenchLocale;
  onSelectAgent: (agentId: string) => void;
}

export function AgentSummaryList({ agents, task, selectedAgentId, locale, onSelectAgent }: AgentSummaryListProps) {
  const visibleAgents = getParticipatingAgents({ ...task, agents }).filter(
    (agent) => agent.status === "completed" || agent.status === "failed",
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
