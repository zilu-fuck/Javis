import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import {
  DEFAULT_MODEL_SETTINGS,
  MODEL_SETTINGS_STORAGE_KEY,
  loadModelSettings,
  sanitizeModelSettings,
  type ModelSettings,
} from "./model-settings";

type ModelSettingsStorage = Pick<Storage, "getItem" | "setItem">;

export const MODEL_SETTINGS_TABLE_NAME = "model_settings";
export const MODEL_SETTINGS_DEFAULT_ID = "default";

export const MODEL_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_settings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_reference TEXT NOT NULL,
  base_url TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`.trim();

export const MODEL_SETTINGS_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    id: "model-settings-v1-table",
    sql: MODEL_SETTINGS_SCHEMA_SQL,
  },
];

export interface ModelSettingsRepository {
  load(): Promise<ModelSettings>;
  save(settings: ModelSettings): Promise<ModelSettings>;
  importFromLocalStorage(storage: ModelSettingsStorage): Promise<ModelSettings>;
}

export function createModelSettingsRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): ModelSettingsRepository {
  return {
    async load() {
      return loadModelSettingsFromDatabase(database);
    },

    async save(settings) {
      return saveModelSettingsToDatabase(database, settings);
    },

    async importFromLocalStorage(storage) {
      if (storage.getItem(MODEL_SETTINGS_STORAGE_KEY) === null) {
        return loadModelSettingsFromDatabase(database);
      }
      const imported = loadModelSettings(storage);
      await saveModelSettingsToDatabase(database, imported);
      return imported;
    },
  };
}

export async function loadModelSettingsFromDatabase(
  database: Pick<DesktopDatabase, "select">,
): Promise<ModelSettings> {
  const rows = await database.select<{
    provider: string;
    model: string;
    api_key_reference: string;
    base_url: string;
  }>(
    `SELECT provider, model, api_key_reference, base_url FROM ${MODEL_SETTINGS_TABLE_NAME} WHERE id = ? LIMIT 1`,
    [MODEL_SETTINGS_DEFAULT_ID],
  );
  const row = rows[0];
  if (!row) {
    return DEFAULT_MODEL_SETTINGS;
  }
  return sanitizeModelSettings({
    provider: row.provider,
    model: row.model,
    apiKey: "",
    apiKeyReference: row.api_key_reference,
    baseUrl: row.base_url,
  });
}

export async function saveModelSettingsToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  settings: ModelSettings,
  updatedAt = new Date().toISOString(),
): Promise<ModelSettings> {
  const sanitized = sanitizeModelSettings(settings);
  // apiKey is never persisted to database — stored in OS credential store
  await database.execute(
    `INSERT INTO ${MODEL_SETTINGS_TABLE_NAME} (id, provider, model, api_key_reference, base_url, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  provider = excluded.provider,
  model = excluded.model,
  api_key_reference = excluded.api_key_reference,
  base_url = excluded.base_url,
  updated_at = excluded.updated_at`,
    modelSettingsBindValues(sanitized, updatedAt),
  );
  return sanitized;
}

export async function loadModelSettingsWithStorageFallback(
  repository: Pick<ModelSettingsRepository, "load"> | null | undefined,
  storage: ModelSettingsStorage,
): Promise<ModelSettings> {
  if (!repository) {
    return loadModelSettings(storage);
  }
  try {
    return await repository.load();
  } catch {
    return loadModelSettings(storage);
  }
}

function modelSettingsBindValues(
  settings: ModelSettings,
  updatedAt: string,
): DatabaseValue[] {
  return [
    MODEL_SETTINGS_DEFAULT_ID,
    settings.provider,
    settings.model,
    settings.apiKeyReference,
    settings.baseUrl,
    updatedAt,
  ];
}
