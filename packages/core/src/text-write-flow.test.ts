import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_TIMEOUT_MS } from "./task-wait";
import {
  DEFAULT_TEXT_ARTIFACT_FORMAT,
  TEXT_GENERATION_STALL_TIMEOUT_MS,
  appendTextTargetSuffix,
  buildTextGenerationPrompt,
  hasUsablePartialContent,
  inferTextArtifactFormat,
  isTextWriteGoal,
  normalizeGeneratedContent,
  resolveGenerationTimeoutMs,
  resolveTextWriteTarget,
} from "./text-write-flow";

/** The format a goal that says "创建一个 HTML 页面" resolves to. */
const htmlFormat = inferTextArtifactFormat("创建一个 HTML 页面");

describe("text generation budget", () => {
  it("gives long-form generation far more room than the generic task timeout", () => {
    // The observed production failure was a text-write task dying at exactly the
    // 180s task timeout and discarding the document it had already generated.
    const budget = resolveGenerationTimeoutMs(90_000);
    expect(budget).toBeGreaterThanOrEqual(270_000);
    expect(resolveGenerationTimeoutMs(180_000)).toBeGreaterThan(270_000);
  });

  it("falls back to the default task timeout when none is configured", () => {
    expect(resolveGenerationTimeoutMs(undefined)).toBeGreaterThan(DEFAULT_TASK_TIMEOUT_MS);
    expect(resolveGenerationTimeoutMs(Number.NaN)).toBeGreaterThan(DEFAULT_TASK_TIMEOUT_MS);
  });

  it("scales with an explicitly requested length", () => {
    const short = resolveGenerationTimeoutMs(90_000);
    const long = resolveGenerationTimeoutMs(90_000, { amount: 5_000, unit: "words" });
    expect(long).toBeGreaterThan(short);
  });

  it("never exceeds the hard ceiling", () => {
    expect(resolveGenerationTimeoutMs(900_000, { amount: 1_000_000, unit: "words" })).toBeLessThanOrEqual(900_000);
  });

  it("treats a stalled generation as worth keeping only when it produced real text", () => {
    expect(hasUsablePartialContent("")).toBe(false);
    expect(hasUsablePartialContent("   \n  ")).toBe(false);
    expect(hasUsablePartialContent("short")).toBe(false);
    expect(hasUsablePartialContent("A".repeat(200))).toBe(true);
  });

  it("keeps the stall window well below the generation budget", () => {
    expect(TEXT_GENERATION_STALL_TIMEOUT_MS).toBeLessThan(resolveGenerationTimeoutMs(90_000));
  });
});

describe("write intent gating", () => {
  it("accepts explicit write instructions", () => {
    expect(isTextWriteGoal("把这份总结保存到 notes.md")).toBe(true);
    expect(isTextWriteGoal("save this summary to notes.md")).toBe(true);
    expect(isTextWriteGoal("生成一份 README.md 的项目说明")).toBe(true);
    expect(isTextWriteGoal("导出这次分析结果到 report.md")).toBe(true);
  });

  it("refuses questions and review requests", () => {
    // Both of these opened a confirmed-write approval card before the gate.
    expect(isTextWriteGoal("如何创建一个 HTML 页面？")).toBe(false);
    expect(isTextWriteGoal("做一个页面设计评审")).toBe(false);
    expect(isTextWriteGoal("How do I create a report in Excel?")).toBe(false);
    expect(isTextWriteGoal("review the notes document")).toBe(false);
  });

  it("does not treat answering with code as writing a file", () => {
    expect(isTextWriteGoal("write a function that reverses a linked list")).toBe(false);
    expect(isTextWriteGoal("解释一下这个脚本")).toBe(false);
  });
});

describe("artifact format inference", () => {
  it("follows the format the goal names", () => {
    // Production case: this goal was written to a .md file before the fix.
    expect(inferTextArtifactFormat("创建一个 HTML，内容是: SVG 绘制一个鹈鹕骑自行车的 2D 动画。").extension).toBe(".html");
    expect(inferTextArtifactFormat("创建一个 HTML 文件，内容是 SVG 动画").extension).toBe(".html");
    expect(inferTextArtifactFormat("create an HTML page with a CSS animation").extension).toBe(".html");
    expect(inferTextArtifactFormat("写一个 SVG 图标").extension).toBe(".svg");
    expect(inferTextArtifactFormat("生成一份 JSON 报告").extension).toBe(".json");
  });

  it("prefers the artifact over a format that only describes its content", () => {
    // "HTML" names the file; "SVG" is what the file contains.
    const format = inferTextArtifactFormat("创建一个 HTML，内容是: SVG 绘制一只鹈鹕");
    expect(format.extension).toBe(".html");
    expect(format.label).toBe("HTML");
  });

  it("lets an explicit file name win over keywords", () => {
    expect(inferTextArtifactFormat("生成 report.json").extension).toBe(".json");
    expect(inferTextArtifactFormat("把结果保存为 card.html").extension).toBe(".html");
  });

  it("keeps markdown when the goal names no format", () => {
    expect(inferTextArtifactFormat("写一份项目总结").extension).toBe(".md");
    expect(inferTextArtifactFormat("写一篇 markdown 文档").extension).toBe(".md");
  });

  it("does not mistake a document about a format for that format", () => {
    // A tutorial stored as .js would be prose under a code extension.
    expect(inferTextArtifactFormat("写一份 JS 教程").extension).toBe(".md");
    expect(inferTextArtifactFormat("生成一份 CSS 指南").extension).toBe(".md");
  });
});

