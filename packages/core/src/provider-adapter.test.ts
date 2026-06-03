import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "./adapters/openai-adapter";
import { OpenAICompatibleAdapter } from "./adapters/openai-compatible-adapter";
import { DeepSeekAdapter } from "./adapters/deepseek-adapter";
import { AnthropicAdapter } from "./adapters/anthropic-adapter";
import { getAdapter, listAdapters, registerAdapter } from "./adapters/adapter-registry";
import type { AdapterCompletionInput } from "./provider-adapter";

const baseInput: AdapterCompletionInput = {
  prompt: "Hello",
  model: "gpt-4",
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1/",
  apiKeyReference: "key-ref",
};

describe("OpenAIAdapter", () => {
  it("builds openai-compatible request payload", () => {
    const adapter = new OpenAIAdapter();
    const payload = adapter.buildCompletionRequest(baseInput);

    expect(payload.protocol).toBe("openai-compatible");
    expect(payload.providerId).toBe("openai");
    expect(payload.baseUrl).toBe("https://api.openai.com/v1");
    expect(payload.model).toBe("gpt-4");
    expect(payload.prompt).toBe("Hello");
  });

  it("strips trailing slashes from baseUrl", () => {
    const adapter = new OpenAIAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      baseUrl: "https://api.openai.com/v1///",
    });
    expect(payload.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("passes through optional fields", () => {
    const adapter = new OpenAIAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      maxTokens: 1024,
      temperature: 0.7,
      stopSequences: ["STOP"],
      locale: "zh-CN",
    });
    expect(payload.maxTokens).toBe(1024);
    expect(payload.temperature).toBe(0.7);
    expect(payload.stopSequences).toEqual(["STOP"]);
    expect(payload.locale).toBe("zh-CN");
  });

  it("normalizes response as-is", () => {
    const adapter = new OpenAIAdapter();
    const response = { text: "hi", model: "gpt-4", provider: "openai" };
    expect(adapter.normalizeCompletionResponse(response)).toEqual(response);
  });
});

describe("OpenAICompatibleAdapter", () => {
  it("uses provider-specific default baseUrl when empty", () => {
    const adapter = new OpenAICompatibleAdapter("openrouter", "https://openrouter.ai/api/v1");
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "openrouter",
      baseUrl: "",
      model: "anthropic/claude-sonnet-4.5",
    });

    expect(payload.protocol).toBe("openai-compatible");
    expect(payload.providerId).toBe("openrouter");
    expect(payload.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(payload.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("uses provided baseUrl over provider default", () => {
    const adapter = new OpenAICompatibleAdapter("dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1");
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "dashscope",
      baseUrl: "https://example.test/v1///",
    });

    expect(payload.baseUrl).toBe("https://example.test/v1");
  });
});

describe("DeepSeekAdapter", () => {
  it("uses default baseUrl when empty", () => {
    const adapter = new DeepSeekAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "deepseek",
      baseUrl: "",
    });
    expect(payload.baseUrl).toBe("https://api.deepseek.com");
    expect(payload.protocol).toBe("openai-compatible");
    expect(payload.providerId).toBe("deepseek");
  });

  it("uses provided baseUrl when non-empty", () => {
    const adapter = new DeepSeekAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "deepseek",
      baseUrl: "https://custom.deepseek.com/v1",
    });
    expect(payload.baseUrl).toBe("https://custom.deepseek.com/v1");
  });

  it("reports no vision capability", () => {
    const adapter = new DeepSeekAdapter();
    expect(adapter.capabilities.vision).toBe(false);
  });

  it("reports code capability", () => {
    const adapter = new DeepSeekAdapter();
    expect(adapter.capabilities.code).toBe(true);
  });

  it("reports longContext capability", () => {
    const adapter = new DeepSeekAdapter();
    expect(adapter.capabilities.longContext).toBe(true);
  });

  it("passes model name through unchanged for deepseek-chat", () => {
    const adapter = new DeepSeekAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "deepseek",
      model: "deepseek-chat",
    });
    expect(payload.model).toBe("deepseek-chat");
  });

  it("passes model name through unchanged for deepseek-coder", () => {
    const adapter = new DeepSeekAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "deepseek",
      model: "deepseek-coder",
    });
    expect(payload.model).toBe("deepseek-coder");
  });
});

