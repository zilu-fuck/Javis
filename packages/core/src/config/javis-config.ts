/**
 * `.javis/` configuration model (C1).
 *
 * One place to declare what a Javis install may do — agents, hooks, tools,
 * skills, plugins — instead of editing source. The model is deliberately
 * data-only: nothing here executes user code, so a shared or checked-in config
 * cannot escalate beyond what the native approval boundary already allows.
 *
 * Layering follows the convention every harness ends up with:
 *
 *   builtin  <  user (`%APPDATA%/javis/`)  <  project (`<workspace>/.javis/`)
 *
 * Later layers win for scalars and replace-by-id for declared items, so a
 * project can override one agent without restating the whole file.
 */

export const JAVIS_CONFIG_DIR = ".javis";
export const JAVIS_CONFIG_FILE = "config.json";
export const JAVIS_CONFIG_VERSION = 1;

/** Hook action kinds this build understands. */
export const JAVIS_HOOK_ACTION_KINDS: readonly JavisHookDeclaration["action"]["kind"][] = [
  "deny",
  "requireApproval",
  "annotate",
  "notify",
];

export type ConfigScope = "builtin" | "user" | "project";

/** Lowest precedence first. */
export const CONFIG_SCOPE_PRECEDENCE: readonly ConfigScope[] = ["builtin", "user", "project"];

export interface ConfigDiagnostic {
  severity: "error" | "warning";
  /** JSON-pointer-ish location, e.g. `agents[2].kind`. */
  path: string;
  message: string;
}

export interface JavisHookDeclaration {
  id: string;
  phase: "beforeToolCall" | "afterToolCall" | "beforeApproval" | "onTaskFail";
  /** Tool name this hook applies to; `*` matches every tool. Defaults to `*`. */
  tool?: string;
  /**
   * Declarative action. Arbitrary code hooks are intentionally not supported:
   * they would move the security boundary without a sandbox to enforce it.
   */
  action:
    | { kind: "deny"; reason: string }
    | { kind: "requireApproval"; reason: string }
    | { kind: "annotate"; field: string; value: string }
    | { kind: "notify"; message: string };
  enabled?: boolean;
}

export interface JavisAgentDeclaration {
  kind: string;
  displayName?: string;
  description?: string;
  /** Replaces the builtin allowlist when present. */
  allowedToolNames?: string[];
  /** Appended to the builtin allowlist when present. */
  additionalToolNames?: string[];
  modelSlot?: "primary" | "secondary" | "tertiary";
  maxIterations?: number;
  systemPrompt?: { en?: string; zhCN?: string };
}

export interface JavisToolDeclaration {
  name: string;
  summary?: string;
  permissionLevel?: "read" | "preview" | "confirmed_write" | "dangerous";
  capabilityTags?: string[];
  ownerAgentKinds?: string[];
  /** Declared tool is considered unavailable unless this stays false. */
  disabled?: boolean;
}

export interface JavisSkillDeclaration {
  id: string;
  title?: string;
  description?: string;
  /** Workspace- or user-relative directory holding the skill package. */
  path: string;
  enabled?: boolean;
}

export interface JavisPluginDeclaration {
  id: string;
  /** npm package or local path; installation is a separate, approved step. */
  source: string;
  version?: string;
  enabled?: boolean;
}

export interface JavisConfigDocument {
  version: number;
  agents?: JavisAgentDeclaration[];
  hooks?: JavisHookDeclaration[];
  tools?: JavisToolDeclaration[];
  skills?: JavisSkillDeclaration[];
  plugins?: JavisPluginDeclaration[];
}

export interface JavisConfigLayer {
  scope: ConfigScope;
  /** Absolute path the layer was read from, for diagnostics. */
  path?: string;
  document: JavisConfigDocument;
  /** Diagnostics produced while parsing this layer, carried into the result. */
  diagnostics?: ConfigDiagnostic[];
}

export interface ResolvedJavisConfig {
  agents: JavisAgentDeclaration[];
  hooks: JavisHookDeclaration[];
  tools: JavisToolDeclaration[];
  skills: JavisSkillDeclaration[];
  plugins: JavisPluginDeclaration[];
  /** Which scope supplied each declared id, for `javis config explain`. */
  origins: Record<string, ConfigScope>;
  diagnostics: ConfigDiagnostic[];
}

