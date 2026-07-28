import { invoke } from "@tauri-apps/api/core";
import type {
  SidebarNavItem,
} from "@javis/ui";
import type {
  WorkspaceDefinition,
  WorkspaceAgentDefinition,
  WorkspaceWorkflowDefinition,
  WorkspaceWorkflowStepDefinition,
  WorkspaceToolDefinition,
  WorkspaceRouteDefinition,
  AgentRegistry,
  WorkflowRegistry,
  RouteRegistry,
  WorkbenchWorkflow,
} from "@javis/core";
import {
  assertValidWorkflowDag,
  demoAgents,
  isValidCapabilityTag,
  WORKBENCH_WORKFLOWS,
} from "@javis/core";
import type {
  WorkbenchWorkflowId,
  AgentKind,
  AgentCapabilityTag,
  RouteKind,
} from "@javis/core";
import type { Agent } from "@javis/core";
import type { RouteScore } from "@javis/core";
import type { WorkspaceMutationPlan } from "@javis/tools";

const MAX_WORKSPACE_ID_LENGTH = 64;
const MAX_WORKSPACE_TITLE_LENGTH = 120;
const MAX_WORKSPACE_DESCRIPTION_LENGTH = 500;
const MAX_WORKSPACE_AUTHOR_LENGTH = 120;
const MAX_WORKSPACE_AGENT_COUNT = 24;
const MAX_WORKSPACE_AGENT_ID_LENGTH = 64;
const MAX_WORKSPACE_AGENT_NAME_LENGTH = 120;
const MAX_WORKSPACE_AGENT_DESCRIPTION_LENGTH = 500;
const MAX_WORKSPACE_AGENT_TOOL_COUNT = 64;
const MAX_WORKSPACE_TOOL_NAME_LENGTH = 160;
const MAX_WORKSPACE_AGENT_PROMPT_LENGTH = 8_000;
const MAX_WORKSPACE_WORKFLOW_COUNT = 24;
const MAX_WORKSPACE_WORKFLOW_ID_LENGTH = 96;
const MAX_WORKSPACE_TRIGGER_COUNT = 24;
const MAX_WORKSPACE_TRIGGER_LENGTH = 300;
const MAX_WORKSPACE_WORKFLOW_TITLE_LENGTH = 120;
const MAX_WORKSPACE_WORKFLOW_GOAL_LENGTH = 1_000;
const MAX_WORKSPACE_WORKFLOW_STEP_COUNT = 32;
const MAX_WORKSPACE_STEP_TITLE_LENGTH = 160;
const MAX_WORKSPACE_STEP_TEXT_LENGTH = 1_000;
const MAX_WORKSPACE_STEP_CAPABILITY_COUNT = 24;
const MAX_WORKSPACE_SAFETY_NOTE_COUNT = 24;
const MAX_WORKSPACE_SAFETY_NOTE_LENGTH = 500;
const MAX_WORKSPACE_TOOL_COUNT = 64;
const MAX_WORKSPACE_TOOL_SUMMARY_LENGTH = 500;
const MAX_WORKSPACE_ROUTE_COUNT = 32;
const MAX_WORKSPACE_ROUTE_PATTERN_COUNT = 32;
const MAX_WORKSPACE_ROUTE_PATTERN_LENGTH = 300;
const MAX_WORKSPACE_ROUTE_SIGNAL_LENGTH = 80;
const MAX_WORKSPACE_ROUTE_KIND_LENGTH = 120;
// Workspace route expressions are untrusted JSON. Keep the accepted dialect
// deliberately small so a valid expression cannot monopolize the UI thread
// through catastrophic backtracking.
const MAX_ROUTE_REGEX_QUANTIFIERS = 16;
const MAX_ROUTE_REGEX_QUANTIFIERS_PER_BRANCH = 1;
const MAX_ROUTE_REGEX_BOUNDED_REPEAT = 64;
const MAX_ROUTE_REGEX_INPUT_LENGTH = 4_000;
const BUILT_IN_AGENT_KINDS = new Set<string>(demoAgents.map((agent) => agent.kind));
const VALID_VIEW_TYPES = new Set(["chat"]);
const VALID_SIDEBAR_GROUPS = new Set(["primary", "knowledge", "custom"]);
const VALID_PERMISSION_LEVELS = new Set(["read", "preview", "confirmed_write", "dangerous"]);
const VALID_SUPPORT_LEVELS = new Set(["implemented", "partial", "planned"]);
const VALID_WORKFLOW_IDS = new Set<string>(WORKBENCH_WORKFLOWS.map((workflow) => workflow.id));
const BUILT_IN_ROUTE_KINDS = new Set([
  "pdf", "code", "codebase", "research", "project", "file-scan", "spring-boot",
  "local-document", "schedule", "browser", "computer-use",
]);
const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** Load all workspace definitions from disk. */
export async function loadWorkspaceDefinitions(): Promise<WorkspaceDefinition[]> {
  const raw = await invoke<unknown>("load_workspace_definitions");
  if (!Array.isArray(raw)) {
    throw new Error("Workspace definitions must be a JSON array.");
  }
  const definitions = raw.map(validateWorkspaceDefinition);
  assertUniqueWorkspaceDefinitions(definitions);
  return definitions;
}

