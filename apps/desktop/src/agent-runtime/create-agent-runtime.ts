import type {
  AgentRuntime,
  AgentRuntimeBackend,
  AgentRuntimeRoutingDecision,
  AgentKind,
  AgentToolSpec,
  ToolExecutionGateway,
} from "@javis/core";
import { getAdapter } from "@javis/core";
import type { PermissionLevel } from "@javis/tools";
import type { ModelProvider } from "../model-provider";
import { createAgentModelGateway } from "./agent-model-gateway";
import { createLangChainAgentRuntime } from "./langchain/runner";
import {
  createOpenCodeAgentRuntime,
  type OpenCodeProposalRunner,
} from "./opencode/runner";

export const AGENT_RUNTIME_BACKEND_STORAGE_KEY = "javis.agentRuntimeBackend";
export const AGENT_RUNTIME_ROLLOUT_STORAGE_KEY = "javis.agentRuntimeRollout";

export interface AgentRuntimeRolloutConfig {
  agentKinds?: readonly AgentKind[];
  taskIds?: readonly string[];
  permissionLevels?: readonly Extract<PermissionLevel, "read" | "preview">[];
  previewToolNames?: readonly string[];
  verifiedModelProfiles?: readonly {
    provider: string;
    model: string;
  }[];
}

export function resolveAgentRuntimeBackend(
  storage: Pick<Storage, "getItem"> | undefined = readGlobalStorage(),
  settings?: Pick<ModelProvider["settings"], "provider">,
): AgentRuntimeBackend {
  try {
    if (storage?.getItem(AGENT_RUNTIME_BACKEND_STORAGE_KEY) !== "langchain") {
      return "legacy";
    }
    return settings && getAdapter(settings.provider).capabilities.nativeToolCalling === false
      ? "legacy"
      : "langchain";
  } catch {
    return "legacy";
  }
}

export function resolveReadOnlyPocAgentRuntimeBackend(
  agentKind: AgentKind,
  settings: Pick<ModelProvider["settings"], "provider">,
  storage: Pick<Storage, "getItem"> | undefined = readGlobalStorage(),
): AgentRuntimeBackend {
  return agentKind === "research"
    ? resolveAgentRuntimeBackend(storage, settings)
    : "legacy";
}

export function resolveCommanderStepAgentRuntimeBackend(
  agentKind: AgentKind,
  taskId: string,
  settings: Pick<ModelProvider["settings"], "provider" | "model">,
  storage: Pick<Storage, "getItem"> | undefined = readGlobalStorage(),
  permissionLevel: PermissionLevel = "read",
  toolName?: string,
  primaryCapability?: string,
): AgentRuntimeBackend {
  const backend = resolveCommanderStepAgentRuntimeRoutingDecision(
    agentKind,
    taskId,
    settings,
    storage,
    permissionLevel,
    toolName,
    primaryCapability,
  ).backend;
  return backend === "legacy" || backend === "langchain" || backend === "opencode"
    ? backend
    : "legacy";
}

export function resolveCommanderStepAgentRuntimeRoutingDecision(
  agentKind: AgentKind,
  taskId: string,
  settings: Pick<ModelProvider["settings"], "provider" | "model">,
  storage: Pick<Storage, "getItem"> | undefined = readGlobalStorage(),
  permissionLevel: PermissionLevel = "read",
  toolName?: string,
  primaryCapability?: string,
): AgentRuntimeRoutingDecision {
  const resolvedPrimaryCapability = primaryCapability ?? inferPrimaryCapability(toolName);
  if (permissionLevel === "preview" && resolvedPrimaryCapability === "code_propose") {
    if (!settings.provider.trim() || !settings.model.trim()) {
      return {
        backend: "unavailable",
        rolloutTargeted: true,
        fallbackReason: "runtime_factory_unavailable",
      };
    }
    return {
      backend: "opencode",
      rolloutTargeted: true,
      selectionReason: "phase2_code_propose",
    };
  }
  const rollout = readAgentRuntimeRollout(storage);
  const matchedRolloutScope = Boolean(
    rollout?.agentKinds?.includes(agentKind) || rollout?.taskIds?.includes(taskId),
  );
  const verifiedModelProfile = rollout?.verifiedModelProfiles?.some((profile) =>
    profile.provider === settings.provider.trim().toLowerCase() &&
    profile.model === settings.model.trim()
  ) === true;
  const targetedByRollout = matchedRolloutScope && verifiedModelProfile;
  const targeted = permissionLevel === "read"
    ? targetedByRollout || (readGlobalLangChainSwitch(storage) && verifiedModelProfile)
    : permissionLevel === "preview"
      ? targetedByRollout &&
        (rollout?.permissionLevels ?? ["read"]).includes("preview") &&
        typeof toolName === "string" && rollout?.previewToolNames?.includes(toolName) === true
      : false;
  if (!targeted) {
    return { backend: "legacy", rolloutTargeted: false };
  }
  const normalizedProvider = settings.provider.trim().toLowerCase();
  const adapter = getAdapter(normalizedProvider);
  if (adapter.adapterId !== normalizedProvider ||
    adapter.capabilities.nativeToolCalling === false) {
    return {
      backend: "legacy",
      rolloutTargeted: true,
      fallbackReason: "native_tool_call_unavailable",
    };
  }
  return { backend: "langchain", rolloutTargeted: true };
}

