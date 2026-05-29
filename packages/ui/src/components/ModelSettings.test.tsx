import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelSettings } from "./ModelSettings";
import { zhCNWorkbenchLocale } from "../locale";

const labels = zhCNWorkbenchLocale.labels;

describe("ModelSettings", () => {
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
});
