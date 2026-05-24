import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_SETTINGS,
  MODEL_SETTINGS_STORAGE_KEY,
  loadModelSettings,
  saveModelSettings,
  sanitizeModelSettings,
} from "./model-settings";

describe("model settings persistence", () => {
  it("loads defaults when no model settings are stored", () => {
    expect(loadModelSettings(createMemoryStorage())).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it("trims model settings without persisting API keys", () => {
    const storage = createMemoryStorage();

    const saved = saveModelSettings(storage, {
      provider: " openai ",
      model: " openai/gpt-5.1-codex ",
      apiKey: " sk-local ",
      baseUrl: " https://api.example.test/v1 ",
    });

    expect(saved).toEqual({
      provider: "openai",
      model: "openai/gpt-5.1-codex",
      apiKey: "sk-local",
      baseUrl: "https://api.example.test/v1",
    });
    expect(loadModelSettings(storage)).toEqual({
      ...saved,
      apiKey: "",
    });
    expect(storage.getItem(MODEL_SETTINGS_STORAGE_KEY)).not.toContain("apiKey");
    expect(storage.getItem(MODEL_SETTINGS_STORAGE_KEY)).not.toContain("sk-local");
  });

  it("drops API keys from legacy stored settings", () => {
    const storage = createMemoryStorage();
    storage.setItem(MODEL_SETTINGS_STORAGE_KEY, JSON.stringify({
      provider: "deepseek",
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-legacy",
      baseUrl: "https://api.deepseek.com",
    }));

    expect(loadModelSettings(storage)).toEqual({
      provider: "deepseek",
      model: "deepseek/deepseek-v4-flash",
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
    });
    expect(storage.getItem(MODEL_SETTINGS_STORAGE_KEY)).not.toContain("apiKey");
    expect(storage.getItem(MODEL_SETTINGS_STORAGE_KEY)).not.toContain("sk-legacy");
  });

  it("rejects malformed stored settings", () => {
    const storage = createMemoryStorage();
    storage.setItem(MODEL_SETTINGS_STORAGE_KEY, "{bad-json");

    expect(loadModelSettings(storage)).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it("sanitizes partial settings envelopes", () => {
    expect(
      sanitizeModelSettings({
        provider: "",
        model: " anthropic/claude-sonnet-4-5 ",
        apiKey: 42,
        baseUrl: null,
      }),
    ).toEqual({
      provider: "openai",
      model: "anthropic/claude-sonnet-4-5",
      apiKey: "",
      baseUrl: "",
    });
  });
});

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
