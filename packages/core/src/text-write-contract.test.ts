import { describe, expect, it, vi } from "vitest";
import {
  alignTargetExtension,
  buildTextWriteContractPrompt,
  decideTextWriteContract,
  fallbackTextWriteContract,
  parseTextWriteContractDecision,
} from "./text-write-contract";
import { inferTextArtifactFormat } from "./text-write-flow";

const GOAL = "创建一个 HTML，内容是: SVG 绘制一个鹈鹕骑自行车的 2D 动画。";
const DECISION_INPUT = { userGoal: GOAL, fallbackTargetPath: "一个-html-内容是-svg-动画.md" };

describe("artifact contract decision parsing", () => {
  it("takes the format, name, and requirements the Commander decided", () => {
    const contract = parseTextWriteContractDecision(
      JSON.stringify({
        format: "html",
        fileName: "pelican-bike.html",
        requirements: ["self-contained", "starts with <!DOCTYPE html>"],
        reasoning: "The user asked for a web page.",
      }),
      DECISION_INPUT,
    );
    expect(contract.source).toBe("commander");
    expect(contract.format.extension).toBe(".html");
    expect(contract.targetPath).toBe("pelican-bike.html");
    expect(contract.requirements).toEqual(["self-contained", "starts with <!DOCTYPE html>"]);
    expect(contract.reasoning).toBe("The user asked for a web page.");
  });

  it("reads a decision that arrives wrapped in prose or a fence", () => {
    const contract = parseTextWriteContractDecision(
      "好的，我的判断是：\n```json\n{\"format\":\"svg\",\"fileName\":\"icon.svg\",\"requirements\":[]}\n```\n希望有帮助。",
      DECISION_INPUT,
    );
    expect(contract.source).toBe("commander");
    expect(contract.format.extension).toBe(".svg");
    expect(contract.targetPath).toBe("icon.svg");
  });

  it("corrects a file name whose extension contradicts the decided format", () => {
    // The format field is the decision; the name is only a suggestion.
    const contract = parseTextWriteContractDecision(
      JSON.stringify({ format: "html", fileName: "page.md", requirements: [] }),
      DECISION_INPUT,
    );
    expect(contract.format.extension).toBe(".html");
    expect(contract.targetPath).toBe("page.html");
  });

  it("falls back instead of accepting a format the write path cannot produce", () => {
    const contract = parseTextWriteContractDecision(
      JSON.stringify({ format: "exe", fileName: "payload.exe" }),
      DECISION_INPUT,
    );
    expect(contract.source).toBe("fallback");
    expect(contract.format.extension).toBe(".html");
    expect(contract.targetPath).toBe(DECISION_INPUT.fallbackTargetPath);
    expect(contract.fallbackReason).toMatch(/unsupported format/);
  });

  it("refuses file names that could leave the workspace", () => {
    for (const fileName of ["../escape.html", "C:/Windows/system32/page.html", "/etc/page.html", "docs/../../x.html"]) {
      const contract = parseTextWriteContractDecision(
        JSON.stringify({ format: "html", fileName }),
        DECISION_INPUT,
      );
      expect(contract.source).toBe("fallback");
      expect(contract.fallbackReason).toMatch(/unusable file name/);
    }
  });

  it("caps requirements and drops empty ones", () => {
    const contract = parseTextWriteContractDecision(
      JSON.stringify({
        format: "md",
        fileName: "notes.md",
        requirements: ["a", "  ", "b", "c", "d", "e"],
      }),
      DECISION_INPUT,
    );
    expect(contract.requirements).toEqual(["a", "b", "c", "d"]);
  });

  it("falls back on answers that are not a JSON object", () => {
    const contract = parseTextWriteContractDecision("I think you want an HTML page.", DECISION_INPUT);
    expect(contract.source).toBe("fallback");
    expect(contract.fallbackReason).toMatch(/not a JSON object/);
  });
});

describe("target extension alignment", () => {
  const html = inferTextArtifactFormat("创建一个 HTML 页面");

  it("keeps a workspace-relative subdirectory", () => {
    expect(alignTargetExtension("docs/report.md", html)).toBe("docs/report.html");
  });

  it("normalizes Windows separators instead of rejecting the name", () => {
    expect(alignTargetExtension("docs\\report.md", html)).toBe("docs/report.html");
  });

  it("rejects names with no usable stem", () => {
    expect(alignTargetExtension(".html", html)).toBeUndefined();
    expect(alignTargetExtension("", html)).toBeUndefined();
  });
});