/** Build the native-bound preview for a workspace definition create. */
export async function planWorkspaceDefinitionCreate(
  def: WorkspaceDefinition,
  taskId?: string,
): Promise<WorkspaceMutationPlan> {
  const definition = validateWorkspaceDefinition(def);
  return invoke<WorkspaceMutationPlan>("plan_workspace_create", {
    request: { definition, taskId },
  });
}

/** Execute a workspace create through its one-shot native approval binding. */
export async function saveWorkspaceDefinition(
  def: WorkspaceDefinition,
  approvalId: string,
  taskId?: string,
): Promise<void> {
  const definition = validateWorkspaceDefinition(def);
  await invoke("approve_workspace_mutation", {
    request: { approvalId, taskId },
  });
  await invoke("execute_workspace_create", {
    request: { approvalId, definition, taskId },
  });
}

/** Build the native-bound preview for a workspace definition delete. */
export async function planWorkspaceDefinitionDelete(
  workspaceId: string,
  taskId?: string,
): Promise<WorkspaceMutationPlan> {
  return invoke<WorkspaceMutationPlan>("plan_workspace_delete", {
    request: { workspaceId, taskId },
  });
}

/** Execute a workspace delete through its one-shot native approval binding. */
export async function deleteWorkspaceDefinition(
  workspaceId: string,
  approvalId: string,
  taskId?: string,
): Promise<void> {
  await invoke("approve_workspace_mutation", {
    request: { approvalId, taskId },
  });
  await invoke("execute_workspace_delete", {
    request: { approvalId, workspaceId, taskId },
  });
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
  const validatedDefs = defs.map(validateWorkspaceDefinition);
  const pendingIds = new Set<string>();
  const pendingKinds = new Set<string>();
  const pending: Array<NonNullable<WorkspaceDefinition["agents"]>[number]> = [];
  for (const def of validatedDefs) {
    if (!def.enabled || !def.agents) continue;
    for (const agentDef of def.agents) {
      if (pendingIds.has(agentDef.id)) {
        throw new Error(`Duplicate workspace agent id: ${agentDef.id}`);
      }
      if (pendingKinds.has(agentDef.kind)) {
        throw new Error(`Duplicate workspace agent kind: ${agentDef.kind}`);
      }
      if (registry.list().some((registration) => registration.agent.id === agentDef.id)) {
        throw new Error(`Workspace agent id ${agentDef.id} is already registered.`);
      }
      if (registry.findByKind(agentDef.kind)) {
        throw new Error(`Workspace agent kind ${agentDef.kind} cannot shadow a registered agent.`);
      }
      pendingIds.add(agentDef.id);
      pendingKinds.add(agentDef.kind);
      pending.push(agentDef);
    }
  }
  try {
    for (const agentDef of pending) {
      const agent: Agent = {
        id: agentDef.id,
        kind: agentDef.kind,
        displayName: agentDef.displayName,
        description: agentDef.description,
        allowedToolNames: agentDef.allowedToolNames,
        modelRequirements: agentDef.modelRequirements,
        systemPrompt: agentDef.systemPrompt,
      };
      registry.register(agent, { allowKindReplacement: false });
    }
  } catch (error) {
    rollbackRegistrations(pending.map((agent) => agent.id), (id) => registry.unregister(id));
    throw error;
  }
}

function assertUniqueWorkspaceDefinitions(defs: WorkspaceDefinition[]): void {
  const workspaceIds = new Set<string>();
  const agentIds = new Set<string>();
  const agentKinds = new Set<string>();
  const workflowIds = new Set<string>();
  for (const def of defs) {
    if (workspaceIds.has(def.id)) {
      throw new Error(`Duplicate workspace id: ${def.id}`);
    }
    workspaceIds.add(def.id);
    for (const agent of def.agents ?? []) {
      if (agentIds.has(agent.id)) {
        throw new Error(`Duplicate workspace agent id: ${agent.id}`);
      }
      agentIds.add(agent.id);
      if (agentKinds.has(agent.kind)) {
        throw new Error(`Duplicate workspace agent kind: ${agent.kind}`);
      }
      agentKinds.add(agent.kind);
    }
    for (const workflow of def.workflows ?? []) {
      if (workflowIds.has(workflow.id)) {
        throw new Error(`Duplicate workspace workflow id: ${workflow.id}`);
      }
      workflowIds.add(workflow.id);
    }
  }
}

