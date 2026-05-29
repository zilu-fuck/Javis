import { invoke } from "@tauri-apps/api/core";
import type {
  SidebarNavItem,
} from "@javis/ui";
import type {
  WorkspaceDefinition,
  AgentRegistry,
  WorkflowRegistry,
  RouteRegistry,
  WorkbenchWorkflow,
} from "@javis/core";
import type {
  WorkbenchWorkflowId,
  AgentKind,
  AgentCapabilityTag,
  RouteKind,
} from "@javis/core";
import type { Agent } from "@javis/core";
import type { RouteScore } from "@javis/core";

/** Load all workspace definitions from disk. */
export async function loadWorkspaceDefinitions(): Promise<WorkspaceDefinition[]> {
  const raw = await invoke<unknown[]>("load_workspace_definitions");
  return raw.map(validateWorkspaceDefinition);
}

/** Save a workspace definition to disk. */
export async function saveWorkspaceDefinition(def: WorkspaceDefinition): Promise<void> {
  await invoke("save_workspace_definition", { definition: def });
}

/** Delete a workspace definition from disk. */
export async function deleteWorkspaceDefinition(workspaceId: string): Promise<void> {
  await invoke("delete_workspace_definition", { workspaceId });
}

/** Build sidebar nav items from workspace definitions. Only enabled workspaces are included. */
export function buildWorkspaceNavItems(defs: WorkspaceDefinition[]): SidebarNavItem[] {
  return defs
    .filter((d) => d.enabled)
    .map((d) => ({
      viewId: d.id,
      icon: d.icon,
      label: d.title,
      group: d.sidebarGroup,
      groupLabel: d.sidebarGroup === "custom" ? d.title : undefined,
      order: d.sidebarOrder,
    }));
}

/** Register workspace agents into the agent registry. */
export function registerWorkspaceAgents(
  defs: WorkspaceDefinition[],
  registry: AgentRegistry,
): void {
  for (const def of defs) {
    if (!def.enabled || !def.agents) continue;
    for (const agentDef of def.agents) {
      const agent: Agent = {
        id: agentDef.id,
        kind: agentDef.kind,
        displayName: agentDef.displayName,
        description: agentDef.description,
        allowedToolNames: agentDef.allowedToolNames,
        modelRequirements: agentDef.modelRequirements,
        systemPrompt: agentDef.systemPrompt,
      };
      registry.register(agent);
    }
  }
}

/** Register workspace workflows into the workflow registry. */
export function registerWorkspaceWorkflows(
  defs: WorkspaceDefinition[],
  registry: WorkflowRegistry,
): void {
  for (const def of defs) {
    if (!def.enabled || !def.workflows) continue;
    for (const wfDef of def.workflows) {
      const workflow: WorkbenchWorkflow = {
        id: wfDef.id as WorkbenchWorkflowId,
        title: wfDef.title,
        triggerExamples: wfDef.triggerExamples,
        goal: wfDef.goal,
        coordinatorAgentKind: wfDef.coordinatorAgentKind,
        participatingAgentKinds: wfDef.participatingAgentKinds as AgentKind[],
        steps: wfDef.steps.map((s) => ({
          id: s.id,
          title: s.title,
          agentKind: s.agentKind,
          requiredCapabilities: s.requiredCapabilities as AgentCapabilityTag[] | undefined,
          input: s.input,
          output: s.output,
          permissionLevel: s.permissionLevel,
          dependsOn: s.dependsOn,
          canRunInParallel: s.canRunInParallel,
        })),
        currentSupport: wfDef.currentSupport,
        safetyNotes: wfDef.safetyNotes,
      };
      registry.register(workflow);
    }
  }
}

/** Register workspace routes into the route registry. */
export function registerWorkspaceRoutes(
  defs: WorkspaceDefinition[],
  registry: RouteRegistry,
): void {
  for (const def of defs) {
    if (!def.enabled || !def.routes) continue;
    for (const routeDef of def.routes) {
      registry.register(routeDef.routeKind, routeDef.workflowId, (userGoal, context) => {
        const signals: string[] = [];
        let score = 0;
        for (const kw of routeDef.scoring.keywordPatterns) {
          try {
            if (new RegExp(kw.pattern, "i").test(userGoal)) {
              signals.push(kw.signalName);
              score += kw.weight;
            }
          } catch {
            // Invalid regex, skip
          }
        }
        for (const cf of routeDef.scoring.contextFlags ?? []) {
          if ((context as Record<string, unknown>)[cf.flag]) {
            signals.push(cf.signalName);
            score += cf.weight;
          }
        }
        return { route: routeDef.routeKind as RouteKind, score, signals } satisfies RouteScore;
      });
    }
  }
}

/** Validate and coerce a JSON object into a WorkspaceDefinition. */
function validateWorkspaceDefinition(raw: unknown): WorkspaceDefinition {
  const d = raw as Record<string, unknown>;
  if (!d.id || typeof d.id !== "string") throw new Error("Workspace definition missing id");
  if (!d.title || typeof d.title !== "string") throw new Error(`Workspace ${d.id}: missing title`);
  return {
    id: d.id as string,
    title: d.title as string,
    icon: (d.icon as string) ?? "?",
    description: (d.description as string) ?? "",
    viewType: (d.viewType as string) ?? "chat",
    sidebarGroup: (d.sidebarGroup as WorkspaceDefinition["sidebarGroup"]) ?? "custom",
    sidebarOrder: (d.sidebarOrder as number) ?? 99,
    agents: d.agents as WorkspaceDefinition["agents"],
    workflows: d.workflows as WorkspaceDefinition["workflows"],
    tools: d.tools as WorkspaceDefinition["tools"],
    routes: d.routes as WorkspaceDefinition["routes"],
    version: (d.version as string) ?? "0.1.0",
    enabled: (d.enabled as boolean) ?? true,
    author: d.author as string | undefined,
  };
}
