import type { CodeTool, ShellCommandOutput, ShellTool } from "@javis/tools";
import { demoAgents } from "./agents";
import type { AgentKind, TaskStep } from "./index";
import { getWorkbenchWorkflow } from "./workflows";

export function workflowStepToTaskStep(
  step: NonNullable<ReturnType<typeof getWorkbenchWorkflow>>["steps"][number],
): TaskStep {
  return {
    id: step.id,
    title: step.title,
    assignedAgentKind: step.agentKind,
    agentId: `agent-${step.agentKind}`,
    status: "pending",
    successCriteria: step.output,
  };
}

export function runProjectReadOnlyCommands(shellTool: ShellTool): Promise<ShellCommandOutput[]> {
  return Promise.all([
    shellTool.runReadOnlyCommand({ program: "node", args: ["--version"], workspacePath: null }),
    shellTool.runReadOnlyCommand({ program: "pnpm", args: ["--version"], workspacePath: null }),
    shellTool.runReadOnlyCommand({ program: "git", args: ["status", "--short"], workspacePath: null }),
  ]);
}

export function formatAgentDisplayName(agentKind: AgentKind): string {
  return demoAgents.find((agent) => agent.kind === agentKind)?.displayName ?? `${agentKind} Agent`;
}

export async function safeInspectRepository(codeTool: CodeTool) {
  try {
    return await codeTool.inspectRepository();
  } catch {
    return undefined;
  }
}

export function markCurrentStepFailed(plan: TaskStep[]): TaskStep[] {
  let marked = false;
  return plan.map((step) => {
    if (!marked && step.status === "running") {
      marked = true;
      return { ...step, status: "failed" };
    }
    if (step.status === "pending") {
      return { ...step, status: "skipped" };
    }
    return step;
  });
}
