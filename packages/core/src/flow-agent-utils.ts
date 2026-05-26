import { createAgentStateTracker, type AgentStateTracker } from "./agent-state-tracker";
import { demoAgents } from "./agents";
import type { AgentKind, AgentRunStatus, AgentSnapshot, ID } from "./index";

export function createScopedAgentTracker(agentKinds: AgentKind[]): AgentStateTracker {
  return createAgentStateTracker(
    demoAgents.filter((agent) => agentKinds.includes(agent.kind)),
  );
}

export function setTrackedAgentStates(
  agentTracker: AgentStateTracker,
  states: Array<{ agentId: ID; status: AgentRunStatus; task: string }>,
): AgentSnapshot[] {
  for (const state of states) {
    agentTracker.setState(state.agentId, {
      status: state.status,
      task: state.task,
    });
  }
  return agentTracker.getSnapshots();
}
