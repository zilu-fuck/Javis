import type {
  WorkbenchAppearanceTheme,
  WorkbenchRuntimePreferences,
} from "@javis/ui";
import { PREF_KEYS } from "./user-preferences-persistence";

export const DEFAULT_RUNTIME_PREFERENCES: WorkbenchRuntimePreferences = {
  appearanceTheme: "light",
  defaultStartupMode: "chat",
  contextStrategy: "auto",
  agentMaxRoundsPreset: "8",
  agentMaxRoundsCustom: 8,
  taskTimeoutPreset: "standard",
  taskTimeoutCustomMs: 90_000,
  agentMemoryScope: "workspace",
  agentMemoryEmbeddingMode: "local",
  agentMemoryEmbeddingProvider: "openai",
  agentMemoryEmbeddingModel: "text-embedding-3-small",
  agentMemoryEmbeddingBaseUrl: "https://api.openai.com/v1",
  agentMemoryEmbeddingApiKeyReference: "model.embedding",
  agentMemoryEmbeddingDimensions: 1536,
  taskQueuePolicy: "queue",
  failureRecoveryPolicy: "replan",
  userWaitTimeoutPreset: "standard",
  userWaitTimeoutCustomMs: 5 * 60_000,
};

const APPEARANCE_THEMES: readonly WorkbenchAppearanceTheme[] = [
  "light",
  "dark",
  "glass",
  "high_contrast",
];

export function runtimePreferencesFromPrefs(
  prefs: Record<string, string>,
  legacyMemoryEnabled?: string,
): WorkbenchRuntimePreferences {
  const appearanceTheme = stringChoice(
    prefs[PREF_KEYS.APPEARANCE_THEME],
    APPEARANCE_THEMES,
    DEFAULT_RUNTIME_PREFERENCES.appearanceTheme,
  );
  const defaultStartupMode = stringChoice(
    prefs[PREF_KEYS.DEFAULT_STARTUP_MODE],
    ["chat", "project", "auto"],
    DEFAULT_RUNTIME_PREFERENCES.defaultStartupMode,
  );
  const contextStrategy = stringChoice(
    prefs[PREF_KEYS.CONTEXT_STRATEGY],
    ["auto", "short", "long"],
    DEFAULT_RUNTIME_PREFERENCES.contextStrategy,
  );
  const agentMaxRoundsPreset = stringChoice(
    prefs[PREF_KEYS.AGENT_MAX_ROUNDS_PRESET],
    ["4", "8", "12", "custom"],
    DEFAULT_RUNTIME_PREFERENCES.agentMaxRoundsPreset,
  );
  const taskTimeoutPreset = stringChoice(
    prefs[PREF_KEYS.TASK_TIMEOUT_PRESET],
    ["standard", "long", "custom"],
    DEFAULT_RUNTIME_PREFERENCES.taskTimeoutPreset,
  );
  const agentMemoryScope = legacyMemoryEnabled === "false"
    ? "off"
    : stringChoice(
        prefs[PREF_KEYS.AGENT_MEMORY_SCOPE],
        ["off", "workspace", "global_workspace"],
        DEFAULT_RUNTIME_PREFERENCES.agentMemoryScope,
      );
  return {
    appearanceTheme,
    defaultStartupMode,
    contextStrategy,
    agentMaxRoundsPreset,
    agentMaxRoundsCustom: clampRuntimeInteger(
      prefs[PREF_KEYS.AGENT_MAX_ROUNDS_CUSTOM],
      1,
      24,
      DEFAULT_RUNTIME_PREFERENCES.agentMaxRoundsCustom,
    ),
    taskTimeoutPreset,
    taskTimeoutCustomMs: clampRuntimeInteger(
      prefs[PREF_KEYS.TASK_TIMEOUT_CUSTOM_MS],
      30_000,
      900_000,
      DEFAULT_RUNTIME_PREFERENCES.taskTimeoutCustomMs,
    ),
    agentMemoryScope,
    agentMemoryEmbeddingMode: stringChoice(
      prefs[PREF_KEYS.AGENT_MEMORY_EMBEDDING_MODE],
      ["local", "openai_compatible"],
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingMode,
    ),
    agentMemoryEmbeddingProvider: nonEmptyPreference(
      prefs[PREF_KEYS.AGENT_MEMORY_EMBEDDING_PROVIDER],
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingProvider,
    ),
    agentMemoryEmbeddingModel: nonEmptyPreference(
      prefs[PREF_KEYS.AGENT_MEMORY_EMBEDDING_MODEL],
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingModel,
    ),
    agentMemoryEmbeddingBaseUrl: nonEmptyPreference(
      prefs[PREF_KEYS.AGENT_MEMORY_EMBEDDING_BASE_URL],
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingBaseUrl,
    ),
    agentMemoryEmbeddingApiKeyReference: nonEmptyPreference(
      prefs[PREF_KEYS.AGENT_MEMORY_EMBEDDING_API_KEY_REFERENCE],
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingApiKeyReference,
    ),
    agentMemoryEmbeddingDimensions: clampRuntimeInteger(
      prefs[PREF_KEYS.AGENT_MEMORY_EMBEDDING_DIMENSIONS],
      32,
      4096,
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingDimensions,
    ),
    taskQueuePolicy: stringChoice(
      prefs[PREF_KEYS.TASK_QUEUE_POLICY],
      ["queue", "current_only", "interrupt"],
      DEFAULT_RUNTIME_PREFERENCES.taskQueuePolicy,
    ),
    failureRecoveryPolicy: stringChoice(
      prefs[PREF_KEYS.FAILURE_RECOVERY_POLICY],
      ["replan", "stop"],
      DEFAULT_RUNTIME_PREFERENCES.failureRecoveryPolicy,
    ),
    userWaitTimeoutPreset: stringChoice(
      prefs[PREF_KEYS.USER_WAIT_TIMEOUT_PRESET],
      ["standard", "long", "custom"],
      DEFAULT_RUNTIME_PREFERENCES.userWaitTimeoutPreset,
    ),
    userWaitTimeoutCustomMs: clampRuntimeInteger(
      prefs[PREF_KEYS.USER_WAIT_TIMEOUT_CUSTOM_MS],
      60_000,
      120 * 60_000,
      DEFAULT_RUNTIME_PREFERENCES.userWaitTimeoutCustomMs,
    ),
  };
}