/** Register workspace workflows into the workflow registry. */
export function registerWorkspaceWorkflows(
  defs: WorkspaceDefinition[],
  registry: WorkflowRegistry,
): void {
  const validatedDefs = defs.map(validateWorkspaceDefinition);
  const pendingIds = new Set<string>();
  const pending: WorkbenchWorkflow[] = [];
  for (const def of validatedDefs) {
    if (!def.enabled || !def.workflows) continue;
    for (const wfDef of def.workflows) {
      if (pendingIds.has(wfDef.id)) {
        throw new Error(`Duplicate workspace workflow id: ${wfDef.id}`);
      }
      if (registry.get(wfDef.id)) {
        throw new Error(`Workspace workflow ${wfDef.id} is already registered and cannot be shadowed.`);
      }
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
      pendingIds.add(wfDef.id);
      pending.push(workflow);
    }
  }
  try {
    for (const workflow of pending) {
      registry.register(workflow);
    }
  } catch (error) {
    rollbackRegistrations(pending.map((workflow) => workflow.id), (id) => registry.unregister(id));
    throw error;
  }
}

/** Register workspace routes into the route registry. */
export function registerWorkspaceRoutes(
  defs: WorkspaceDefinition[],
  registry: RouteRegistry,
): void {
  const validatedDefs = defs.map(validateWorkspaceDefinition);
  const pendingRouteKinds = new Set<string>();
  const pending: WorkspaceRouteDefinition[] = [];
  for (const def of validatedDefs) {
    if (!def.enabled || !def.routes) continue;
    for (const routeDef of def.routes) {
      if (pendingRouteKinds.has(routeDef.routeKind)) {
        throw new Error(`Duplicate workspace route kind: ${routeDef.routeKind}`);
      }
      if (registry.getWorkflowId(routeDef.routeKind) !== undefined) {
        throw new Error(
          `Workspace route kind ${routeDef.routeKind} is already registered and cannot be shadowed.`,
        );
      }
      pendingRouteKinds.add(routeDef.routeKind);
      pending.push(routeDef);
    }
  }
  const compiled = pending.map((routeDef) => ({
    routeDef,
    keywordPatterns: routeDef.scoring.keywordPatterns.map((kw) => ({
      ...kw,
      regex: compileWorkspaceRoutePattern(kw.pattern, routeDef.routeKind),
    })),
  }));
  try {
    for (const { routeDef, keywordPatterns } of compiled) {
      registry.register(routeDef.routeKind, routeDef.workflowId, (userGoal, context) => {
        const signals: string[] = [];
        let score = 0;
        const boundedGoal = userGoal.length <= MAX_ROUTE_REGEX_INPUT_LENGTH
          ? userGoal
          : `${userGoal.slice(0, MAX_ROUTE_REGEX_INPUT_LENGTH / 2)} ${userGoal.slice(-MAX_ROUTE_REGEX_INPUT_LENGTH / 2)}`;
        for (const kw of keywordPatterns) {
          if (kw.regex.test(boundedGoal)) {
            signals.push(kw.signalName);
            score += kw.weight;
          }
        }
        for (const cf of routeDef.scoring.contextFlags ?? []) {
          if ((context as Record<string, unknown>)[cf.flag]) {
            signals.push(cf.signalName);
            score += cf.weight;
          }
        }
        return {
          route: routeDef.routeKind as RouteKind,
          score,
          signals,
          ...(routeDef.scoring.threshold === undefined ? {} : { threshold: routeDef.scoring.threshold }),
        } satisfies RouteScore;
      });
    }
  } catch (error) {
    rollbackRegistrations(pending.map((route) => route.routeKind), (routeKind) => registry.unregister(routeKind));
    throw error;
  }
}

function rollbackRegistrations<T>(registered: ReadonlyArray<T>, unregister: (value: T) => void): void {
  for (let index = registered.length - 1; index >= 0; index -= 1) {
    try {
      unregister(registered[index]);
    } catch {
      // Preserve the original registration error. The built-in registries have
      // non-throwing unregister operations, but custom registries must not mask it.
    }
  }
}

