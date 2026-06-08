import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSettings } from "./ModelSettings";
import { defaultWorkbenchLocale, zhCNWorkbenchLocale } from "../locale";

const labels = zhCNWorkbenchLocale.labels;

describe("ModelSettings", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders settings trigger button", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    expect(html).toContain("javis-settings-trigger");
    expect(html).toContain(">设置<");
  });

  it("renders the settings trigger as a button", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    expect(html).toContain('<button class="javis-settings-trigger"');
    expect(html).toContain(">设置</span></button>");
  });

  it("renders with model configuration prop", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        modelConfiguration={{
          profiles: [
            {
              id: "openai-gpt-4-1",
              slot: null,
              displayName: "gpt-4.1",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.openai-gpt-4-1",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.primary",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
          ],
          agentOverrides: {},
        }}
      />,
    );

    expect(html).toContain("javis-settings-trigger");
    expect(html).toContain("设置");
  });

  it("wraps content in javis-settings div", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    expect(html).toContain('<div class="javis-settings">');
    expect(html).toContain('<button class="javis-settings-trigger"');
  });

  it("shows provider console and default model slots without saved configuration", () => {
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));

    expect(document.body.querySelector(".javis-ai-provider-console")).not.toBeNull();
    expect(document.body.querySelector(".javis-ai-model-grid")).not.toBeNull();
    expect(document.body.querySelectorAll(".javis-ai-model-card")).toHaveLength(3);
  });

  it("renders assignable agent labels from the translated agent catalog", () => {
    const { container, getByText, queryByText } = render(
      <ModelSettings
        agentCatalog={[
          { kind: "custom-agent", displayName: "Custom Agent" },
          { kind: "chinese-reviewer", displayName: "Chinese Reviewer" },
        ]}
        labels={defaultWorkbenchLocale.labels}
        locale={{
          ...defaultWorkbenchLocale,
          phrases: {
            ...defaultWorkbenchLocale.phrases,
            "Custom Agent": "Translated Agent",
          },
        }}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(defaultWorkbenchLocale.labels.aiModeSettings));

    expect(getByText("Translated Agent")).toBeTruthy();
    expect(queryByText("custom-agent")).toBeNull();
    expect(queryByText("Chinese Reviewer")).toBeNull();
  });

  it("shows OpenAI-compatible providers from the built-in catalog", () => {
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));

    expect(getByText("OpenRouter")).toBeTruthy();
    expect(getByText("阿里云百炼 (DashScope)")).toBeTruthy();
    expect(getByText("Ollama (本地)")).toBeTruthy();
    expect(getByText("Google Gemini")).toBeTruthy();
  });

  it("renders profile memory controls in privacy settings", () => {
    const onRebuildUserProfileMemory = vi.fn();
    const onClearUserProfileMemory = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        userProfileMemorySummary={{
          factCount: 3,
          topTags: ["memory", "ui"],
          updatedAt: "2026-06-05T10:00:00.000Z",
          facts: [{
            id: "history:memory",
            text: "UserProfileMemory preference",
            tags: ["memory"],
            source: "history",
            confidence: 0.82,
            hitCount: 2,
            evidence: [{
              title: "Profile task",
              snippet: "The user asked to refine profile memory.",
            }],
          }],
        }}
        onRebuildUserProfileMemory={onRebuildUserProfileMemory}
        onClearUserProfileMemory={onClearUserProfileMemory}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.privacySecuritySettings));

    expect(getByText("侧写记忆")).toBeTruthy();
    expect(getByText("memory / ui")).toBeTruthy();
    expect(getByText("UserProfileMemory preference")).toBeTruthy();
    expect(getByText("Profile task")).toBeTruthy();
    fireEvent.click(getByText("重新提炼"));
    fireEvent.click(getByText("清空侧写"));

    expect(onRebuildUserProfileMemory).toHaveBeenCalledOnce();
    expect(onClearUserProfileMemory).toHaveBeenCalledOnce();
  });

  it("runs the API connection test from the AI settings page", async () => {
    const onTestModelConnection = vi.fn().mockResolvedValue("API 连通正常");
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        onTestModelConnection={onTestModelConnection}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(document.body.querySelector(".javis-ai-test-button")!);

    await waitFor(() => expect(onTestModelConnection).toHaveBeenCalledOnce());
    expect(document.body.querySelector(".javis-ai-test-status")?.textContent).toContain("API 连通正常");
  });

  it("tests provider connections with the configured profile key reference", async () => {
    const onTestModelConnection = vi.fn().mockResolvedValue("API 连通正常");
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "deepseek", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        modelConfiguration={{
          profiles: [
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "deepseek",
              model: "deepseek-chat",
              apiKeyReference: "model.primary",
              baseUrl: "https://api.deepseek.com",
              apiKey: "",
              hasStoredApiKey: true,
              capabilities: { vision: false, code: true, longContext: false },
            },
          ],
          agentOverrides: {},
        }}
        onTestModelConnection={onTestModelConnection}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(document.body.querySelector(".javis-ai-test-button")!);

    await waitFor(() => expect(onTestModelConnection).toHaveBeenCalledOnce());
    expect(onTestModelConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "model.primary",
        baseUrl: "https://api.deepseek.com",
      }),
    );
  });

  it("assigns configured provider models to model slots with dropdowns", () => {
    const onModelConfigurationChange = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "https://api.openai.com/v1" }}
        onModelConfigurationChange={onModelConfigurationChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    const modelSlotTriggers = document.body.querySelectorAll(".javis-ai-model-select-trigger");
    fireEvent.click(modelSlotTriggers[0]); // primary is first slot
    fireEvent.click(document.body.querySelectorAll(".javis-ai-model-select-menu button")[1]);
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    expect(onModelConfigurationChange).toHaveBeenCalledOnce();
    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles.find((profile: { slot: string }) => profile.slot === "primary")).toMatchObject({
      provider: "openai",
      model: "gpt-4.1",
      apiKeyReference: "default",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("clears a model slot when the dropdown is set to unassigned", () => {
    const onModelConfigurationChange = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        modelConfiguration={{
          profiles: [
            {
              id: "openai-gpt-4-1",
              slot: null,
              displayName: "gpt-4.1",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.openai-gpt-4-1",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.primary",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
          ],
          agentOverrides: {},
        }}
        onModelConfigurationChange={onModelConfigurationChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    const modelSlotTriggers = document.body.querySelectorAll(".javis-ai-model-select-trigger");
    fireEvent.click(modelSlotTriggers[0]); // primary is first slot
    fireEvent.click(document.body.querySelector(".javis-ai-model-select-menu button")!);
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles.find((profile: { slot: string }) => profile.slot === "primary")).toMatchObject({
      provider: "",
      model: "",
      apiKeyReference: "model.primary",
      baseUrl: "",
    });
  });

  it("normalizes slot connection settings from the provider model before saving", () => {
    const onModelConfigurationChange = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{
          provider: "mimo",
          model: "mimo-v2.5-pro",
          apiKey: "",
          apiKeyReference: "default",
          baseUrl: "https://api.deepseek.com",
        }}
        modelConfiguration={{
          profiles: [
            {
              id: "mimo-mimo-v2-5-pro",
              slot: null,
              displayName: "mimo-v2.5-pro",
              provider: "mimo",
              model: "mimo-v2.5-pro",
              apiKeyReference: "model.mimo",
              baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
              apiKey: "",
              capabilities: { vision: true, code: true, longContext: true },
            },
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "mimo",
              model: "mimo-v2.5-pro",
              apiKeyReference: "default",
              baseUrl: "https://api.deepseek.com",
              apiKey: "",
              capabilities: { vision: true, code: true, longContext: true },
            },
          ],
          agentOverrides: {},
        }}
        onModelConfigurationChange={onModelConfigurationChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles.find((profile: { slot: string }) => profile.slot === "primary")).toMatchObject({
      provider: "mimo",
      model: "mimo-v2.5-pro",
      apiKeyReference: "model.mimo",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      contextTokens: 1048576,
    });
  });

  it("adds provider models to the saved configuration", async () => {
    const onModelConfigurationChange = vi.fn();
    const onFetchProviderModels = vi.fn(async () => ["deepseek-v4-pro", "deepseek-v4-turbo"]);
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "deepseek", model: "deepseek-v4-pro", apiKey: "", apiKeyReference: "default", baseUrl: "https://api.deepseek.com" }}
        onModelConfigurationChange={onModelConfigurationChange}
        onFetchProviderModels={onFetchProviderModels}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(getByText("获取模型"));
    await vi.waitFor(() => {
      const menu = document.body.querySelector(".javis-ai-provider-model-menu");
      expect(menu).toBeTruthy();
    });
    const deepseekProOption = [...document.body.querySelectorAll(".javis-ai-provider-model-menu button")]
      .find((button) => button.textContent?.includes("deepseek-v4-pro")) as HTMLButtonElement;
    fireEvent.click(deepseekProOption);
    const markedDeepseekProOption = [...document.body.querySelectorAll(".javis-ai-provider-model-menu button")]
      .find((button) => button.textContent?.includes("deepseek-v4-pro")) as HTMLButtonElement;
    expect(markedDeepseekProOption.className).toContain("active");
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: null,
          provider: "deepseek",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com",
          contextTokens: 1000000,
        }),
      ]),
    );
  });

  it("fetches models with the selected provider default Base URL", async () => {
    const onFetchProviderModels = vi.fn(async () => ["openai/gpt-oss-120b"]);
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        onFetchProviderModels={onFetchProviderModels}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(getByText("OpenRouter"));
    fireEvent.click(getByText("获取模型"));

    await vi.waitFor(() => expect(onFetchProviderModels).toHaveBeenCalledOnce());
    expect(onFetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiType: "openai-compatible",
        keyReference: "model.openrouter",
        modelListMode: "openai",
      }),
    );
  });

  it("does not call the provider API for providers without a supported model list endpoint", async () => {
    const onFetchProviderModels = vi.fn(async () => ["gemini-2.5-pro"]);
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        onFetchProviderModels={onFetchProviderModels}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(getByText("Google Gemini"));
    fireEvent.click(getByText("获取模型"));

    expect(onFetchProviderModels).not.toHaveBeenCalled();
    expect(document.body.querySelector(".javis-ai-model-fetch-message")?.textContent).toContain("模型 ID");
  });
});