describe("contract decision call", () => {
  it("degrades to the regex contract when no model is configured", async () => {
    const contract = await decideTextWriteContract({
      decisionInput: DECISION_INPUT,
      chatTool: undefined,
      locale: "zh-CN",
    });
    expect(contract.source).toBe("fallback");
    expect(contract.format.extension).toBe(".html");
    expect(contract.fallbackReason).toMatch(/No text-generation model/);
  });

  it("degrades instead of failing the task when the model call throws", async () => {
    const contract = await decideTextWriteContract({
      decisionInput: DECISION_INPUT,
      chatTool: {
        complete: vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
      } as never,
      locale: "zh-CN",
    });
    expect(contract.source).toBe("fallback");
    expect(contract.fallbackReason).toContain("provider unavailable");
  });

  it("uses the Commander's answer when the call succeeds", async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({ format: "html", fileName: "鹈鹕骑车.html", requirements: ["self-contained"] }),
    }));
    const contract = await decideTextWriteContract({
      decisionInput: DECISION_INPUT,
      chatTool: { complete } as never,
      locale: "zh-CN",
    });
    expect(contract.source).toBe("commander");
    expect(contract.targetPath).toBe("鹈鹕骑车.html");
    expect(complete).toHaveBeenCalledTimes(1);
    const [prompt, options] = complete.mock.calls[0] as unknown as [string, { temperature?: number; maxTokens?: number }];
    expect(prompt).toContain("html, htm, css");
    expect(prompt).toContain(GOAL);
    expect(options?.temperature).toBe(0);
  });
});

describe("contract decision prompt", () => {
  it("offers the supported formats, the naming hint, and the inventory state", () => {
    const prompt = buildTextWriteContractPrompt({
      userGoal: GOAL,
      fallbackTargetPath: "fallback.md",
      locale: "zh-CN",
    });
    expect(prompt).toContain("md, html, htm, css");
    expect(prompt).toContain("fallback.md");
    expect(prompt).toContain("No workspace inventory is available.");
    expect(prompt).toContain(`User request: ${GOAL}`);

    const withInventory = buildTextWriteContractPrompt({
      userGoal: GOAL,
      fallbackTargetPath: "fallback.md",
      workspaceInventory: "top-level: assets, src",
      locale: "zh-CN",
    });
    expect(withInventory).toContain("top-level: assets, src");
    expect(withInventory).not.toContain("No workspace inventory is available.");
  });
});

describe("fallback contract", () => {
  it("carries the regex format and the reason it was used", () => {
    const contract = fallbackTextWriteContract(DECISION_INPUT, "timeout");
    expect(contract.source).toBe("fallback");
    expect(contract.format.extension).toBe(".html");
    expect(contract.fallbackReason).toBe("timeout");
    expect(contract.requirements).toEqual([]);
  });
});

describe("contract justification reaches the user", () => {
  it("keeps the Commander's one-line reason on the parsed contract", () => {
    // Reasoning tokens are live-only in this app, so this line is the only
    // durable answer to "why this artifact" — it must not be parsed and dropped.
    const contract = parseTextWriteContractDecision(
      JSON.stringify({
        format: "html",
        fileName: "page.html",
        requirements: [],
        reasoning: "请求的是一个可直接打开的网页。",
      }),
      DECISION_INPUT,
    );
    expect(contract.reasoning).toBe("请求的是一个可直接打开的网页。");
  });

  it("leaves the reason undefined when the model omits or blanks it", () => {
    for (const raw of [
      JSON.stringify({ format: "html", fileName: "page.html" }),
      JSON.stringify({ format: "html", fileName: "page.html", reasoning: "   " }),
    ]) {
      expect(parseTextWriteContractDecision(raw, DECISION_INPUT).reasoning).toBeUndefined();
    }
  });
});

describe("decision usage reporting", () => {
  it("reports the decision call's usage exactly once", async () => {
    const onUsage = vi.fn();
    const contract = await decideTextWriteContract({
      decisionInput: DECISION_INPUT,
      chatTool: {
        complete: vi.fn(async () => ({ text: JSON.stringify({ format: "html", fileName: "p.html" }) })),
      } as never,
      locale: "zh-CN",
      onUsage,
    });
    expect(contract.source).toBe("commander");
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});