/** Parses one config document, returning usable data plus diagnostics. */
export function parseJavisConfigDocument(
  text: string,
  origin: string,
): { document?: JavisConfigDocument; diagnostics: ConfigDiagnostic[] } {
  const diagnostics: ConfigDiagnostic[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      diagnostics: [{
        severity: "error",
        path: origin,
        message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      diagnostics: [{ severity: "error", path: origin, message: "must contain a JSON object." }],
    };
  }

  const record = raw as Record<string, unknown>;
  const version = typeof record.version === "number" ? record.version : JAVIS_CONFIG_VERSION;
  if (version !== JAVIS_CONFIG_VERSION) {
    diagnostics.push({
      severity: "warning",
      path: `${origin}.version`,
      message: `declares version ${version}; this build understands ${JAVIS_CONFIG_VERSION}.`,
    });
  }

  return {
    document: {
      version,
      agents: validateList<JavisAgentDeclaration>(record.agents, "agents", origin, diagnostics, validateAgent),
      hooks: validateList<JavisHookDeclaration>(record.hooks, "hooks", origin, diagnostics, validateHook),
      tools: validateList<JavisToolDeclaration>(record.tools, "tools", origin, diagnostics, validateTool),
      skills: validateList<JavisSkillDeclaration>(record.skills, "skills", origin, diagnostics, validateSkill),
      plugins: validateList<JavisPluginDeclaration>(record.plugins, "plugins", origin, diagnostics, validatePlugin),
    },
    diagnostics,
  };
}

function validateList<T>(
  value: unknown,
  field: string,
  origin: string,
  diagnostics: ConfigDiagnostic[],
  validateItem: (item: unknown, path: string, diagnostics: ConfigDiagnostic[]) => T | undefined,
): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({ severity: "error", path: `${origin}.${field}`, message: "must be an array." });
    return undefined;
  }
  const items: T[] = [];
  value.forEach((item, index) => {
    const validated = validateItem(item, `${origin}.${field}[${index}]`, diagnostics);
    if (validated) {
      items.push(validated);
    }
  });
  return items;
}

function validateAgent(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
): JavisAgentDeclaration | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) {
    diagnostics.push({ severity: "error", path, message: "agent requires a non-empty kind." });
    return undefined;
  }
  return {
    kind: value.kind,
    ...(isNonEmptyString(value.displayName) ? { displayName: value.displayName } : {}),
    ...(isNonEmptyString(value.description) ? { description: value.description } : {}),
    ...(isStringArray(value.allowedToolNames) ? { allowedToolNames: value.allowedToolNames } : {}),
    ...(isStringArray(value.additionalToolNames) ? { additionalToolNames: value.additionalToolNames } : {}),
    ...(isModelSlot(value.modelSlot) ? { modelSlot: value.modelSlot } : {}),
    ...(isPositiveInteger(value.maxIterations) ? { maxIterations: value.maxIterations } : {}),
    ...(isPromptSet(value.systemPrompt) ? { systemPrompt: value.systemPrompt } : {}),
  };
}

const HOOK_PHASES = ["beforeToolCall", "afterToolCall", "beforeApproval", "onTaskFail"] as const;

function validateHook(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
): JavisHookDeclaration | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    diagnostics.push({ severity: "error", path, message: "hook requires a non-empty id." });
    return undefined;
  }
  if (!isNonEmptyString(value.phase) || !(HOOK_PHASES as readonly string[]).includes(value.phase)) {
    diagnostics.push({
      severity: "error",
      path: `${path}.phase`,
      message: `hook phase must be one of: ${HOOK_PHASES.join(", ")}.`,
    });
    return undefined;
  }
  const action = validateHookAction(value.action, `${path}.action`, diagnostics);
  if (!action) {
    return undefined;
  }
  return {
    id: value.id,
    phase: value.phase as JavisHookDeclaration["phase"],
    ...(isNonEmptyString(value.tool) ? { tool: value.tool } : {}),
    action,
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
  };
}

function validateHookAction(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
): JavisHookDeclaration["action"] | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) {
    diagnostics.push({
      severity: "error",
      path,
      message: "hook action requires a kind: deny, requireApproval, annotate or notify.",
    });
    return undefined;
  }
  switch (value.kind) {
    case "deny":
      if (!isNonEmptyString(value.reason)) {
        diagnostics.push({ severity: "error", path: `${path}.reason`, message: "deny requires a reason." });
        return undefined;
      }
      return { kind: "deny", reason: value.reason };
    case "requireApproval":
      if (!isNonEmptyString(value.reason)) {
        diagnostics.push({ severity: "error", path: `${path}.reason`, message: "requireApproval requires a reason." });
        return undefined;
      }
      return { kind: "requireApproval", reason: value.reason };
    case "annotate":
      if (!isNonEmptyString(value.field) || !isNonEmptyString(value.value)) {
        diagnostics.push({ severity: "error", path, message: "annotate requires field and value." });
        return undefined;
      }
      return { kind: "annotate", field: value.field, value: value.value };
    case "notify":
      if (!isNonEmptyString(value.message)) {
        diagnostics.push({ severity: "error", path: `${path}.message`, message: "notify requires a message." });
        return undefined;
      }
      return { kind: "notify", message: value.message };
    default:
      // Arbitrary code hooks are not a config feature: they would move the
      // security boundary without a sandbox to enforce it.
      diagnostics.push({
        severity: "error",
        path: `${path}.kind`,
        message: `unsupported hook action "${String(value.kind)}"; supported: deny, requireApproval, annotate, notify.`,
      });
      return undefined;
  }
}

