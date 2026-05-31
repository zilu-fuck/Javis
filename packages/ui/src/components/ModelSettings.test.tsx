import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSettings } from "./ModelSettings";
import { zhCNWorkbenchLocale } from "../locale";

const labels = zhCNWorkbenchLocale.labels;

describe("ModelSettings", () => {
  afterEach(() => {
    cleanup();
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

  it("adds provider models to the saved configuration", () => {
    const onModelConfigurationChange = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "deepseek", model: "deepseek-v4-pro", apiKey: "", apiKeyReference: "default", baseUrl: "https://api.deepseek.com" }}
        onModelConfigurationChange={onModelConfigurationChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(getByText("查看已添加"));
    expect(document.body.querySelector(".javis-ai-model-fetch-message")?.textContent).toContain("已添加");
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
        }),
      ]),
    );
  });
});
