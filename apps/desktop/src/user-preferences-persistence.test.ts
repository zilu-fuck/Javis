import { describe, expect, it } from "vitest";
import type { DatabaseValue } from "./desktop-database";
import {
  USER_PREFERENCES_MIGRATIONS,
  USER_PREFERENCES_STORAGE_KEY,
  USER_PREFERENCES_TABLE_SQL,
  createUserPreferencesRepository,
  importUserPreferencesFromLocalStorage,
  loadAllPreferencesFromDatabase,
  loadPreferenceFromDatabase,
  loadUserPreferencesWithStorageFallback,
  saveAllPreferencesToDatabase,
  savePreferenceToDatabase,
} from "./user-preferences-persistence";

describe("user preferences persistence", () => {
  it("exports SQLite-ready schema and migration constants", () => {
    expect(USER_PREFERENCES_TABLE_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS user_preferences",
    );
    expect(USER_PREFERENCES_TABLE_SQL).toContain("key TEXT PRIMARY KEY");
    expect(USER_PREFERENCES_TABLE_SQL).toContain("value TEXT NOT NULL");
    expect(USER_PREFERENCES_TABLE_SQL).toContain("updated_at TEXT NOT NULL");
    expect(USER_PREFERENCES_MIGRATIONS.map((m) => m.id)).toEqual([
      "user-preferences-v1-table",
    ]);
  });

  describe("getAll", () => {
    it("returns all preferences as a flat object", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      await saveAllPreferencesToDatabase(
        database,
        { locale: "zh-CN", sidebarWidth: "220" },
        now,
      );

      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({ locale: "zh-CN", sidebarWidth: "220" });
    });

    it("returns an empty object when the table is empty", async () => {
      const database = createMemoryUserPreferencesDatabase();

      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({});
    });
  });

  describe("get", () => {
    it("returns the value for a specific key", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      await saveAllPreferencesToDatabase(
        database,
        { locale: "en-US", theme: "dark" },
        now,
      );

      const value = await loadPreferenceFromDatabase(database, "locale");

      expect(value).toBe("en-US");
    });

    it("returns null when the key does not exist", async () => {
      const database = createMemoryUserPreferencesDatabase();

      const value = await loadPreferenceFromDatabase(database, "nonexistent");

      expect(value).toBeNull();
    });
  });

  describe("set", () => {
    it("inserts a new key-value pair", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      await savePreferenceToDatabase(database, "locale", "zh-CN", now);

      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({ locale: "zh-CN" });
    });

    it("upserts an existing key", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      await saveAllPreferencesToDatabase(
        database,
        { locale: "en-US" },
        now,
      );
      await savePreferenceToDatabase(database, "locale", "zh-CN", now);

      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({ locale: "zh-CN" });
    });

    it("preserves other keys when setting one", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      await saveAllPreferencesToDatabase(
        database,
        { locale: "en-US", theme: "dark" },
        now,
      );
      await savePreferenceToDatabase(database, "locale", "zh-CN", now);

      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({ locale: "zh-CN", theme: "dark" });
    });
  });

  describe("setAll", () => {
    it("replaces all preferences with the given object", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      await saveAllPreferencesToDatabase(
        database,
        { locale: "en-US", oldKey: "old" },
        now,
      );
      await saveAllPreferencesToDatabase(
        database,
        { locale: "zh-CN", sidebarWidth: "280" },
        now,
      );

      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({ locale: "zh-CN", sidebarWidth: "280" });
      expect(loaded).not.toHaveProperty("oldKey");
    });

    it("clears all rows when given an empty object", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      await saveAllPreferencesToDatabase(
        database,
        { locale: "en-US" },
        now,
      );
      await saveAllPreferencesToDatabase(database, {}, now);

      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({});
    });
  });

  describe("importFromLocalStorage", () => {
    it("imports preferences from localStorage into the database and removes the legacy key", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const storage = createMemoryStorage();
      storage.setItem(
        USER_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ locale: "zh-CN", sidebarWidth: "220" }),
      );

      const now = "2026-05-28T10:00:00.000Z";
      const imported = await importUserPreferencesFromLocalStorage(
        database,
        storage,
        now,
      );

      expect(imported).toEqual({ locale: "zh-CN", sidebarWidth: "220" });
      expect(await loadAllPreferencesFromDatabase(database)).toEqual({
        locale: "zh-CN",
        sidebarWidth: "220",
      });
      expect(storage.getItem(USER_PREFERENCES_STORAGE_KEY)).toBeNull();
    });

    it("removes legacy key even when localStorage has an empty object", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const storage = createMemoryStorage();
      storage.setItem(
        USER_PREFERENCES_STORAGE_KEY,
        JSON.stringify({}),
      );

      const now = "2026-05-28T10:00:00.000Z";
      const imported = await importUserPreferencesFromLocalStorage(
        database,
        storage,
        now,
      );

      expect(imported).toEqual({});
      expect(storage.getItem(USER_PREFERENCES_STORAGE_KEY)).toBeNull();
    });

    it("removes legacy key even when localStorage has malformed JSON", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const storage = createMemoryStorage();
      storage.setItem(
        USER_PREFERENCES_STORAGE_KEY,
        "not valid json{{{",
      );

      const now = "2026-05-28T10:00:00.000Z";
      const imported = await importUserPreferencesFromLocalStorage(
        database,
        storage,
        now,
      );

      expect(imported).toEqual({});
      expect(storage.getItem(USER_PREFERENCES_STORAGE_KEY)).toBeNull();
    });

    it("returns current database preferences when localStorage has no legacy value", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const storage = createMemoryStorage();
      await saveAllPreferencesToDatabase(
        database,
        { locale: "en-US" },
        "2026-05-28T10:00:00.000Z",
      );

      const now = "2026-05-28T11:00:00.000Z";
      const imported = await importUserPreferencesFromLocalStorage(
        database,
        storage,
        now,
      );

      expect(imported).toEqual({ locale: "en-US" });
    });
  });

  describe("loadUserPreferencesWithStorageFallback", () => {
    it("uses repository when available", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const storage = createMemoryStorage();
      await saveAllPreferencesToDatabase(
        database,
        { locale: "zh-CN" },
        "2026-05-28T10:00:00.000Z",
      );
      const repository = createUserPreferencesRepository(database);

      const loaded = await loadUserPreferencesWithStorageFallback(
        repository,
        storage,
      );

      expect(loaded).toEqual({ locale: "zh-CN" });
    });

    it("falls back to localStorage when repository is null", async () => {
      const storage = createMemoryStorage();
      storage.setItem(
        USER_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ locale: "en-US" }),
      );

      const loaded = await loadUserPreferencesWithStorageFallback(null, storage);

      expect(loaded).toEqual({ locale: "en-US" });
    });

    it("falls back to localStorage when repository is undefined", async () => {
      const storage = createMemoryStorage();
      storage.setItem(
        USER_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ locale: "en-US" }),
      );

      const loaded = await loadUserPreferencesWithStorageFallback(
        undefined,
        storage,
      );

      expect(loaded).toEqual({ locale: "en-US" });
    });

    it("falls back to localStorage when repository.getAll throws", async () => {
      const storage = createMemoryStorage();
      storage.setItem(
        USER_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ locale: "en-US" }),
      );
      const failingRepository = {
        async getAll(): Promise<Record<string, string>> {
          throw new Error("database unavailable");
        },
      };

      const loaded = await loadUserPreferencesWithStorageFallback(
        failingRepository,
        storage,
      );

      expect(loaded).toEqual({ locale: "en-US" });
    });
  });

  describe("createUserPreferencesRepository", () => {
    it("getAll returns all preferences from the database", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const repository = createUserPreferencesRepository(database);
      await saveAllPreferencesToDatabase(
        database,
        { locale: "zh-CN", theme: "dark" },
        "2026-05-28T10:00:00.000Z",
      );

      expect(await repository.getAll()).toEqual({
        locale: "zh-CN",
        theme: "dark",
      });
    });

    it("get returns a specific key", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const repository = createUserPreferencesRepository(database);
      await saveAllPreferencesToDatabase(
        database,
        { locale: "zh-CN" },
        "2026-05-28T10:00:00.000Z",
      );

      expect(await repository.get("locale")).toBe("zh-CN");
      expect(await repository.get("missing")).toBeNull();
    });

    it("set upserts a single key while preserving others", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const repository = createUserPreferencesRepository(database);
      await repository.setAll({ locale: "en-US", theme: "dark" });
      await repository.set("locale", "zh-CN");

      const result = await repository.getAll();
      expect(result).toEqual({ locale: "zh-CN", theme: "dark" });
    });

    it("setAll replaces all preferences", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const repository = createUserPreferencesRepository(database);
      await repository.setAll({ locale: "en-US", old: "value" });
      await repository.setAll({ locale: "zh-CN" });

      const result = await repository.getAll();
      expect(result).toEqual({ locale: "zh-CN" });
      expect(result).not.toHaveProperty("old");
    });

    it("importFromLocalStorage delegates to importUserPreferencesFromLocalStorage", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const repository = createUserPreferencesRepository(database);
      const storage = createMemoryStorage();
      storage.setItem(
        USER_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ locale: "zh-CN", sidebarWidth: "220" }),
      );

      const imported = await repository.importFromLocalStorage(storage);

      expect(imported).toEqual({ locale: "zh-CN", sidebarWidth: "220" });
      expect(await repository.getAll()).toEqual({
        locale: "zh-CN",
        sidebarWidth: "220",
      });
      expect(storage.getItem(USER_PREFERENCES_STORAGE_KEY)).toBeNull();
    });
  });

  describe("round-trip", () => {
    it("save then load preserves all preference fields", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const prefs: Record<string, string> = {
        locale: "zh-CN",
        sidebarWidth: "220",
        theme: "dark",
        fontSize: "14",
      };

      await saveAllPreferencesToDatabase(database, prefs, now);
      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual(prefs);
    });

    it("single set then getAll preserves the value", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";

      await savePreferenceToDatabase(database, "locale", "zh-CN", now);
      await savePreferenceToDatabase(database, "theme", "dark", now);
      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual({ locale: "zh-CN", theme: "dark" });
    });

    it("multiple save-load cycles maintain data integrity", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const prefs = { locale: "zh-CN", sidebarWidth: "280" };

      await saveAllPreferencesToDatabase(database, prefs, now);
      const loaded1 = await loadAllPreferencesFromDatabase(database);

      await saveAllPreferencesToDatabase(database, loaded1, now);
      const loaded2 = await loadAllPreferencesFromDatabase(database);

      expect(loaded2).toEqual(loaded1);
      expect(Object.keys(loaded2)).toHaveLength(2);
    });

    it("handles values with special characters", async () => {
      const database = createMemoryUserPreferencesDatabase();
      const now = "2026-05-28T10:00:00.000Z";
      const prefs: Record<string, string> = {
        greeting: "hello \"world\"",
        path: "C:\\Users\\test",
        unicode: "中文测试",
      };

      await saveAllPreferencesToDatabase(database, prefs, now);
      const loaded = await loadAllPreferencesFromDatabase(database);

      expect(loaded).toEqual(prefs);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StoredUserPreferenceRow extends Record<string, unknown> {
  key: string;
  value: string;
  updated_at: string;
}

function createMemoryUserPreferencesDatabase() {
  const rows = new Map<string, StoredUserPreferenceRow>();
  const database = {
    rows,
    async execute(sql: string, values: DatabaseValue[] = []) {
      if (sql.startsWith("DELETE FROM user_preferences")) {
        rows.clear();
        return;
      }
      if (sql.startsWith("INSERT")) {
        const row: StoredUserPreferenceRow = {
          key: String(values[0]),
          value: String(values[1]),
          updated_at: String(values[2]),
        };
        rows.set(row.key, row);
      }
    },
    async select<T extends Record<string, unknown>>(
      sql: string,
      values: DatabaseValue[] = [],
    ): Promise<T[]> {
      const all = [...rows.values()].map((row) => ({ ...row }) as unknown as T);
      const keyMatch = sql.match(/WHERE key = \?/);
      if (keyMatch && values.length > 0) {
        const target = String(values[0]);
        return all.filter((row) => (row as unknown as StoredUserPreferenceRow).key === target);
      }
      return all;
    },
  };
  return database;
}

function createMemoryStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
