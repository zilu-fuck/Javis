export const MODEL_SETTINGS_STORAGE_KEY = "javis.modelSettings.v1";

type ModelSettingsStorage = Pick<Storage, "getItem" | "setItem">;

export interface ModelSettings {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

type PersistedModelSettings = Omit<ModelSettings, "apiKey">;

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  provider: "openai",
  model: "",
  apiKey: "",
  baseUrl: "",
};

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
    baseUrl: settings.baseUrl,
  };
}

function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
