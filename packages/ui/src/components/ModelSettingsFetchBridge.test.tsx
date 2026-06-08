import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultWorkbenchLocale } from "../locale";
import { ModelSettings } from "./ModelSettings";

describe("ModelSettings provider model fetch bridge", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not fetch provider models directly when the desktop fetch bridge is unavailable", async () => {
    const browserFetch = vi.fn();
    vi.stubGlobal("fetch", browserFetch);
    const { container, getByLabelText, getByText } = render(
      <ModelSettings
        labels={defaultWorkbenchLocale.labels}
        modelSettings={{
          provider: "openai",
          model: "",
          apiKey: "",
          apiKeyReference: "default",
          baseUrl: "https://api.openai.com/v1",
        }}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(defaultWorkbenchLocale.labels.aiModeSettings));
    fireEvent.change(getByLabelText(defaultWorkbenchLocale.labels.modelApiKey ?? "API Key"), {
      target: { value: "typed-secret" },
    });
    fireEvent.click(getByText("Fetch models"));

    expect(browserFetch).not.toHaveBeenCalled();
    expect(document.body.querySelector(".javis-ai-model-fetch-message")?.textContent ?? "").toContain(
      "Model list backend is unavailable",
    );
  });
});
