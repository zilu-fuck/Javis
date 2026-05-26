import { describe, expect, it, vi } from "vitest";
import { createInputPreprocessorPrompt, preprocessChineseInput } from "./input-preprocessor";
import type { ModelProvider } from "./model-provider";

describe("input preprocessor", () => {
  it("extracts structured intent for colloquial Chinese input", async () => {
    const provider = createProvider(JSON.stringify({
      language: "zh-CN",
      intent: "论文润色",
      user_style: "正式自然",
      must_keep: ["原意"],
      must_avoid: ["AI腔", "模板化开头"],
      missing_info: ["需要润色的原文"],
    }));

    await expect(preprocessChineseInput("帮我写得像论文一点，不要那么AI", provider)).resolves.toEqual({
      language: "zh-CN",
      intent: "论文润色",
      user_style: "正式自然",
      must_keep: ["原意"],
      must_avoid: ["AI腔", "模板化开头"],
      missing_info: ["需要润色的原文"],
    });
    expect(provider.complete).toHaveBeenCalledWith(expect.stringContaining("Return JSON only"), {
      maxTokens: 700,
      temperature: 0,
      locale: "zh-CN",
    });
  });

  it("skips non-Chinese input without blocking routing", async () => {
    const provider = createProvider("{}");

    await expect(preprocessChineseInput("review my code", provider)).resolves.toBeUndefined();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("returns undefined when preprocessing fails", async () => {
    const provider = createProvider("not-json");

    await expect(preprocessChineseInput("这个怎么弄", provider)).resolves.toBeUndefined();
  });

  it("builds the expected preprocessor prompt", () => {
    expect(createInputPreprocessorPrompt("这个怎么弄")).toContain("missing information");
  });
});

function createProvider(responseText: string): ModelProvider {
  return {
    id: "test",
    settings: {
      provider: "deepseek",
      model: "deepseek/deepseek-chat",
      apiKeyReference: "default",
      baseUrl: "",
    },
    complete: vi.fn(async () => ({ text: responseText })),
    stream: vi.fn(),
    defaultSettingsForLocale: vi.fn(),
  } as unknown as ModelProvider;
}
