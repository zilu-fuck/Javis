import type { WorkbenchAgent, WorkbenchTask } from "../types";

const PLACEHOLDER_TASKS = [
  "\u672a\u5206\u914d\u5de5\u4f5c\u4efb\u52a1",
  "No workflow task assigned",
];

export function isCommanderAgent(agent: WorkbenchAgent): boolean {
  const text = `${agent.id} ${agent.name} ${agent.role}`.toLowerCase();
  return text.includes("commander");
}

export function getParticipatingAgents(
  task: WorkbenchTask,
  options: { includeCommander?: boolean } = {},
): WorkbenchAgent[] {
  const includeCommander = options.includeCommander ?? false;
  const steps = task.plan ?? [];
  const stepAgentKinds = new Set(
    steps
      .map((step) => step.agentKind?.trim())
      .filter((kind): kind is string => Boolean(kind)),
  );
  const stepAgentIds = new Set(
    steps
      .map((step) => step.agentId?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  return task.agents.filter((agent) => {
    if (!includeCommander && isCommanderAgent(agent)) {
      return false;
    }
    const referenced = isAgentReferencedByPlan(agent, stepAgentKinds, stepAgentIds);
    if (referenced) {
      return true;
    }
    if (isPlaceholderAgent(agent)) {
      return false;
    }
    return agent.status !== "queued";
  });
}

export function isPlaceholderAgent(agent: WorkbenchAgent): boolean {
  return PLACEHOLDER_TASKS.some((placeholder) => agent.task.includes(placeholder));
}

function isAgentReferencedByPlan(
  agent: WorkbenchAgent,
  stepAgentKinds: ReadonlySet<string>,
  stepAgentIds: ReadonlySet<string>,
): boolean {
  if (stepAgentIds.has(agent.id)) {
    return true;
  }
  const normalizedAgentId = agent.id.replace(/^agent-/, "");
  return stepAgentKinds.has(normalizedAgentId);
}
