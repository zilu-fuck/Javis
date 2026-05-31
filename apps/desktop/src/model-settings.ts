export const MODEL_SETTINGS_STORAGE_KEY = "javis.modelSettings.v1";

type ModelSettingsStorage = Pick<Storage, "getItem" | "setItem">;

// --- Multi-model configuration types ---

/** The three built-in model slots. */
export type ModelSlot = "primary" | "secondary" | "multimodal";

/** A named model configuration persisted in model_profiles table. */
export interface ModelProfile {
  id: string;
  slot: ModelSlot | null;
  displayName: string;
  provider: string;
  model: string;
  apiKeyReference: string;
  baseUrl: string;
  capabilities: {
    vision: boolean;
    code: boolean;
    longContext: boolean;
  };
}

/** Per-agent override: maps agentKind → profile id. */
export type AgentModelOverrides = Partial<Record<string, string>>;

/** Full model configuration loaded from SQLite. */
export interface ModelConfiguration {
  profiles: ModelProfile[];
  agentOverrides: AgentModelOverrides;
}

// --- Legacy single-model settings (kept for migration) ---

export interface ModelSettings {
  provider: string;
  model: string;
  apiKey: string;
  apiKeyReference: string;
  baseUrl: string;
}

type PersistedModelSettings = Omit<ModelSettings, "apiKey">;

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  provider: "openai",
  model: "",
  apiKey: "",
  apiKeyReference: "default",
  baseUrl: "",
};

export function localeDefaultModelSettings(locale = "en"): ModelSettings {
  if (locale.toLowerCase().startsWith("zh")) {
    return {
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "",
      apiKeyReference: "default",
      baseUrl: "https://api.deepseek.com",
    };
  }
  return DEFAULT_MODEL_SETTINGS;
}

// --- Default ModelConfiguration ---

function defaultCapabilities(): ModelProfile["capabilities"] {
  return { vision: false, code: false, longContext: false };
}

function defaultProfileForSlot(slot: ModelSlot, locale = "en"): ModelProfile {
  const isZh = locale.toLowerCase().startsWith("zh");
  switch (slot) {
    case "primary":
      return {
        id: "primary",
        slot: "primary",
        displayName: isZh ? "主力模型" : "Primary",
        provider: isZh ? "deepseek" : "openai",
        model: isZh ? "deepseek-chat" : "",
        apiKeyReference: "model.primary",
        baseUrl: isZh ? "https://api.deepseek.com" : "",
        capabilities: { vision: false, code: true, longContext: false },
      };
    case "secondary":
      return {
        id: "secondary",
        slot: "secondary",
        displayName: isZh ? "轻量模型" : "Secondary",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKeyReference: "model.secondary",
        baseUrl: "",
        capabilities: defaultCapabilities(),
      };
    case "multimodal":
      return {
        id: "multimodal",
        slot: "multimodal",
        displayName: isZh ? "视觉模型" : "Multimodal",
        provider: "openai",
        model: "gpt-4o",
        apiKeyReference: "model.multimodal",
        baseUrl: "",
        capabilities: { vision: true, code: false, longContext: false },
      };
  }
}

/** Default agent → slot mapping. Agents not listed default to "primary". */
export const DEFAULT_AGENT_SLOT: Record<string, ModelSlot> = {
  commander: "primary",
  code: "primary",
  "chinese-reviewer": "primary",
  verifier: "secondary",
  scheduler: "secondary",
  research: "secondary",
  file: "secondary",
  shell: "secondary",
  workspace: "secondary",
  browser: "multimodal",
  vision: "multimodal",
  computer: "multimodal",
};

export function createDefaultModelConfiguration(locale = "en"): ModelConfiguration {
  return {
    profiles: [
      defaultProfileForSlot("primary", locale),
      defaultProfileForSlot("secondary", locale),
      defaultProfileForSlot("multimodal", locale),
    ],
    agentOverrides: {},
  };
}

export function loadModelSettings(storage: ModelSettingsStorage): ModelSettings {
  const rawValue = storage.getItem(MODEL_SETTINGS_STORAGE_KEY);
  if (!rawValue) {
    return DEFAULT_MODEL_SETTINGS;
  }

  try {
    const sanitized = clearModelSettingsSecret(sanitizeModelSettings(JSON.parse(rawValue)));
    storage.setItem(MODEL_SETTINGS_STORAGE_KEY, JSON.stringify(toPersistedModelSettings(sanitized)));
    return sanitized;
  } catch {
    return DEFAULT_MODEL_SETTINGS;
  }
}

export function saveModelSettings(
  storage: ModelSettingsStorage,
  settings: ModelSettings,
): ModelSettings {
  const sanitized = sanitizeModelSettings(settings);
  storage.setItem(MODEL_SETTINGS_STORAGE_KEY, JSON.stringify(toPersistedModelSettings(sanitized)));
  return sanitized;
}

export function sanitizeModelSettings(value: unknown): ModelSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_MODEL_SETTINGS;
  }

  const candidate = value as Partial<Record<keyof ModelSettings, unknown>>;
  return {
    provider: sanitizeText(candidate.provider) || DEFAULT_MODEL_SETTINGS.provider,
    model: sanitizeText(candidate.model),
    apiKey: sanitizeText(candidate.apiKey),
    apiKeyReference: sanitizeModelApiKeyReference(candidate.apiKeyReference),
    baseUrl: sanitizeText(candidate.baseUrl),
  };
}

function clearModelSettingsSecret(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    apiKey: "",
  };
}

function toPersistedModelSettings(settings: ModelSettings): PersistedModelSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    apiKeyReference: settings.apiKeyReference,
    baseUrl: settings.baseUrl,
  };
}

function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeModelApiKeyReference(value: unknown): string {
  const reference = sanitizeText(value);
  return reference || DEFAULT_MODEL_SETTINGS.apiKeyReference;
}