describe("text write target naming", () => {
  it("gives a format-naming goal that format's extension", () => {
    // The exact name the production bug produced, with the extension it should
    // have had.
    const target = resolveTextWriteTarget("创建一个 HTML，内容是: SVG 绘制一个鹈鹕骑自行车的 2D 动画。");
    expect(target.path).toBe("一个-html-内容是-svg-绘制一个鹈鹕骑自行车的-2d-动画.html");
    expect(target.explicit).toBe(false);
    expect(target.format.extension).toBe(".html");
  });

  it("keeps the legacy markdown name for goals without a format", () => {
    expect(resolveTextWriteTarget("写一份项目分析报告").path).toBe("项目分析报告.md");
    expect(resolveTextWriteTarget("帮我整理一份会议纪要").path).toBe("整理一份会议纪要.md");
    expect(resolveTextWriteTarget("生成一份 README.md 的项目说明").path).toBe("README.md");
    expect(resolveTextWriteTarget("把这份总结保存到 notes.md").path).toBe("notes.md");
  });

  it("honours explicit destinations for every supported extension", () => {
    // Only .md destinations were recognised before the fix.
    const jsonTarget = resolveTextWriteTarget("生成 report.json");
    expect(jsonTarget.path).toBe("report.json");
    expect(jsonTarget.explicit).toBe(true);
    expect(resolveTextWriteTarget("把结果保存为 card.html").path).toBe("card.html");
  });

  it("puts the retry suffix before the extension", () => {
    expect(appendTextTargetSuffix("notes.md", 1)).toBe("notes-1.md");
    expect(appendTextTargetSuffix("card.html", 2)).toBe("card-2.html");
    expect(appendTextTargetSuffix("no-extension", 1)).toBe("no-extension-1");
  });
});

describe("generated content cleanup", () => {
  /** Shape of the artifact the production bug actually wrote to disk. */
  const fencedHtml = [
    "这是您需要的 HTML 页面，用 SVG 绘制了一只骑自行车的鹈鹕，并带有 2D 动画效果。",
    "```html",
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    '<body><svg><circle r="4"/></svg></body>',
    "</html>",
    "```",
  ].join("\n");

  it("unwraps the prose and fence a model added around a page", () => {
    const cleaned = normalizeGeneratedContent(fencedHtml, htmlFormat);
    expect(cleaned.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(cleaned.endsWith("</html>")).toBe(true);
    expect(cleaned).not.toContain("```");
    expect(cleaned).not.toContain("这是您需要的 HTML 页面");
  });

  it("cuts an unfenced page down to its document boundaries", () => {
    const cleaned = normalizeGeneratedContent(
      "好的，这是你要的页面：\n<!DOCTYPE html>\n<html><body>x</body></html>\n希望你喜欢！",
      htmlFormat,
    );
    expect(cleaned).toBe("<!DOCTYPE html>\n<html><body>x</body></html>");
  });

  it("keeps a fenced payload it cannot confidently unwrap", () => {
    const payload = "<!DOCTYPE html>\n<html><body>``` not a wrapper ```</body></html>";
    expect(normalizeGeneratedContent(payload, htmlFormat)).toBe(payload);
  });

  it("unwraps a markdown payload that is fenced end to end", () => {
    expect(normalizeGeneratedContent("```markdown\n# 标题\n```")).toBe("# 标题");
  });

  it("leaves a markdown document's own code block alone", () => {
    // Fences are legitimate markdown; only a wrapping pair is removed.
    const document = "# 标题\n\n正文\n\n```ts\nconst a = 1;\n```\n";
    expect(normalizeGeneratedContent(document)).toBe(document.trim());
  });
});

describe("generation prompt", () => {
  it("describes the artifact type the goal asked for", () => {
    const htmlPrompt = buildTextGenerationPrompt("创建一个 HTML 页面", "card.html", [], htmlFormat);
    expect(htmlPrompt).toContain("local HTML file for the user");
    expect(htmlPrompt).toContain("Start with <!DOCTYPE html> and end with </html>.");
    expect(htmlPrompt).not.toContain("local Markdown file");
  });

  it("keeps the markdown prompt as it was", () => {
    const markdownPrompt = buildTextGenerationPrompt(
      "写一份总结",
      "总结.md",
      [],
      DEFAULT_TEXT_ARTIFACT_FORMAT,
    );
    expect(markdownPrompt).toContain("complete contents of a local Markdown file");
    expect(markdownPrompt).not.toContain("<!DOCTYPE html>");
  });

  it("binds the requirements the Commander decided into the prompt", () => {
    const prompt = buildTextGenerationPrompt(
      "创建一个 HTML 页面",
      "card.html",
      [],
      htmlFormat,
      undefined,
      ["self-contained", "no external assets"],
    );
    expect(prompt).toContain("Requirements decided for this artifact:");
    expect(prompt).toContain("- self-contained");
    expect(prompt).toContain("- no external assets");
    // Without requirements the block must not appear at all.
    const plain = buildTextGenerationPrompt("创建一个 HTML 页面", "card.html", [], htmlFormat);
    expect(plain).not.toContain("Requirements decided for this artifact:");
  });
});
