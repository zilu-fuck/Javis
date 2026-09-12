/**
 * Plugin manifest model (C6).
 *
 * A plugin is a package that wants to contribute agents, tools, hooks and skills.
 * The security-relevant decision is that a plugin **declares** what it wants and
 * the host **grants** a subset: installing is a separate, approved step, and the
 * manifest alone can never widen the trust boundary.
 *
 * The refusals below are the whole point of the module:
 *
 *  * `dangerous` tool permission and any `exec`-style hook action are refused
 *    outright, because a plugin cannot be given the ability to run arbitrary code
 *    through the configuration channel;
 *  * `confirmed_write` is not *granted* by the manifest — it is marked as requiring
 *    the native approval flow, so a plugin's writes go through the same boundary as
 *    everything else;
 *  * contributions are additive; a plugin may not redefine a builtin tool or agent
 *    kind (that would be a supply-chain way to shadow behaviour).
 */

import type { JavisAgentDeclaration, JavisHookDeclaration, JavisToolDeclaration } from "./javis-config";

export const PLUGIN_MANIFEST_VERSION = 1;

export interface JavisPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Declared capabilities the plugin would like granted. */
  requestedCapabilities: PluginRequestedCapability[];
  agents?: JavisAgentDeclaration[];
  tools?: JavisToolDeclaration[];
  hooks?: JavisHookDeclaration[];
  skills?: Array<{ id: string; path: string }>;
}

export type PluginRequestedCapability =
  | "read_tools"
  | "preview_tools"
  | "confirmed_write_tools"
  | "network_access"
  | "filesystem_write"
  | "process_spawn"
  | "background_schedule";

export interface PluginDiagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface PluginInstallPlan {
  manifest?: JavisPluginManifest;
  /** Capabilities the host will grant. */
  granted: PluginRequestedCapability[];
  /** Capabilities the host refuses, with the reason. */
  refused: Array<{ capability: PluginRequestedCapability; reason: string }>;
  /** Contributions the plugin may register, after shadowing checks. */
  contributions: {
    agents: JavisAgentDeclaration[];
    tools: JavisToolDeclaration[];
    hooks: JavisHookDeclaration[];
    skills: Array<{ id: string; path: string }>;
  };
  /** True when the plan still needs an explicit user approval before install. */
  requiresApproval: true;
  diagnostics: PluginDiagnostic[];
}

const ALL_CAPABILITIES: readonly PluginRequestedCapability[] = [
  "read_tools",
  "preview_tools",
  "confirmed_write_tools",
  "network_access",
  "filesystem_write",
  "process_spawn",
  "background_schedule",
];

const REFUSED_CAPABILITIES: Partial<Record<PluginRequestedCapability, string>> = {
  process_spawn: "a plugin may not spawn processes; that capability lives behind the native sandbox, not a manifest.",
  filesystem_write: "a plugin may not write the filesystem directly; its writes must go through a confirmed-write tool.",
};

export function isPluginCapability(value: unknown): value is PluginRequestedCapability {
  return typeof value === "string" && (ALL_CAPABILITIES as readonly string[]).includes(value);
}

export function parsePluginManifest(
  text: string,
  origin = "plugin.json",
): { manifest?: JavisPluginManifest; diagnostics: PluginDiagnostic[] } {
  const diagnostics: PluginDiagnostic[] = [];
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
    return { diagnostics: [{ severity: "error", path: origin, message: "must contain a JSON object." }] };
  }

  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const version = typeof record.version === "string" ? record.version.trim() : "";

  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    diagnostics.push({
      severity: "error",
      path: `${origin}.id`,
      message: "plugin id must be lower-kebab-case, for example \"acme-tools\".",
    });
  }
  if (name.length === 0) {
    diagnostics.push({ severity: "error", path: `${origin}.name`, message: "plugin requires a name." });
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
    diagnostics.push({
      severity: "error",
      path: `${origin}.version`,
      message: "plugin requires a semver version, for example \"1.0.0\".",
    });
  }

  const requested: PluginRequestedCapability[] = [];
  const rawCapabilities = record.capabilities;
  if (rawCapabilities !== undefined) {
    if (!Array.isArray(rawCapabilities)) {
      diagnostics.push({
        severity: "error",
        path: `${origin}.capabilities`,
        message: "capabilities must be an array.",
      });
    } else {
      rawCapabilities.forEach((capability, index) => {
        if (!isPluginCapability(capability)) {
          diagnostics.push({
            severity: "error",
            path: `${origin}.capabilities[${index}]`,
            message: `unknown capability "${String(capability)}"; known: ${ALL_CAPABILITIES.join(", ")}.`,
          });
          return;
        }
        requested.push(capability);
      });
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }

  return {
    manifest: {
      id,
      name,
      version,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      requestedCapabilities: requested,
      ...(Array.isArray(record.agents) ? { agents: record.agents as JavisAgentDeclaration[] } : {}),
      ...(Array.isArray(record.tools) ? { tools: record.tools as JavisToolDeclaration[] } : {}),
      ...(Array.isArray(record.hooks) ? { hooks: record.hooks as JavisHookDeclaration[] } : {}),
      ...(Array.isArray(record.skills) ? { skills: record.skills as Array<{ id: string; path: string }> } : {}),
    },
    diagnostics,
  };
}

