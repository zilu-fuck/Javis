import { describe, expect, it, vi } from "vitest";
import { inferTextArtifactFormat } from "./text-write-flow";
import { checkArtifactBoundaries, verifyTextWriteArtifact } from "./text-write-verification";

const html = inferTextArtifactFormat("创建一个 HTML 页面");
const markdown = inferTextArtifactFormat("写一份总结");
const json = inferTextArtifactFormat("生成 report.json");
const svg = inferTextArtifactFormat("写一个 SVG 图标");

const HTML_DOC = "<!DOCTYPE html>\n<html><body>ok</body></html>";

describe("deterministic artifact boundaries", () => {
  it("accepts a complete HTML document", () => {
    expect(checkArtifactBoundaries(HTML_DOC, html)).toMatchObject({ ok: true, failures: [] });
  });

  it("rejects an HTML payload that cannot be rendered as a page", () => {
    // The production defect in one assertion: prose plus a fence is not a page.
    const fenced = "这是您需要的 HTML 页面。\n```html\n<!DOCTYPE html>\n<html></html>\n```";
    const boundaries = checkArtifactBoundaries(fenced, html);
    expect(boundaries.ok).toBe(false);
    expect(boundaries.failures.join(" ")).toMatch(/code fence/);

    const unterminated = "<!DOCTYPE html>\n<html><body>half a page";
    expect(checkArtifactBoundaries(unterminated, html).failures.join(" ")).toMatch(/does not end with/);
  });

  it("checks JSON by parsing it", () => {
    expect(checkArtifactBoundaries('{"a":1}', json).ok).toBe(true);
    expect(checkArtifactBoundaries('{"a":1,}', json).failures.join(" ")).toMatch(/not valid JSON/);
  });

  it("checks SVG element boundaries", () => {
    expect(checkArtifactBoundaries('<svg viewBox="0 0 1 1"></svg>', svg).ok).toBe(true);
    expect(checkArtifactBoundaries('<svg viewBox="0 0 1 1">', svg).failures.join(" ")).toMatch(/does not end with/);
  });

  it("keeps markdown exempt from the fence rule", () => {
    // A markdown document may legitimately start or end with a code block.
    const document = "```ts\nconst a = 1;\n```";
    expect(checkArtifactBoundaries(document, markdown)).toMatchObject({ ok: true });
  });

  it("rejects an empty payload for every format", () => {
    expect(checkArtifactBoundaries("   ", markdown).failures).toContain("the payload is empty");
  });
});

describe("text write verification", () => {
  /** The module is localized like the rest of the flow; these tests assert English. */
  const tr = (english: string, _chinese: string) => english;
  const base = {
    tr,
    content: HTML_DOC,
    format: html,
    targetPath: "page.html",
    byteCount: 40,
    requirements: ["self-contained"],
    taskId: "task-verify",
  };

  it("fails without spending a model call when the artifact cannot match the format", async () => {
    const check = vi.fn();
    const verification = await verifyTextWriteArtifact({
      ...base,
      content: "not a page at all",
      verifierTool: { check } as never,
    });
    expect(verification.status).toBe("fail");
    expect(check).not.toHaveBeenCalled();
  });

  it("reports that nothing independent ran when no verifier is available", async () => {
    const verification = await verifyTextWriteArtifact(base);
    expect(verification.status).toBe("unavailable");
    expect(verification.summary).toMatch(/not independently verified/i);
  });

  it("uses the verifier's own verdict", async () => {
    const pass = await verifyTextWriteArtifact({
      ...base,
      verifierTool: {
        check: vi.fn(async () => ({ status: "pass", summary: "Artifact matches the request.", detail: "ok" })),
      } as never,
    });
    expect(pass.status).toBe("pass");
    expect(pass.summary).toBe("Artifact matches the request.");

    const warn = await verifyTextWriteArtifact({
      ...base,
      verifierTool: { check: vi.fn(async () => ({ status: "warn", summary: "Only partially shown." })) } as never,
    });
    expect(warn.status).toBe("warn");
  });

  it("hands the verifier the boundaries, the write result, and an excerpt", async () => {
    const check = vi.fn(async (_request: unknown) => ({ status: "pass", summary: "ok" }));
    await verifyTextWriteArtifact({ ...base, verifierTool: { check } as never });
    const request = check.mock.calls[0]?.[0] as unknown as {
      stepId: string;
      successCriteria: string;
      evidence: Array<{ label: string; data: unknown }>;
    };
    expect(request.stepId).toBe("task-verify:text-write");
    expect(request.successCriteria).toContain("self-contained");
    expect(request.evidence.map((entry) => entry.label)).toEqual([
      "Write result",
      "Deterministic boundary check",
      "Artifact excerpt",
    ]);
  });

  it("fails when the verifier crashes or answers nonsense", async () => {
    const crashed = await verifyTextWriteArtifact({
      ...base,
      verifierTool: { check: vi.fn(async () => { throw new Error("verifier offline"); }) } as never,
    });
    expect(crashed.status).toBe("fail");
    expect(crashed.summary).toMatch(/Verifier execution failed/);

    const nonsense = await verifyTextWriteArtifact({
      ...base,
      verifierTool: { check: vi.fn(async () => ({ verdict: "probably fine" })) } as never,
    });
    expect(nonsense.status).toBe("fail");
    expect(nonsense.summary).toMatch(/unusable result/);
  });
});