/** Validate and coerce a JSON object into a WorkspaceDefinition. */
export function validateWorkspaceDefinition(raw: unknown): WorkspaceDefinition {
  const d = asRecord(raw, "Workspace definition");
  assertAllowedKeys(d, [
    "id", "title", "icon", "description", "viewType", "sidebarGroup", "sidebarOrder",
    "agents", "workflows", "tools", "routes", "version", "enabled", "author",
  ], "Workspace definition");
  const id = requiredText(d.id, "Workspace definition id", MAX_WORKSPACE_ID_LENGTH, KEBAB_CASE_PATTERN);
  const title = requiredText(d.title, `Workspace ${id} title`, MAX_WORKSPACE_TITLE_LENGTH);
  const icon = d.icon === undefined ? "?" : requiredText(d.icon, `Workspace ${id} icon`, 16);
  const description = d.description === undefined
    ? ""
    : requiredText(d.description, `Workspace ${id} description`, MAX_WORKSPACE_DESCRIPTION_LENGTH, undefined, true);
  const viewType = d.viewType === undefined ? "chat" : enumText(d.viewType, `Workspace ${id} viewType`, VALID_VIEW_TYPES);
  const sidebarGroup = d.sidebarGroup === undefined
    ? "custom"
    : enumText(d.sidebarGroup, `Workspace ${id} sidebarGroup`, VALID_SIDEBAR_GROUPS) as WorkspaceDefinition["sidebarGroup"];
  const sidebarOrder = d.sidebarOrder === undefined ? 99 : boundedInteger(d.sidebarOrder, `Workspace ${id} sidebarOrder`, -1_000, 1_000);
  const version = d.version === undefined ? "0.1.0" : requiredText(d.version, `Workspace ${id} version`, 32, SEMVER_PATTERN);
  const enabled = d.enabled === undefined ? true : requiredBoolean(d.enabled, `Workspace ${id} enabled`);
  const author = d.author === undefined
    ? undefined
    : requiredText(d.author, `Workspace ${id} author`, MAX_WORKSPACE_AUTHOR_LENGTH, undefined, true);
  const agents = d.agents === undefined
    ? undefined
    : parseWorkspaceAgents(d.agents, id);
  const allowedAgentKinds = new Set([
    ...BUILT_IN_AGENT_KINDS,
    ...(agents ?? []).map((agent) => agent.kind),
  ]);
  const workflows = d.workflows === undefined
    ? undefined
    : parseWorkspaceWorkflows(d.workflows, id, allowedAgentKinds);
  const tools = d.tools === undefined ? undefined : parseWorkspaceTools(d.tools, id);
  const routes = d.routes === undefined
    ? undefined
    : parseWorkspaceRoutes(d.routes, id, new Set((workflows ?? []).map((workflow) => workflow.id)));
  return {
    id,
    title,
    icon,
    description,
    viewType,
    sidebarGroup,
    sidebarOrder,
    agents,
    workflows,
    tools,
    routes,
    version,
    enabled,
    ...(author !== undefined ? { author } : {}),
  };
}

function parseWorkspaceAgents(value: unknown, workspaceId: string): WorkspaceAgentDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`Workspace ${workspaceId} agents must be an array.`);
  }
  if (value.length > MAX_WORKSPACE_AGENT_COUNT) {
    throw new Error(`Workspace ${workspaceId} has too many agents.`);
  }
  const ids = new Set<string>();
  const kinds = new Set<string>();
  return value.map((raw, index) => {
    const agent = validateWorkspaceAgent(raw, `${workspaceId}.agents[${index}]`, workspaceId);
    if (ids.has(agent.id)) throw new Error(`Duplicate workspace agent id: ${agent.id}`);
    if (kinds.has(agent.kind)) throw new Error(`Duplicate workspace agent kind: ${agent.kind}`);
    ids.add(agent.id);
    kinds.add(agent.kind);
    return agent;
  });
}

function validateWorkspaceAgent(
  raw: unknown,
  label: string,
  workspaceId: string,
): WorkspaceAgentDefinition {
  const d = asRecord(raw, label);
  assertAllowedKeys(d, [
    "id", "kind", "displayName", "description", "allowedToolNames", "modelRequirements", "systemPrompt",
  ], label);
  const id = requiredText(d.id, `${label}.id`, MAX_WORKSPACE_AGENT_ID_LENGTH, KEBAB_CASE_PATTERN);
  const kindText = validateWorkspaceAgentKind(d.kind, `${label}.kind`, workspaceId);
  const displayName = requiredText(d.displayName, `${label}.displayName`, MAX_WORKSPACE_AGENT_NAME_LENGTH);
  const description = requiredText(d.description, `${label}.description`, MAX_WORKSPACE_AGENT_DESCRIPTION_LENGTH, undefined, true);
  if (!Array.isArray(d.allowedToolNames) || d.allowedToolNames.length > MAX_WORKSPACE_AGENT_TOOL_COUNT) {
    throw new Error(`${label}.allowedToolNames must be an array with at most ${MAX_WORKSPACE_AGENT_TOOL_COUNT} items.`);
  }
  const allowedToolNames = d.allowedToolNames.map((value, index) => {
    const toolName = requiredText(value, `${label}.allowedToolNames[${index}]`, MAX_WORKSPACE_TOOL_NAME_LENGTH, TOOL_NAME_PATTERN);
    return toolName;
  });
  if (new Set(allowedToolNames).size !== allowedToolNames.length) {
    throw new Error(`${label}.allowedToolNames contains duplicates.`);
  }
  const modelRequirements = d.modelRequirements === undefined
    ? undefined
    : validateModelRequirements(d.modelRequirements, label);
  const prompt = asRecord(d.systemPrompt, `${label}.systemPrompt`);
  assertAllowedKeys(prompt, ["en", "zhCN"], `${label}.systemPrompt`);
  const systemPrompt = {
    en: requiredText(prompt.en, `${label}.systemPrompt.en`, MAX_WORKSPACE_AGENT_PROMPT_LENGTH),
    zhCN: requiredText(prompt.zhCN, `${label}.systemPrompt.zhCN`, MAX_WORKSPACE_AGENT_PROMPT_LENGTH),
  };
  return {
    id,
    kind: kindText,
    displayName,
    description,
    allowedToolNames,
    ...(modelRequirements ? { modelRequirements } : {}),
    systemPrompt,
  };
}

