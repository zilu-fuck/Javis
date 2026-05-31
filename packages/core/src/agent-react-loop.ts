import type { Agent, AgentKind } from "./index";
import type { SharedTaskContext } from "./shared-context";
import type { WorkbenchWorkflowStep } from "./workflows";

export interface AgentReActObservation {
  iteration: number;
  toolName: string;
  status: "succeeded" | "failed";
  output: unknown;
  error?: string;
}

export interface AgentReActTool {
  name: string;
  execute(request: {
    agent: Agent;
    step: WorkbenchWorkflowStep;
    context: SharedTaskContext;
    observations: AgentReActObservation[];
  }): Promise<unknown>;
}

export interface AgentReActDecision {
  status: "continue" | "completed" | "failed";
  toolName?: string;
  reason: string;
  output?: unknown;
}

export interface AgentReActLoopOptions {
  agent: Agent;
  step: WorkbenchWorkflowStep;
  context: SharedTaskContext;
  tools: ReadonlyArray<AgentReActTool>;
  maxIterations?: number;
  decideNext(request: {
    agent: Agent;
    step: WorkbenchWorkflowStep;
    context: SharedTaskContext;
    observations: AgentReActObservation[];
    availableToolNames: string[];
  }): Promise<AgentReActDecision> | AgentReActDecision;
}

export interface AgentReActLoopResult {
  status: "completed" | "failed";
  output?: unknown;
  observations: AgentReActObservation[];
  reason: string;
}

export async function runAgentReActLoop({
  agent,
  step,
  context,
  tools,
  maxIterations = 4,
  decideNext,
}: AgentReActLoopOptions): Promise<AgentReActLoopResult> {
  assertAgentOwnsStep(agent, step.agentKind);

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const availableToolNames = tools
    .map((tool) => tool.name)
    .filter((toolName) => agent.allowedToolNames.includes(toolName));
  const observations: AgentReActObservation[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const decision = await decideNext({
      agent,
      step,
      context,
      observations,
      availableToolNames,
    });

    if (decision.status === "completed") {
      return {
        status: "completed",
        output: decision.output ?? observations[observations.length - 1]?.output,
        observations,
        reason: decision.reason,
      };
    }

    if (decision.status === "failed") {
      return {
        status: "failed",
        output: decision.output,
        observations,
        reason: decision.reason,
      };
    }

    if (!decision.toolName) {
      return {
        status: "failed",
        observations,
        reason: "Agent requested another action without selecting a tool.",
      };
    }

    if (!agent.allowedToolNames.includes(decision.toolName)) {
      return {
        status: "failed",
        observations,
        reason: `Agent ${agent.kind} cannot use tool ${decision.toolName}.`,
      };
    }

    const tool = toolMap.get(decision.toolName);
    if (!tool) {
      return {
        status: "failed",
        observations,
        reason: `Tool ${decision.toolName} is not available in this runtime.`,
      };
    }

    let observation: AgentReActObservation;
    try {
      const output = await tool.execute({
        agent,
        step,
        context,
        observations,
      });
      observation = {
        iteration,
        toolName: decision.toolName,
        status: "succeeded",
        output,
      };
    } catch (error) {
      observation = {
        iteration,
        toolName: decision.toolName,
        status: "failed",
        output: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    observations.push(observation);
    context.set(`react:${step.id}:${iteration}`, observation);
  }

  return {
    status: "failed",
    observations,
    reason: `Agent ${agent.kind} reached the ReAct iteration limit (${maxIterations}).`,
  };
}

function assertAgentOwnsStep(agent: Agent, stepAgentKind: AgentKind): void {
  if (agent.kind !== stepAgentKind) {
    throw new Error(`Agent ${agent.kind} cannot execute step assigned to ${stepAgentKind}.`);
  }
}
