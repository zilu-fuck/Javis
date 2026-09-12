import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONCLUSION_MAX_CHARS,
  buildConclusionView,
  truncateAtSentence,
  type ConclusionViewInput,
} from "./conclusion-view";

function input(overrides: Partial<ConclusionViewInput> = {}): ConclusionViewInput {
  return {
    goal: "Summarise the repository structure",
    status: "completed",
    conclusion: "The repository is a pnpm monorepo with four packages. Core holds pure logic.",
    evidence: [
      { kind: "file", label: "README.md", reference: "README.md" },
      { kind: "file", label: "package.json", reference: "package.json" },
      { kind: "tool_result", label: "code.inspectWorkspace" },
    ],
    steps: [
      { id: "inspect", agentKind: "code", status: "completed" },
      { id: "verify", agentKind: "verifier", status: "completed" },
    ],
    ...overrides,
  };
}

describe("truncateAtSentence", () => {
  it("returns short text untouched", () => {
    expect(truncateAtSentence("Short answer.", 100)).toEqual({ text: "Short answer.", truncated: false });
  });

  it("cuts at a sentence boundary rather than mid-word", () => {
    const text = "First sentence is here. Second sentence is here. Third sentence is also here.";
    const result = truncateAtSentence(text, 40);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(".")).toBe(true);
    expect(text.startsWith(result.text)).toBe(true);
  });

  it("handles Chinese sentence terminators", () => {
    const text = "第一句话在这里。第二句话也在这里。第三句话仍然在这里。";
    const result = truncateAtSentence(text, 18);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("。")).toBe(true);
  });

  it("falls back to a word boundary when no sentence ends early enough", () => {
    const text = "word ".repeat(40).trim();
    const result = truncateAtSentence(text, 30);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(30);
    expect(result.text.endsWith("word")).toBe(true);
  });

  it("never returns a value longer than the limit", () => {
    for (const limit of [40, 60, 480]) {
      const long = "x".repeat(2_000);
      expect(truncateAtSentence(long, limit).text.length).toBeLessThanOrEqual(limit);
    }
  });
});

describe("buildConclusionView", () => {
  it("leads with status and goal, and shows the answer", () => {
    const view = buildConclusionView(input());
    expect(view.headline).toBe("Completed: Summarise the repository structure");
    expect(view.conclusion).toContain("pnpm monorepo");
    expect(view.truncated).toBe(false);
  });

  it("summarises evidence as counts and keeps the full list for expansion", () => {
    const view = buildConclusionView(input());
    expect(view.evidenceTotal).toBe(3);
    expect(view.evidenceSummary).toContain("2 file");
    expect(view.evidenceSummary).toContain("1 tool_result");
    expect(view.evidenceByKind[0]).toMatchObject({ kind: "file", count: 2 });
  });

  it("says there is no conclusion instead of showing an empty card", () => {
    const view = buildConclusionView(input({ conclusion: undefined }));
    expect(view.conclusion).toBe("");
    expect(view.bullets[0]).toContain("No final conclusion was produced");
  });

  it("keeps gaps in their own always-visible field", () => {
    const view = buildConclusionView(input({ gaps: ["diffPreview was never produced"] }));
    // Gaps are not evidence: burying them under evidence makes a partial result look complete.
    expect(view.gaps).toEqual(["diffPreview was never produced"]);
    expect(view.evidenceTotal).toBe(3);
  });

  it("explains a failure by naming the failed steps", () => {
    const view = buildConclusionView(input({
      status: "failed",
      conclusion: "",
      steps: [
        { id: "inspect", agentKind: "code", status: "completed" },
        { id: "write-report", agentKind: "file", status: "failed" },
      ],
    }));
    expect(view.headline).toContain("Failed");
    expect(view.bullets.join(" | ")).toContain("1 step(s) failed: write-report");
  });

  it("warns that a partial result may be incomplete", () => {
    const view = buildConclusionView(input({
      status: "partial",
      steps: [{ id: "inspect", agentKind: "code", status: "partial" }],
    }));
    expect(view.headline).toContain("Partially completed");
    expect(view.bullets.join(" ")).toContain("may be incomplete");
  });

  it("reports agent coverage only when no step failed", () => {
    const view = buildConclusionView(input({
      steps: [
        { id: "a", agentKind: "code", status: "completed" },
        { id: "b", agentKind: "code", status: "completed" },
        { id: "c", agentKind: "verifier", status: "completed" },
      ],
    }));
    expect(view.bullets.join(" ")).toContain("All 3 step(s) completed across 2 agent kind(s)");
  });

  it("includes usage when it is known", () => {
    const view = buildConclusionView(input({ usage: { totalTokens: 12_345, modelCalls: 4 } }));
    expect(view.bullets.join(" ")).toContain("4 model call(s), 12,345 tokens");
  });

  it("bounds the bullet count", () => {
    const view = buildConclusionView(input({
      status: "failed",
      usage: { totalTokens: 1, modelCalls: 1 },
      steps: [{ id: "x", agentKind: "code", status: "failed" }],
    }), { maxBullets: 2 });
    expect(view.bullets).toHaveLength(2);
  });

  it("truncates a long answer and says so", () => {
    const long = `${"Sentence about the result. ".repeat(60)}`;
    const view = buildConclusionView(input({ conclusion: long }), { maxChars: 200 });
    expect(view.truncated).toBe(true);
    expect(view.conclusion.length).toBeLessThanOrEqual(200);
    expect(view.conclusion.endsWith(".")).toBe(true);
  });

  it("renders in Chinese", () => {
    const view = buildConclusionView(input({
      conclusion: undefined,
      usage: { totalTokens: 500, modelCalls: 2 },
    }), { locale: "zhCN" });
    expect(view.headline).toContain("已完成");
    expect(view.bullets.join(" ")).toContain("没有产出最终结论");
    expect(view.evidenceSummary).toContain("2 file");
  });

  it("handles a completely empty result without throwing", () => {
    const view = buildConclusionView({ goal: "", status: "running" });
    expect(view.headline).toBe("Running");
    expect(view.conclusion).toBe("");
    expect(view.evidenceByKind).toEqual([]);
    expect(view.evidenceSummary).toBe("No evidence items");
    expect(view.gaps).toEqual([]);
  });

  it("uses the documented defaults", () => {
    expect(DEFAULT_CONCLUSION_MAX_CHARS).toBe(480);
    const view = buildConclusionView(input());
    expect(view.evidenceByKind.length).toBeLessThanOrEqual(3);
  });
});
