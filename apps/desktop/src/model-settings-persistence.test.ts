import { describe, expect, it } from "vitest";
import type { DatabaseValue } from "./desktop-database";
import {
  MODEL_SETTINGS_DEFAULT_ID,
  createModelSettingsRepository,
  loadModelSettingsFromDatabase,
  saveModelSettingsToDatabase,
} from "./model-settings-persistence";
import type { ModelSettings } from "./model-settings";

describe("model settings persistence", () => {
  it("loads saved database settings when no legacy localStorage value exists", async () => {
    const database = createMemoryModelSettingsDatabase();
    const repository = createModelSettingsRepository(database);
    const saved: ModelSettings = {
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "",
      apiKeyReference: "model.deepseek",
      baseUrl: "https://api.deepseek.com",
    };

    await saveModelSettingsToDatabase(database, saved, "2026-06-14T00:00:00.000Z");
    const imported = await repository.importFromLocalStorage(createStorage(null));

    expect(imported).toEqual(saved);
    expect(await loadModelSettingsFromDatabase(database)).toEqual(saved);
  });

  it("imports legacy localStorage settings when present", async () => {
    const database = createMemoryModelSettingsDatabase();
    const repository = createModelSettingsRepository(database);
    const legacy: ModelSettings = {
      provider: "openai",
      model: "gpt-4.1",
      apiKey: "",
      apiKeyReference: "model.openai",
      baseUrl: "https://api.openai.com/v1",
    };

    const imported = await repository.importFromLocalStorage(createStorage(JSON.stringify(legacy)));

    expect(imported).toEqual(legacy);
    expect(await loadModelSettingsFromDatabase(database)).toEqual(legacy);
  });
});

function createStorage(rawValue: string | null): Pick<Storage, "getItem" | "setItem"> {
  let value = rawValue;
  return {
    getItem() {
      return value;
    },
    setItem(_key, nextValue) {
      value = nextValue;
    },
  };
}

function createMemoryModelSettingsDatabase() {
  let row:
    | {
        id: string;
        provider: string;
        model: string;
        api_key_reference: string;
        base_url: string;
        updated_at: string;
      }
    | undefined;

  return {
    async execute(sql: string, values: DatabaseValue[] = []) {
      if (!sql.includes("INSERT INTO model_settings")) {
        return;
      }
      row = {
        id: String(values[0] ?? MODEL_SETTINGS_DEFAULT_ID),
        provider: String(values[1] ?? ""),
        model: String(values[2] ?? ""),
        api_key_reference: String(values[3] ?? ""),
        base_url: String(values[4] ?? ""),
        updated_at: String(values[5] ?? ""),
      };
    },
    async select<T extends Record<string, unknown>>(): Promise<T[]> {
      return row ? [row as unknown as T] : [];
    },
  };
}