describe("AnthropicAdapter", () => {
  it("builds anthropic protocol request", () => {
    const adapter = new AnthropicAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
    expect(payload.protocol).toBe("anthropic");
    expect(payload.providerId).toBe("anthropic");
    expect(payload.baseUrl).toBe("https://api.anthropic.com/v1");
  });

  it("appends /v1 when missing", () => {
    const adapter = new AnthropicAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
    expect(payload.baseUrl).toBe("https://api.anthropic.com/v1");
  });

  it("does not double /v1", () => {
    const adapter = new AnthropicAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(payload.baseUrl).toBe("https://api.anthropic.com/v1");
  });

  it("normalizes DeepSeek root to Anthropic-compatible endpoint", () => {
    const adapter = new AnthropicAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
    });
    expect(payload.baseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("does not append /v1 to DeepSeek Anthropic-compatible endpoint", () => {
    const adapter = new AnthropicAdapter();
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic/",
    });
    expect(payload.baseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("reports vision capability", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.capabilities.vision).toBe(true);
  });
});

describe("adapter registry", () => {
  it("returns OpenAIAdapter for 'openai'", () => {
    const adapter = getAdapter("openai");
    expect(adapter).toBeInstanceOf(OpenAIAdapter);
  });

  it("returns DeepSeekAdapter for 'deepseek'", () => {
    const adapter = getAdapter("deepseek");
    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
  });

  it("returns AnthropicAdapter for 'deepseek-anthropic'", () => {
    const adapter = getAdapter("deepseek-anthropic");
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
    expect(adapter.protocol).toBe("anthropic");
  });

  it("returns AnthropicAdapter for 'anthropic'", () => {
    const adapter = getAdapter("anthropic");
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
  });

  it("returns generic OpenAI-compatible adapters for built-in compatible providers", () => {
    const dashscope = getAdapter("dashscope");
    expect(dashscope).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(dashscope.protocol).toBe("openai-compatible");

    const payload = dashscope.buildCompletionRequest({
      ...baseInput,
      providerId: "dashscope",
      baseUrl: "",
      model: "qwen-plus",
    });
    expect(payload.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("returns OpenAI-compatible Gemini adapter using the OpenAI bridge endpoint", () => {
    const adapter = getAdapter("gemini");
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);
    const payload = adapter.buildCompletionRequest({
      ...baseInput,
      providerId: "gemini",
      baseUrl: "",
      model: "gemini-2.5-pro",
    });
    expect(payload.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });

  it("falls back to OpenAIAdapter for unknown provider", () => {
    const adapter = getAdapter("some-custom-provider");
    expect(adapter).toBeInstanceOf(OpenAIAdapter);
  });

  it("is case-insensitive", () => {
    expect(getAdapter("DeepSeek")).toBeInstanceOf(DeepSeekAdapter);
    expect(getAdapter("ANTHROPIC")).toBeInstanceOf(AnthropicAdapter);
  });

  it("lists all registered adapters", () => {
    const all = listAdapters();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const ids = all.map((a) => a.adapterId);
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("deepseek-anthropic");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("dashscope");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("ollama");
  });

  it("supports custom adapter registration", () => {
    const custom: import("./provider-adapter").ProviderAdapter = {
      adapterId: "custom-test",
      protocol: "openai-compatible",
      capabilities: { vision: false, code: false, longContext: false },
      buildCompletionRequest: (input) => ({
        ...input,
        protocol: "openai-compatible",
      }),
      normalizeCompletionResponse: (r) => r,
    };
    registerAdapter(custom);
    expect(getAdapter("custom-test")).toBe(custom);
  });
});