function validateModelRequirements(value: unknown, label: string): NonNullable<WorkspaceAgentDefinition["modelRequirements"]> {
  const d = asRecord(value, `${label}.modelRequirements`);
  assertAllowedKeys(d, ["prefersVision", "prefersCode", "minContextTokens"], `${label}.modelRequirements`);
  return {
    prefersVision: requiredBoolean(d.prefersVision, `${label}.modelRequirements.prefersVision`),
    prefersCode: requiredBoolean(d.prefersCode, `${label}.modelRequirements.prefersCode`),
    minContextTokens: boundedInteger(d.minContextTokens, `${label}.modelRequirements.minContextTokens`, 0, 1_000_000),
  };
}

function parseWorkspaceWorkflows(
  value: unknown,
  workspaceId: string,
  allowedAgentKinds: ReadonlySet<string>,
): WorkspaceWorkflowDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`Workspace ${workspaceId} workflows must be an array.`);
  }
  if (value.length > MAX_WORKSPACE_WORKFLOW_COUNT) {
    throw new Error(`Workspace ${workspaceId} has too many workflows.`);
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const workflow = validateWorkspaceWorkflow(
      raw,
      `${workspaceId}.workflows[${index}]`,
      allowedAgentKinds,
    );
    if (ids.has(workflow.id)) throw new Error(`Duplicate workspace workflow id: ${workflow.id}`);
    ids.add(workflow.id);
    return workflow;
  });
}

function validateWorkspaceWorkflow(
  raw: unknown,
  label: string,
  allowedAgentKinds: ReadonlySet<string>,
): WorkspaceWorkflowDefinition {
  const d = asRecord(raw, label);
  assertAllowedKeys(d, [
    "id", "title", "triggerExamples", "goal", "coordinatorAgentKind", "participatingAgentKinds",
    "steps", "currentSupport", "safetyNotes",
  ], label);
  const id = requiredText(d.id, `${label}.id`, MAX_WORKSPACE_WORKFLOW_ID_LENGTH, KEBAB_CASE_PATTERN);
  if (VALID_WORKFLOW_IDS.has(id)) {
    throw new Error(`${label}.id ${id} is reserved for a built-in workflow.`);
  }
  const title = requiredText(d.title, `${label}.title`, MAX_WORKSPACE_WORKFLOW_TITLE_LENGTH);
  const triggerExamples = parseTextArray(d.triggerExamples, `${label}.triggerExamples`, MAX_WORKSPACE_TRIGGER_COUNT, MAX_WORKSPACE_TRIGGER_LENGTH);
  const goal = requiredText(d.goal, `${label}.goal`, MAX_WORKSPACE_WORKFLOW_GOAL_LENGTH);
  const coordinatorAgentKind = enumText(d.coordinatorAgentKind, `${label}.coordinatorAgentKind`, new Set(["commander"])) as "commander";
  const participatingAgentKinds = parseAgentKindArray(
    d.participatingAgentKinds,
    `${label}.participatingAgentKinds`,
    24,
    allowedAgentKinds,
  );
  if (!participatingAgentKinds.includes(coordinatorAgentKind)) {
    throw new Error(`${label}.participatingAgentKinds must include commander.`);
  }
  const steps = parseWorkspaceWorkflowSteps(d.steps, label, allowedAgentKinds);
  const currentSupport = enumText(d.currentSupport, `${label}.currentSupport`, VALID_SUPPORT_LEVELS) as WorkspaceWorkflowDefinition["currentSupport"];
  const safetyNotes = parseTextArray(d.safetyNotes, `${label}.safetyNotes`, MAX_WORKSPACE_SAFETY_NOTE_COUNT, MAX_WORKSPACE_SAFETY_NOTE_LENGTH);
  return {
    id,
    title,
    triggerExamples,
    goal,
    coordinatorAgentKind,
    participatingAgentKinds: participatingAgentKinds as WorkspaceWorkflowDefinition["participatingAgentKinds"],
    steps,
    currentSupport,
    safetyNotes,
  };
}