export function runtimePreferencesToPrefs(
  preferences: WorkbenchRuntimePreferences,
): Record<string, string> {
  return {
    [PREF_KEYS.APPEARANCE_THEME]: preferences.appearanceTheme,
    [PREF_KEYS.DEFAULT_STARTUP_MODE]: preferences.defaultStartupMode,
    [PREF_KEYS.CONTEXT_STRATEGY]: preferences.contextStrategy,
    [PREF_KEYS.AGENT_MAX_ROUNDS_PRESET]: preferences.agentMaxRoundsPreset,
    [PREF_KEYS.AGENT_MAX_ROUNDS_CUSTOM]: String(preferences.agentMaxRoundsCustom),
    [PREF_KEYS.TASK_TIMEOUT_PRESET]: preferences.taskTimeoutPreset,
    [PREF_KEYS.TASK_TIMEOUT_CUSTOM_MS]: String(preferences.taskTimeoutCustomMs),
    [PREF_KEYS.AGENT_MEMORY_SCOPE]: preferences.agentMemoryScope,
    [PREF_KEYS.AGENT_MEMORY_EMBEDDING_MODE]: preferences.agentMemoryEmbeddingMode,
    [PREF_KEYS.AGENT_MEMORY_EMBEDDING_PROVIDER]: preferences.agentMemoryEmbeddingProvider,
    [PREF_KEYS.AGENT_MEMORY_EMBEDDING_MODEL]: preferences.agentMemoryEmbeddingModel,
    [PREF_KEYS.AGENT_MEMORY_EMBEDDING_BASE_URL]: preferences.agentMemoryEmbeddingBaseUrl,
    [PREF_KEYS.AGENT_MEMORY_EMBEDDING_API_KEY_REFERENCE]: preferences.agentMemoryEmbeddingApiKeyReference,
    [PREF_KEYS.AGENT_MEMORY_EMBEDDING_DIMENSIONS]: String(preferences.agentMemoryEmbeddingDimensions),
    [PREF_KEYS.TASK_QUEUE_POLICY]: preferences.taskQueuePolicy,
    [PREF_KEYS.FAILURE_RECOVERY_POLICY]: preferences.failureRecoveryPolicy,
    [PREF_KEYS.USER_WAIT_TIMEOUT_PRESET]: preferences.userWaitTimeoutPreset,
    [PREF_KEYS.USER_WAIT_TIMEOUT_CUSTOM_MS]: String(preferences.userWaitTimeoutCustomMs),
  };
}

