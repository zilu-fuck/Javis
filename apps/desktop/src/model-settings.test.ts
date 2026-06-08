import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_SETTINGS,
  MODEL_SETTINGS_STORAGE_KEY,
  loadModelSettings,
  normalizeModelConfigurationConnections,
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
      apiKeyReference: " default ",
      baseUrl: " https://api.example.test/v1 ",
    });

    expect(saved).toEqual({
      provider: "openai",
      model: "openai/gpt-5.1-codex",
      apiKey: "sk-local",
      apiKeyReference: "default",
      baseUrl: "https://api.example.test/v1",
    });
    expect(loadModelSettings(storage)).toEqual({
      ...saved,
      apiKey: "",
    });
    const persisted = storage.getItem(MODEL_SETTINGS_STORAGE_KEY) ?? "";
    expect(JSON.parse(persisted)).not.toHaveProperty("apiKey");
    expect(persisted).not.toContain("sk-local");
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
      apiKeyReference: "default",
      baseUrl: "https://api.deepseek.com",
    });
    const persisted = storage.getItem(MODEL_SETTINGS_STORAGE_KEY) ?? "";
    expect(JSON.parse(persisted)).not.toHaveProperty("apiKey");
    expect(persisted).not.toContain("sk-legacy");
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
        apiKeyReference: "",
        baseUrl: null,
      }),
    ).toEqual({
      provider: "openai",
      model: "anthropic/claude-sonnet-4-5",
      apiKey: "",
      apiKeyReference: "default",
      baseUrl: "",
    });
  });
});

describe("model profile connection normalization", () => {
  const providers = [
    { id: "openai", defaultBaseUrl: "https://api.openai.com/v1" },
    { id: "zhipu", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    { id: "dashscope", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  ];

  it("repairs a GLM slot that kept an OpenAI URL and default key reference", () => {
    const normalized = normalizeModelConfigurationConnections({
      profiles: [{
        id: "primary",
        slot: "primary",
        displayName: "Primary",
        provider: "zhipu",
        model: "glm-4-plus",
        apiKeyReference: "default",
        baseUrl: "https://api.openai.com/v1",
        capabilities: { vision: true, code: true, longContext: true },
      }],
      agentOverrides: {},
    }, providers);

    expect(normalized.profiles[0]).toMatchObject({
      provider: "zhipu",
      apiKeyReference: "model.zhipu",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    });
  });

  it("aligns Qwen/DashScope slots to the provider model connection", () => {
    const normalized = normalizeModelConfigurationConnections({
      profiles: [
        {
          id: "dashscope-qwen-max",
          slot: null,
          displayName: "qwen-max",
          provider: "dashscope",
          model: "qwen-max",
          apiKeyReference: "model.dashscope",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          capabilities: { vision: true, code: true, longContext: true },
        },
        {
          id: "primary",
          slot: "primary",
          displayName: "Primary",
          provider: "dashscope",
          model: "qwen-max",
          apiKeyReference: "default",
          baseUrl: "https://api.openai.com/v1",
          capabilities: { vision: true, code: true, longContext: true },
        },
      ],
      agentOverrides: {},
    }, providers);

    expect(normalized.profiles.find((profile) => profile.slot === "primary")).toMatchObject({
      provider: "dashscope",
      apiKeyReference: "model.dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
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