/**
 * Decides what a manifest may contribute. Never installs anything: the caller shows
 * the plan and asks for approval, matching every other write path in Javis.
 */
export function planPluginInstall(
  manifest: JavisPluginManifest,
  context: {
    /** Builtin agent kinds a plugin must not redefine. */
    builtinAgentKinds?: readonly string[];
    /** Builtin tool names a plugin must not shadow. */
    builtinToolNames?: readonly string[];
  } = {},
): PluginInstallPlan {
  const diagnostics: PluginDiagnostic[] = [];
  const granted: PluginRequestedCapability[] = [];
  const refused: Array<{ capability: PluginRequestedCapability; reason: string }> = [];

  for (const capability of manifest.requestedCapabilities) {
    const refusal = REFUSED_CAPABILITIES[capability];
    if (refusal !== undefined) {
      refused.push({ capability, reason: refusal });
      continue;
    }
    if (capability === "confirmed_write_tools") {
      // Grantable, but only ever through the normal approval flow.
      granted.push(capability);
      diagnostics.push({
        severity: "warning",
        path: `plugin:${manifest.id}.capabilities`,
        message: "confirmed_write_tools is granted, but every write still requires native user approval.",
      });
      continue;
    }
    granted.push(capability);
  }

  const builtinAgentKinds = new Set((context.builtinAgentKinds ?? []).map((kind) => kind.toLowerCase()));
  const builtinToolNames = new Set(context.builtinToolNames ?? []);

  const agents = (manifest.agents ?? []).filter((agent) => {
    if (builtinAgentKinds.has(agent.kind.toLowerCase())) {
      diagnostics.push({
        severity: "error",
        path: `plugin:${manifest.id}.agents`,
        message: `refusing to redefine builtin agent kind "${agent.kind}".`,
      });
      return false;
    }
    return true;
  });

  const tools = (manifest.tools ?? []).filter((tool) => {
    if (builtinToolNames.has(tool.name)) {
      diagnostics.push({
        severity: "error",
        path: `plugin:${manifest.id}.tools`,
        message: `refusing to shadow builtin tool "${tool.name}".`,
      });
      return false;
    }
    if (tool.permissionLevel === "dangerous") {
      diagnostics.push({
        severity: "error",
        path: `plugin:${manifest.id}.tools`,
        message: `refusing "dangerous" permission for plugin tool "${tool.name}".`,
      });
      return false;
    }
    return true;
  });

  const hooks = (manifest.hooks ?? []).filter((hook) => {
    // Code-executing hook actions do not exist in the model; anything else the
    // parser rejected already never reached this point. Keep the guard explicit.
    const kind = (hook.action as { kind?: string } | undefined)?.kind;
    if (kind !== "deny" && kind !== "requireApproval" && kind !== "annotate" && kind !== "notify") {
      diagnostics.push({
        severity: "error",
        path: `plugin:${manifest.id}.hooks`,
        message: `refusing unsupported hook action "${String(kind)}" from a plugin.`,
      });
      return false;
    }
    return true;
  });

  return {
    manifest,
    granted,
    refused,
    contributions: {
      agents,
      tools,
      hooks,
      skills: manifest.skills ?? [],
    },
    requiresApproval: true,
    diagnostics,
  };
}