function parseWorkspaceWorkflowSteps(
  value: unknown,
  label: string,
  allowedAgentKinds: ReadonlySet<string>,
): WorkspaceWorkflowStepDefinition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WORKSPACE_WORKFLOW_STEP_COUNT) {
    throw new Error(`${label}.steps must contain 1-${MAX_WORKSPACE_WORKFLOW_STEP_COUNT} items.`);
  }
  const ids = new Set<string>();
  const steps = value.map((raw, index) => {
    const stepLabel = `${label}.steps[${index}]`;
    const d = asRecord(raw, stepLabel);
    assertAllowedKeys(d, [
      "id", "title", "agentKind", "requiredCapabilities", "input", "output", "permissionLevel", "dependsOn", "canRunInParallel",
    ], stepLabel);
    const id = requiredText(d.id, `${stepLabel}.id`, 96, KEBAB_CASE_PATTERN);
    if (ids.has(id)) throw new Error(`Duplicate workspace workflow step id: ${id}`);
    ids.add(id);
    const requiredCapabilities = d.requiredCapabilities === undefined
      ? undefined
      : parseCapabilityArray(d.requiredCapabilities, `${stepLabel}.requiredCapabilities`);
    const dependsOn = parseIdArray(d.dependsOn, `${stepLabel}.dependsOn`, 32);
    if (dependsOn.includes(id)) throw new Error(`${stepLabel}.dependsOn cannot reference itself.`);
    return {
      id,
      title: requiredText(d.title, `${stepLabel}.title`, MAX_WORKSPACE_STEP_TITLE_LENGTH),
      agentKind: enumText(d.agentKind, `${stepLabel}.agentKind`, allowedAgentKinds) as WorkspaceWorkflowStepDefinition["agentKind"],
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
      input: requiredText(d.input, `${stepLabel}.input`, MAX_WORKSPACE_STEP_TEXT_LENGTH, undefined, true),
      output: requiredText(d.output, `${stepLabel}.output`, MAX_WORKSPACE_STEP_TEXT_LENGTH, undefined, true),
      permissionLevel: enumText(d.permissionLevel, `${stepLabel}.permissionLevel`, VALID_PERMISSION_LEVELS) as WorkspaceWorkflowStepDefinition["permissionLevel"],
      dependsOn,
      canRunInParallel: requiredBoolean(d.canRunInParallel, `${stepLabel}.canRunInParallel`),
    };
  });
  const idsSet = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!idsSet.has(dependency)) {
        throw new Error(`Workspace workflow step ${step.id} depends on unknown step ${dependency}.`);
      }
    }
  }
  try {
    assertValidWorkflowDag(steps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${detail}`);
  }
  return steps;
}

function parseWorkspaceTools(value: unknown, workspaceId: string): WorkspaceToolDefinition[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_TOOL_COUNT) {
    throw new Error(`Workspace ${workspaceId} tools must contain at most ${MAX_WORKSPACE_TOOL_COUNT} items.`);
  }
  const names = new Set<string>();
  return value.map((raw, index) => {
    const label = `${workspaceId}.tools[${index}]`;
    const d = asRecord(raw, label);
    assertAllowedKeys(d, ["name", "permissionLevel", "summary"], label);
    const name = requiredText(d.name, `${label}.name`, MAX_WORKSPACE_TOOL_NAME_LENGTH, TOOL_NAME_PATTERN);
    if (names.has(name)) throw new Error(`Duplicate workspace tool name: ${name}`);
    names.add(name);
    return {
      name,
      permissionLevel: enumText(d.permissionLevel, `${label}.permissionLevel`, VALID_PERMISSION_LEVELS) as WorkspaceToolDefinition["permissionLevel"],
      summary: requiredText(d.summary, `${label}.summary`, MAX_WORKSPACE_TOOL_SUMMARY_LENGTH),
    };
  });
}

function parseWorkspaceRoutes(
  value: unknown,
  workspaceId: string,
  workflowIds: ReadonlySet<string>,
): WorkspaceRouteDefinition[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_ROUTE_COUNT) {
    throw new Error(`Workspace ${workspaceId} routes must contain at most ${MAX_WORKSPACE_ROUTE_COUNT} items.`);
  }
  const routeKinds = new Set<string>();
  return value.map((raw, index) => {
    const label = `${workspaceId}.routes[${index}]`;
    const d = asRecord(raw, label);
    assertAllowedKeys(d, ["routeKind", "workflowId", "scoring"], label);
    const routeKind = validateWorkspaceRouteKind(d.routeKind, `${label}.routeKind`, workspaceId);
    if (routeKinds.has(routeKind)) throw new Error(`Duplicate workspace route kind: ${routeKind}`);
    routeKinds.add(routeKind);
    const workflowId = requiredText(d.workflowId, `${label}.workflowId`, MAX_WORKSPACE_WORKFLOW_ID_LENGTH, KEBAB_CASE_PATTERN);
    if (!workflowIds.has(workflowId)) {
      throw new Error(`${label}.workflowId ${workflowId} is not declared by this workspace.`);
    }
    const scoring = validateWorkspaceRouteScoring(d.scoring, label);
    return { routeKind, workflowId, scoring };
  });
}

function validateWorkspaceRouteScoring(value: unknown, label: string): WorkspaceRouteDefinition["scoring"] {
  const d = asRecord(value, `${label}.scoring`);
  assertAllowedKeys(d, ["keywordPatterns", "contextFlags", "threshold"], `${label}.scoring`);
  const keywordPatternsValue = d.keywordPatterns;
  if (!Array.isArray(keywordPatternsValue) || keywordPatternsValue.length > MAX_WORKSPACE_ROUTE_PATTERN_COUNT) {
    throw new Error(`${label}.scoring.keywordPatterns must contain at most ${MAX_WORKSPACE_ROUTE_PATTERN_COUNT} items.`);
  }
  const keywordPatterns = keywordPatternsValue.map((raw, index) => {
    const patternLabel = `${label}.scoring.keywordPatterns[${index}]`;
    const pattern = asRecord(raw, patternLabel);
    assertAllowedKeys(pattern, ["pattern", "weight", "signalName"], patternLabel);
    const patternText = requiredText(pattern.pattern, `${patternLabel}.pattern`, MAX_WORKSPACE_ROUTE_PATTERN_LENGTH);
    compileWorkspaceRoutePattern(patternText, patternLabel);
    return {
      pattern: patternText,
      weight: boundedInteger(pattern.weight, `${patternLabel}.weight`, 1, 100),
      signalName: requiredText(pattern.signalName, `${patternLabel}.signalName`, MAX_WORKSPACE_ROUTE_SIGNAL_LENGTH),
    };
  });
  const contextFlags = d.contextFlags === undefined
    ? undefined
    : parseWorkspaceRouteContextFlags(d.contextFlags, label);
  const threshold = d.threshold === undefined
    ? undefined
    : boundedInteger(d.threshold, `${label}.scoring.threshold`, 0, 1_000);
  return { keywordPatterns, ...(contextFlags ? { contextFlags } : {}), ...(threshold === undefined ? {} : { threshold }) };
}

function compileWorkspaceRoutePattern(pattern: string, label: string): RegExp {
  assertSafeWorkspaceRoutePattern(pattern, label);
  try {
    return new RegExp(pattern, "i");
  } catch {
    throw new Error(`${label}.pattern is not a valid regular expression.`);
  }
}

/**
 * JavaScript regular expressions have no synchronous execution timeout. Keep
 * workspace-owned patterns within a conservative dialect whose backtracking
 * cannot grow exponentially with a user-controlled goal.
 */
function assertSafeWorkspaceRoutePattern(pattern: string, label: string): void {
  let groupDepth = 0;
  let groupCount = 0;
  let inCharacterClass = false;
  let escaped = false;
  let previousAtom: "none" | "atom" | "group" | "quantified" = "none";
  let quantifierCount = 0;
  let quantifierCountInBranch = 0;

  const reject = (reason: string): never => {
    throw new Error(`${label}.pattern is potentially unsafe: ${reason}`);
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      if (/^[0-9]$/u.test(char) || char === "k") {
        reject("backreferences are not allowed");
      }
      escaped = false;
      if (!inCharacterClass) previousAtom = "atom";
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (char === "]") inCharacterClass = false;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      previousAtom = "atom";
      continue;
    }
    if (char === "(") {
      if (pattern[index + 1] === "?") {
        reject("lookarounds and inline group modifiers are not allowed");
      }
      groupCount += 1;
      if (groupCount > 8 || groupDepth > 0) {
        reject("nested or excessive groups are not allowed");
      }
      groupDepth += 1;
      previousAtom = "group";
      continue;
    }
    if (char === ")") {
      if (groupDepth > 0) groupDepth -= 1;
      previousAtom = "group";
      continue;
    }
    if (char === "|") {
      if (groupDepth === 0) quantifierCountInBranch = 0;
      previousAtom = "none";
      continue;
    }
    if (char === "*" || char === "+" || char === "?" || char === "{") {
      if (previousAtom === "none" || previousAtom === "quantified") {
        // The RegExp constructor below reports malformed quantifier syntax.
        continue;
      }
      if (previousAtom === "group") {
        reject("quantifying a group is not allowed");
      }

      if (char === "{") {
        const closing = pattern.indexOf("}", index + 1);
        const range = closing < 0 ? "" : pattern.slice(index + 1, closing);
        const match = /^(\d+)(?:(,)(\d*)?)?$/u.exec(range);
        if (!match) {
          // A non-quantifier `{` is a literal in JavaScript regex syntax.
          previousAtom = "atom";
          continue;
        }
        const hasComma = match[2] !== undefined;
        const upper = hasComma
          ? (match[3] === "" ? Number.POSITIVE_INFINITY : Number(match[3]))
          : Number(match[1]);
        const lower = Number(match[1]);
        if (
          lower > MAX_ROUTE_REGEX_BOUNDED_REPEAT ||
          (Number.isFinite(upper) && upper > MAX_ROUTE_REGEX_BOUNDED_REPEAT)
        ) {
          reject(`repeat bounds must not exceed ${MAX_ROUTE_REGEX_BOUNDED_REPEAT}`);
        }
        index = closing;
      }

      quantifierCount += 1;
      if (quantifierCount > MAX_ROUTE_REGEX_QUANTIFIERS) {
        reject("too many quantifiers");
      }
      quantifierCountInBranch += 1;
      if (quantifierCountInBranch > MAX_ROUTE_REGEX_QUANTIFIERS_PER_BRANCH) {
        reject("only one quantifier is allowed per top-level alternative");
      }
      previousAtom = "quantified";
      continue;
    }
    previousAtom = "atom";
  }
}

function parseWorkspaceRouteContextFlags(value: unknown, label: string): NonNullable<WorkspaceRouteDefinition["scoring"]["contextFlags"]> {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_ROUTE_PATTERN_COUNT) {
    throw new Error(`${label}.scoring.contextFlags must contain at most ${MAX_WORKSPACE_ROUTE_PATTERN_COUNT} items.`);
  }
  return value.map((raw, index) => {
    const flagLabel = `${label}.scoring.contextFlags[${index}]`;
    const flag = asRecord(raw, flagLabel);
    assertAllowedKeys(flag, ["flag", "weight", "signalName"], flagLabel);
    return {
      flag: requiredText(flag.flag, `${flagLabel}.flag`, MAX_WORKSPACE_ROUTE_SIGNAL_LENGTH, KEBAB_CASE_PATTERN),
      weight: boundedInteger(flag.weight, `${flagLabel}.weight`, 1, 100),
      signalName: requiredText(flag.signalName, `${flagLabel}.signalName`, MAX_WORKSPACE_ROUTE_SIGNAL_LENGTH),
    };
  });
}

function validateWorkspaceRouteKind(
  value: unknown,
  label: string,
  workspaceId: string,
): WorkspaceRouteDefinition["routeKind"] {
  const routeKind = requiredText(value, label, MAX_WORKSPACE_ROUTE_KIND_LENGTH);
  if (BUILT_IN_ROUTE_KINDS.has(routeKind)) {
    throw new Error(`${label} ${routeKind} is reserved for built-in routing.`);
  }
  const prefix = `workspace.${workspaceId}.`;
  const localKind = routeKind.startsWith(prefix) ? routeKind.slice(prefix.length) : "";
  if (!localKind || !KEBAB_CASE_PATTERN.test(localKind)) {
    throw new Error(`${label} must use the namespace ${prefix}<kebab-case-route>.`);
  }
  return routeKind;
}

function parseTextArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} items.`);
  }
  return value.map((item, index) => requiredText(item, `${label}[${index}]`, maxLength));
}

function parseIdArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} items.`);
  }
  return value.map((item, index) => requiredText(item, `${label}[${index}]`, 96, KEBAB_CASE_PATTERN));
}

function parseAgentKindArray(
  value: unknown,
  label: string,
  maxItems: number,
  allowedAgentKinds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new Error(`${label} must contain 1-${maxItems} items.`);
  }
  const kinds = value.map((item, index) => enumText(item, `${label}[${index}]`, allowedAgentKinds));
  if (new Set(kinds).size !== kinds.length) throw new Error(`${label} contains duplicates.`);
  return kinds;
}

function validateWorkspaceAgentKind(
  value: unknown,
  label: string,
  workspaceId: string,
): WorkspaceAgentDefinition["kind"] {
  const kind = requiredText(value, label, 120);
  const prefix = `workspace.${workspaceId}.`;
  const localKind = kind.startsWith(prefix) ? kind.slice(prefix.length) : "";
  if (!localKind || !KEBAB_CASE_PATTERN.test(localKind)) {
    throw new Error(`${label} must use the namespace ${prefix}<kebab-case-kind>.`);
  }
  return kind as WorkspaceAgentDefinition["kind"];
}

function parseCapabilityArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_STEP_CAPABILITY_COUNT) {
    throw new Error(`${label} must contain at most ${MAX_WORKSPACE_STEP_CAPABILITY_COUNT} items.`);
  }
  const capabilities = value.map((item, index) => requiredText(item, `${label}[${index}]`, 80));
  if (capabilities.some((capability) => !isValidCapabilityTag(capability))) {
    throw new Error(`${label} contains an unsupported capability tag.`);
  }
  if (new Set(capabilities).size !== capabilities.length) throw new Error(`${label} contains duplicates.`);
  return capabilities;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} contains unsupported field ${unknown}.`);
}

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if (!allowEmpty && value.trim().length === 0) throw new Error(`${label} must not be empty.`);
  if (value.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)) {
    throw new Error(`${label} contains control characters.`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} has an invalid format.`);
  return value.trim();
}

function enumText(value: unknown, label: string, allowed: ReadonlySet<string>): string {
  const text = requiredText(value, label, 120);
  if (!allowed.has(text)) throw new Error(`${label} has unsupported value ${text}.`);
  return text;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
