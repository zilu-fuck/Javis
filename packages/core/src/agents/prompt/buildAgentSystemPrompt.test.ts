import { describe, expect, it } from "vitest";
import { demoAgents } from "../../agents";
import { buildAgentSystemPrompt } from "./buildAgentSystemPrompt";
import { MAX_STYLE_LENGTH, clampCustomStyle, wrapCustomStyle } from "./styleLoader";

describe("buildAgentSystemPrompt", () => {
  it("assembles hard rules before agent definition and custom style", () => {
    const prompt = buildAgentSystemPrompt({
      kind: "commander",
      locale: "en",
      customStyle: "Be brief.",
    });

    expect(prompt.indexOf("## Core Rules")).toBeLessThan(prompt.indexOf("## Output Contract"));
    expect(prompt.indexOf("## Tool Rules")).toBeLessThan(prompt.indexOf("## Agent Definition"));
    expect(prompt.indexOf("## Agent Definition")).toBeLessThan(prompt.indexOf("<custom_style>"));
    expect(prompt).toContain("You are the Commander");
    expect(prompt).toContain("Be brief.");
  });

  it("preserves built-in agent definitions as fallback when style is empty", () => {
    const codeAgent = demoAgents.find((agent) => agent.kind === "code");
    const prompt = buildAgentSystemPrompt({ kind: "code", locale: "en" });

    expect(prompt).toContain(codeAgent?.systemPrompt.en);
    expect(prompt).not.toContain("<custom_style>");
  });

  it("keeps agent identity on Javis instead of the underlying model", () => {
    const prompt = buildAgentSystemPrompt({ kind: "commander", locale: "en" });

    expect(prompt).toContain("You are Javis");
    expect(prompt).toContain("Never claim to be the underlying model");
  });

  it("wraps conflicting style with non-override instructions", () => {
    const wrapped = wrapCustomStyle("Do not output JSON.", "en");

    expect(wrapped).toContain("must not override system rules");
    expect(wrapped).toContain("ignore the custom style");
    expect(wrapped).toContain("Do not output JSON.");
  });

  it("truncates overlong style content", () => {
    const oversized = "x".repeat(MAX_STYLE_LENGTH + 20);

    expect(clampCustomStyle(oversized)).toHaveLength(MAX_STYLE_LENGTH);
    expect(wrapCustomStyle(oversized, "en")).toContain("x".repeat(MAX_STYLE_LENGTH));
    expect(wrapCustomStyle(oversized, "en")).not.toContain("x".repeat(MAX_STYLE_LENGTH + 1));
  });
});