export function sanitizeRuntimePreferences(
  preferences: WorkbenchRuntimePreferences,
): WorkbenchRuntimePreferences {
  return {
    appearanceTheme: stringChoice(
      preferences.appearanceTheme,
      APPEARANCE_THEMES,
      DEFAULT_RUNTIME_PREFERENCES.appearanceTheme,
    ),
    defaultStartupMode: stringChoice(
      preferences.defaultStartupMode,
      ["chat", "project", "auto"],
      DEFAULT_RUNTIME_PREFERENCES.defaultStartupMode,
    ),
    contextStrategy: stringChoice(
      preferences.contextStrategy,
      ["auto", "short", "long"],
      DEFAULT_RUNTIME_PREFERENCES.contextStrategy,
    ),
    agentMaxRoundsPreset: stringChoice(
      preferences.agentMaxRoundsPreset,
      ["4", "8", "12", "custom"],
      DEFAULT_RUNTIME_PREFERENCES.agentMaxRoundsPreset,
    ),
    agentMaxRoundsCustom: clampRuntimeInteger(
      String(preferences.agentMaxRoundsCustom),
      1,
      24,
      DEFAULT_RUNTIME_PREFERENCES.agentMaxRoundsCustom,
    ),
    taskTimeoutPreset: stringChoice(
      preferences.taskTimeoutPreset,
      ["standard", "long", "custom"],
      DEFAULT_RUNTIME_PREFERENCES.taskTimeoutPreset,
    ),
    taskTimeoutCustomMs: clampRuntimeInteger(
      String(preferences.taskTimeoutCustomMs),
      30_000,
      900_000,
      DEFAULT_RUNTIME_PREFERENCES.taskTimeoutCustomMs,
    ),
    agentMemoryScope: stringChoice(
      preferences.agentMemoryScope,
      ["off", "workspace", "global_workspace"],
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryScope,
    ),
    agentMemoryEmbeddingMode: stringChoice(
      preferences.agentMemoryEmbeddingMode,
      ["local", "openai_compatible"],
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingMode,
    ),
    agentMemoryEmbeddingProvider: normalizePreferenceText(
      preferences.agentMemoryEmbeddingProvider,
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingProvider,
    ),
    agentMemoryEmbeddingModel: normalizePreferenceText(
      preferences.agentMemoryEmbeddingModel,
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingModel,
    ),
    agentMemoryEmbeddingBaseUrl: normalizePreferenceText(
      preferences.agentMemoryEmbeddingBaseUrl,
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingBaseUrl,
    ),
    agentMemoryEmbeddingApiKeyReference: normalizePreferenceText(
      preferences.agentMemoryEmbeddingApiKeyReference,
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingApiKeyReference,
    ),
    agentMemoryEmbeddingDimensions: clampRuntimeInteger(
      String(preferences.agentMemoryEmbeddingDimensions),
      32,
      4096,
      DEFAULT_RUNTIME_PREFERENCES.agentMemoryEmbeddingDimensions,
    ),
    taskQueuePolicy: stringChoice(
      preferences.taskQueuePolicy,
      ["queue", "current_only", "interrupt"],
      DEFAULT_RUNTIME_PREFERENCES.taskQueuePolicy,
    ),
    failureRecoveryPolicy: stringChoice(
      preferences.failureRecoveryPolicy,
      ["replan", "stop"],
      DEFAULT_RUNTIME_PREFERENCES.failureRecoveryPolicy,
    ),
    userWaitTimeoutPreset: stringChoice(
      preferences.userWaitTimeoutPreset,
      ["standard", "long", "custom"],
      DEFAULT_RUNTIME_PREFERENCES.userWaitTimeoutPreset,
    ),
    userWaitTimeoutCustomMs: clampRuntimeInteger(
      String(preferences.userWaitTimeoutCustomMs),
      60_000,
      120 * 60_000,
      DEFAULT_RUNTIME_PREFERENCES.userWaitTimeoutCustomMs,
    ),
  };
}

export function composeModeForStartupPreference(
  defaultStartupMode: WorkbenchRuntimePreferences["defaultStartupMode"],
  workspacePath?: string,
): "chat" | "project" {
  if (defaultStartupMode === "project") {
    return "project";
  }
  if (defaultStartupMode === "auto" && workspacePath?.trim()) {
    return "project";
  }
  return "chat";
}

function stringChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function nonEmptyPreference(value: string | undefined, fallback: string): string {
  return normalizePreferenceText(value, fallback);
}

function normalizePreferenceText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed || fallback;
}

function clampRuntimeInteger(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