function validateTool(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
): JavisToolDeclaration | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.name)) {
    diagnostics.push({ severity: "error", path, message: "tool requires a non-empty name." });
    return undefined;
  }
  return {
    name: value.name,
    ...(isNonEmptyString(value.summary) ? { summary: value.summary } : {}),
    ...(isPermissionLevel(value.permissionLevel) ? { permissionLevel: value.permissionLevel } : {}),
    ...(isStringArray(value.capabilityTags) ? { capabilityTags: value.capabilityTags } : {}),
    ...(isStringArray(value.ownerAgentKinds) ? { ownerAgentKinds: value.ownerAgentKinds } : {}),
    ...(typeof value.disabled === "boolean" ? { disabled: value.disabled } : {}),
  };
}

function validateSkill(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
): JavisSkillDeclaration | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.path)) {
    diagnostics.push({ severity: "error", path, message: "skill requires id and path." });
    return undefined;
  }
  return {
    id: value.id,
    path: value.path,
    ...(isNonEmptyString(value.title) ? { title: value.title } : {}),
    ...(isNonEmptyString(value.description) ? { description: value.description } : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
  };
}

function validatePlugin(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
): JavisPluginDeclaration | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.source)) {
    diagnostics.push({ severity: "error", path, message: "plugin requires id and source." });
    return undefined;
  }
  return {
    id: value.id,
    source: value.source,
    ...(isNonEmptyString(value.version) ? { version: value.version } : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
  };
}

/**
 * Merges layers from lowest to highest precedence.
 *
 * Scalars and per-id declarations: the highest scope wins. Items are keyed by
 * `kind` (agents), `id` (hooks/skills/plugins) and `name` (tools) so a project
 * layer can override a single entry without restating the rest.
 */
export function resolveJavisConfig(layers: readonly JavisConfigLayer[]): ResolvedJavisConfig {
  const ordered = [...layers].sort(
    (left, right) =>
      CONFIG_SCOPE_PRECEDENCE.indexOf(left.scope) - CONFIG_SCOPE_PRECEDENCE.indexOf(right.scope),
  );

  const agents = new Map<string, JavisAgentDeclaration>();
  const hooks = new Map<string, JavisHookDeclaration>();
  const tools = new Map<string, JavisToolDeclaration>();
  const skills = new Map<string, JavisSkillDeclaration>();
  const plugins = new Map<string, JavisPluginDeclaration>();
  const origins: Record<string, ConfigScope> = {};
  const diagnostics: ConfigDiagnostic[] = [];

  for (const layer of ordered) {
    for (const agent of layer.document.agents ?? []) {
      agents.set(agent.kind, agent);
      origins[`agent:${agent.kind}`] = layer.scope;
    }
    for (const hook of layer.document.hooks ?? []) {
      hooks.set(hook.id, hook);
      origins[`hook:${hook.id}`] = layer.scope;
    }
    for (const tool of layer.document.tools ?? []) {
      const previous = tools.get(tool.name);
      tools.set(tool.name, previous ? { ...previous, ...tool } : tool);
      origins[`tool:${tool.name}`] = layer.scope;
    }
    for (const skill of layer.document.skills ?? []) {
      skills.set(skill.id, skill);
      origins[`skill:${skill.id}`] = layer.scope;
    }
    for (const plugin of layer.document.plugins ?? []) {
      plugins.set(plugin.id, plugin);
      origins[`plugin:${plugin.id}`] = layer.scope;
    }

    // Disabled declarations are how a scope removes an inherited entry.
    for (const hook of layer.document.hooks ?? []) {
      if (hook.enabled === false) {
        hooks.delete(hook.id);
      }
    }
    for (const plugin of layer.document.plugins ?? []) {
      if (plugin.enabled === false) {
        plugins.delete(plugin.id);
      }
    }
    for (const skill of layer.document.skills ?? []) {
      if (skill.enabled === false) {
        skills.delete(skill.id);
      }
    }
    for (const tool of layer.document.tools ?? []) {
      if (tool.disabled === true) {
        tools.delete(tool.name);
      }
    }
    diagnostics.push(...(layer.diagnostics ?? []));
  }

  return {
    agents: [...agents.values()],
    hooks: [...hooks.values()],
    tools: [...tools.values()],
    skills: [...skills.values()],
    plugins: [...plugins.values()],
    origins,
    diagnostics,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isModelSlot(value: unknown): value is JavisAgentDeclaration["modelSlot"] {
  return value === "primary" || value === "secondary" || value === "tertiary";
}

function isPermissionLevel(value: unknown): value is JavisToolDeclaration["permissionLevel"] {
  return value === "read" || value === "preview" || value === "confirmed_write" || value === "dangerous";
}

function isPromptSet(value: unknown): value is { en?: string; zhCN?: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (value.en === undefined || typeof value.en === "string")
    && (value.zhCN === undefined || typeof value.zhCN === "string")
    && (typeof value.en === "string" || typeof value.zhCN === "string");
}
