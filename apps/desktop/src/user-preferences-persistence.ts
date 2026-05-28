import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const PREF_KEYS = {
  LOCALE: "locale",
  SIDEBAR_WIDTH: "sidebar_width",
  ACTIVE_VIEW: "active_view",
  IS_ACTIVITY_OPEN: "is_activity_open",
  IS_INSPECTOR_OPEN: "is_inspector_open",
} as const;

export const USER_PREFERENCES_STORAGE_KEY = "javis.userPreferences.v1";

export const USER_PREFERENCES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`.trim();

export const USER_PREFERENCES_TABLE_MIGRATION: DesktopDatabaseMigration = {
  id: "user-preferences-v1-table",
  sql: USER_PREFERENCES_TABLE_SQL,
};

export const USER_PREFERENCES_MIGRATIONS: DesktopDatabaseMigration[] = [
  USER_PREFERENCES_TABLE_MIGRATION,
];

type UserPreferencesMigrationStorage = Pick<Storage, "getItem" | "removeItem">;

export interface UserPreferencesRepository {
  getAll(): Promise<Record<string, string>>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setAll(prefs: Record<string, string>): Promise<void>;
  importFromLocalStorage(storage: UserPreferencesMigrationStorage): Promise<Record<string, string>>;
}

export function createUserPreferencesRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): UserPreferencesRepository {
  return {
    async getAll() {
      return loadAllPreferencesFromDatabase(database);
    },

    async get(key) {
      return loadPreferenceFromDatabase(database, key);
    },

    async set(key, value) {
      return savePreferenceToDatabase(database, key, value);
    },

    async setAll(prefs) {
      return saveAllPreferencesToDatabase(database, prefs);
    },

    async importFromLocalStorage(storage) {
      return importUserPreferencesFromLocalStorage(database, storage);
    },
  };
}

export async function loadAllPreferencesFromDatabase(
  database: Pick<DesktopDatabase, "select">,
): Promise<Record<string, string>> {
  const rows = await database.select<UserPreferenceRow>(
    `SELECT key, value, updated_at FROM user_preferences ORDER BY key ASC`,
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export async function loadPreferenceFromDatabase(
  database: Pick<DesktopDatabase, "select">,
  key: string,
): Promise<string | null> {
  const rows = await database.select<UserPreferenceRow>(
    `SELECT value FROM user_preferences WHERE key = ?`,
    [key],
  );
  return rows.length > 0 ? rows[0].value : null;
}

export async function savePreferenceToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  key: string,
  value: string,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  await database.execute(
    `INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, value, updatedAt],
  );
}

export async function saveAllPreferencesToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  prefs: Record<string, string>,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  await database.execute(`DELETE FROM user_preferences`);
  for (const [key, value] of Object.entries(prefs)) {
    await database.execute(
      `INSERT INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)`,
      [key, value, updatedAt],
    );
  }
}

export async function importUserPreferencesFromLocalStorage(
  database: Pick<DesktopDatabase, "execute" | "select">,
  storage: UserPreferencesMigrationStorage,
  updatedAt = new Date().toISOString(),
): Promise<Record<string, string>> {
  const legacyValue = storage.getItem(USER_PREFERENCES_STORAGE_KEY);

  if (legacyValue !== null) {
    const parsed = parseLegacyPreferences(legacyValue);
    if (Object.keys(parsed).length > 0) {
      await saveAllPreferencesToDatabase(database, parsed, updatedAt);
      removeLegacyStorage(storage);
      return parsed;
    }
    removeLegacyStorage(storage);
  }

  return loadAllPreferencesFromDatabase(database);
}

export async function loadUserPreferencesWithStorageFallback(
  repository: Pick<UserPreferencesRepository, "getAll"> | null | undefined,
  storage: Pick<Storage, "getItem">,
): Promise<Record<string, string>> {
  if (!repository) {
    return loadPreferencesFromStorage(storage);
  }
  try {
    return await repository.getAll();
  } catch {
    return loadPreferencesFromStorage(storage);
  }
}

type UserPreferenceRow = Record<string, unknown> & {
  key: string;
  value: string;
  updated_at: string;
};

function parseLegacyPreferences(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        result[key] = String(value);
      }
      return result;
    }
  } catch {
    // Malformed JSON — treat as empty.
  }
  return {};
}

function loadPreferencesFromStorage(
  storage: Pick<Storage, "getItem">,
): Record<string, string> {
  const raw = storage.getItem(USER_PREFERENCES_STORAGE_KEY);
  if (raw === null) {
    return {};
  }
  return parseLegacyPreferences(raw);
}

function removeLegacyStorage(storage: UserPreferencesMigrationStorage): void {
  try {
    storage.removeItem(USER_PREFERENCES_STORAGE_KEY);
  } catch {
    // Legacy cleanup should not block startup.
  }
}