function inferPrimaryCapability(toolName: string | undefined): string | undefined {
  switch (toolName) {
    case "code.proposeEdit":
      return "code_propose";
    case "code.searchRepository":
      return "code_search";
    case "code.traceCallChain":
      return "code_trace";
    case "code.inspectRepository":
      return "code_explore";
    default:
      return undefined;
  }
}

function readGlobalLangChainSwitch(
  storage: Pick<Storage, "getItem"> | undefined,
): boolean {
  try {
    return storage?.getItem(AGENT_RUNTIME_BACKEND_STORAGE_KEY) === "langchain";
  } catch {
    return false;
  }
}

export function createDesktopAgentRuntime(options: {
  modelProvider: ModelProvider;
  toolGateway: ToolExecutionGateway;
  toolSpecs: readonly AgentToolSpec[];
}): AgentRuntime {
  const modelGateway = createAgentModelGateway(options.modelProvider.settings);
  if (!modelGateway.capabilities().nativeToolCalling) {
    throw new Error(
      `Provider ${options.modelProvider.settings.provider} cannot create a native Tool Call runtime.`,
    );
  }
  return createLangChainAgentRuntime({
    modelGateway,
    toolGateway: options.toolGateway,
    toolSpecs: options.toolSpecs,
  });
}

export function createDesktopOpenCodeAgentRuntime(options: {
  proposeEdit: OpenCodeProposalRunner;
}): AgentRuntime {
  return createOpenCodeAgentRuntime(options);
}

function readGlobalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readAgentRuntimeRollout(
  storage: Pick<Storage, "getItem"> | undefined,
): AgentRuntimeRolloutConfig | undefined {
  try {
    const raw = storage?.getItem(AGENT_RUNTIME_ROLLOUT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const agentKinds = parseRolloutStrings(parsed.agentKinds, 160);
    const taskIds = parseRolloutStrings(parsed.taskIds, 128);
    const permissionLevels = parseRolloutPermissionLevels(parsed.permissionLevels);
    const previewToolNames = parseRolloutStrings(parsed.previewToolNames, 160);
    const verifiedModelProfiles = parseVerifiedModelProfiles(parsed.verifiedModelProfiles);
    if (agentKinds === null || taskIds === null || permissionLevels === null ||
      previewToolNames === null || verifiedModelProfiles === null) return undefined;
    return {
      ...(agentKinds ? { agentKinds: agentKinds as AgentKind[] } : {}),
      ...(taskIds ? { taskIds } : {}),
      ...(permissionLevels ? { permissionLevels } : {}),
      ...(previewToolNames ? { previewToolNames } : {}),
      ...(verifiedModelProfiles ? { verifiedModelProfiles } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseVerifiedModelProfiles(
  value: unknown,
): Array<{ provider: string; model: string }> | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) return null;
  const profiles: Array<{ provider: string; model: string }> = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.provider !== "string" ||
      typeof item.model !== "string") return null;
    const provider = item.provider.trim().toLowerCase();
    const model = item.model.trim();
    if (!provider || provider.length > 160 || !model || model.length > 200) return null;
    const key = `${provider}\u0000${model}`;
    if (keys.has(key)) return null;
    keys.add(key);
    profiles.push({ provider, model });
  }
  return profiles;
}

function parseRolloutPermissionLevels(
  value: unknown,
): Array<"read" | "preview"> | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2) return null;
  const levels = value.filter((item): item is "read" | "preview" =>
    item === "read" || item === "preview"
  );
  return levels.length === value.length && new Set(levels).size === levels.length
    ? levels
    : null;
}

function parseRolloutStrings(value: unknown, maxLength: number): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) return null;
  const values = value.filter((item): item is string =>
    typeof item === "string" && item.length > 0 && item.length <= maxLength
  );
  return values.length === value.length ? [...new Set(values)] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
