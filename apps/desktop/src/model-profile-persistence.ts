import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import {
  createDefaultModelConfiguration,
  type AgentModelOverrides,
  type ModelConfiguration,
  type ModelProfile,
  type ModelSlot,
} from "./model-settings";

// --- Schema ---

export const MODEL_PROFILES_TABLE_NAME = "model_profiles";
export const AGENT_MODEL_OVERRIDES_TABLE_NAME = "agent_model_overrides";

export const MODEL_PROFILES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${MODEL_PROFILES_TABLE_NAME} (
  id TEXT PRIMARY KEY,
  slot TEXT,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_reference TEXT NOT NULL,
  base_url TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
)
`.trim();

export const AGENT_MODEL_OVERRIDES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${AGENT_MODEL_OVERRIDES_TABLE_NAME} (
  agent_kind TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`.trim();

export const MODEL_PROFILES_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    id: "model-profiles-v1-table",
    sql: MODEL_PROFILES_SCHEMA_SQL,
  },
  {
    id: "agent-model-overrides-v1-table",
    sql: AGENT_MODEL_OVERRIDES_SCHEMA_SQL,
  },
];

// --- Repository ---

export interface ModelProfileRepository {
  load(): Promise<ModelConfiguration>;
  save(profiles: ModelProfile[], overrides: AgentModelOverrides): Promise<ModelConfiguration>;
  importFromLegacySettings(
    legacySettings: { provider: string; model: string; apiKeyReference: string; baseUrl: string },
    locale?: string,
  ): Promise<ModelConfiguration>;
}

export function createModelProfileRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): ModelProfileRepository {
  return {
    async load() {
      return loadModelConfiguration(database);
    },

    async save(profiles, overrides) {
      return saveModelConfiguration(database, profiles, overrides);
    },

    async importFromLegacySettings(legacySettings, locale) {
      return importFromLegacyModelSettings(database, legacySettings, locale);
    },
  };
}

// --- Load ---

async function loadModelConfiguration(
  database: Pick<DesktopDatabase, "select">,
): Promise<ModelConfiguration> {
  const profileRows = await database.select<{
    id: string;
    slot: string | null;
    display_name: string;
    provider: string;
    model: string;
    api_key_reference: string;
    base_url: string;
    capabilities: string;
  }>(
    `SELECT id, slot, display_name, provider, model, api_key_reference, base_url, capabilities FROM ${MODEL_PROFILES_TABLE_NAME} ORDER BY slot, id`,
  );

  const overrideRows = await database.select<{ agent_kind: string; profile_id: string }>(
    `SELECT agent_kind, profile_id FROM ${AGENT_MODEL_OVERRIDES_TABLE_NAME}`,
  );

  if (profileRows.length === 0) {
    return createDefaultModelConfiguration();
  }

  const profiles: ModelProfile[] = profileRows.map((row) => ({
    id: row.id,
    slot: parseSlot(row.slot),
    displayName: row.display_name,
    provider: row.provider,
    model: row.model,
    apiKeyReference: row.api_key_reference,
    baseUrl: row.base_url,
    capabilities: parseCapabilities(row.capabilities),
  }));

  const agentOverrides: AgentModelOverrides = {};
  for (const row of overrideRows) {
    agentOverrides[row.agent_kind] = row.profile_id;
  }

  return { profiles, agentOverrides };
}

// --- Save ---

async function saveModelConfiguration(
  database: Pick<DesktopDatabase, "execute">,
  profiles: ModelProfile[],
  overrides: AgentModelOverrides,
): Promise<ModelConfiguration> {
  const now = new Date().toISOString();

  // Upsert profiles
  for (const profile of profiles) {
    await database.execute(
      `INSERT INTO ${MODEL_PROFILES_TABLE_NAME} (id, slot, display_name, provider, model, api_key_reference, base_url, capabilities, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  slot = excluded.slot,
  display_name = excluded.display_name,
  provider = excluded.provider,
  model = excluded.model,
  api_key_reference = excluded.api_key_reference,
  base_url = excluded.base_url,
  capabilities = excluded.capabilities,
  updated_at = excluded.updated_at`,
      [
        profile.id,
        profile.slot,
        profile.displayName,
        profile.provider,
        profile.model,
        profile.apiKeyReference,
        profile.baseUrl,
        JSON.stringify(profile.capabilities),
        now,
      ],
    );
  }

  // Replace overrides
  await database.execute(`DELETE FROM ${AGENT_MODEL_OVERRIDES_TABLE_NAME}`);
  for (const [agentKind, profileId] of Object.entries(overrides)) {
    if (profileId) {
      await database.execute(
        `INSERT INTO ${AGENT_MODEL_OVERRIDES_TABLE_NAME} (agent_kind, profile_id, updated_at) VALUES (?, ?, ?)`,
        [agentKind, profileId, now],
      );
    }
  }

  return { profiles, agentOverrides: overrides };
}

// --- Migration from legacy ---

async function importFromLegacyModelSettings(
  database: Pick<DesktopDatabase, "execute" | "select">,
  legacySettings: { provider: string; model: string; apiKeyReference: string; baseUrl: string },
  locale = "en",
): Promise<ModelConfiguration> {
  // Check if profiles already exist
  const existing = await database.select<{ count: number }>(
    `SELECT COUNT(*) as count FROM ${MODEL_PROFILES_TABLE_NAME}`,
  );
  if (existing[0]?.count > 0) {
    return loadModelConfiguration(database);
  }

  // Migrate legacy settings to primary slot
  const defaultConfig = createDefaultModelConfiguration(locale);
  const primaryProfile: ModelProfile = {
    ...defaultConfig.profiles[0],
    provider: legacySettings.provider || defaultConfig.profiles[0].provider,
    model: legacySettings.model || defaultConfig.profiles[0].model,
    apiKeyReference: legacySettings.apiKeyReference || defaultConfig.profiles[0].apiKeyReference,
    baseUrl: legacySettings.baseUrl || defaultConfig.profiles[0].baseUrl,
  };

  const profiles = [
    primaryProfile,
    ...defaultConfig.profiles.filter((p) => p.id !== "primary"),
  ];

  return saveModelConfiguration(database, profiles, defaultConfig.agentOverrides);
}

// --- Helpers ---

function parseSlot(value: string | null): ModelSlot | null {
  if (value === "primary" || value === "secondary" || value === "multimodal") {
    return value;
  }
  return null;
}

function parseCapabilities(raw: string): ModelProfile["capabilities"] {
  try {
    const parsed = JSON.parse(raw);
    return {
      vision: Boolean(parsed.vision),
      code: Boolean(parsed.code),
      longContext: Boolean(parsed.longContext),
    };
  } catch {
    return { vision: false, code: false, longContext: false };
  }
}
