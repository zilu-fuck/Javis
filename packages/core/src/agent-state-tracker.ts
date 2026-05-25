import type {
  Agent,
  AgentRunStatus,
  AgentSnapshot,
  ID,
  ISODateTime,
} from "./index";

export interface AgentState {
  agentId: ID;
  status: AgentRunStatus;
  task: string;
  currentStepId?: ID;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
}

export interface AgentStateTracker {
  setState(agentId: ID, update: Partial<Omit<AgentState, "agentId">>): void;
  getState(agentId: ID): AgentState | undefined;
  getSnapshots(): AgentSnapshot[];
  reset(): void;
}

export function createAgentStateTracker(
  agents: Agent[],
  defaultTask = "Waiting",
): AgentStateTracker {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const states = new Map<ID, AgentState>();

  function reset() {
    states.clear();
    for (const agent of agents) {
      states.set(agent.id, {
        agentId: agent.id,
        status: "queued",
        task: defaultTask,
      });
    }
  }

  reset();

  return {
    setState(agentId, update) {
      const current = states.get(agentId);
      if (!current) {
        throw new Error(`Unknown agent state: ${agentId}`);
      }
      states.set(agentId, {
        ...current,
        ...update,
        agentId,
      });
    },
    getState(agentId) {
      const state = states.get(agentId);
      return state ? { ...state } : undefined;
    },
    getSnapshots() {
      return [...states.values()].map((state) => {
        const agent = agentById.get(state.agentId);
        if (!agent) {
          throw new Error(`Missing agent definition: ${state.agentId}`);
        }
        return {
          id: agent.id,
          name: agent.displayName,
          role: agent.description,
          status: state.status,
          task: state.task,
        };
      });
    },
    reset,
  };
}
