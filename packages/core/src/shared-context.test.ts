import { describe, expect, it } from "vitest";
import {
  buildHandoffReport,
  CONTEXT_KEYS,
  createHandoffReportArtifacts,
  createSharedTaskContext,
  formatHandoffReportMarkdown,
  formatStepInputValidationError,
  validateContextValue,
  validateStepInputContext,
} from "./shared-context";

describe("createSharedTaskContext", () => {
  it("stores typed values and exposes a serializable snapshot", () => {
    const context = createSharedTaskContext({ taskId: "task-1" });

    context.set("fileScan", { count: 2 });

    expect(context.has("taskId")).toBe(true);
    expect(context.get<{ count: number }>("fileScan")?.count).toBe(2);
    expect(context.snapshot()).toEqual({
      taskId: "task-1",
      fileScan: { count: 2 },
    });

    context.clear();

    expect(context.has("taskId")).toBe(false);
    expect(context.snapshot()).toEqual({});
  });

  it("resolves a bilingual context key to the zh-CN form", () => {
    const context = createSharedTaskContext();
    const key = context.resolveKey(CONTEXT_KEYS.USER_GOAL, "zh-CN");

    context.set(key, { intent: "技术解释" });

    expect(key).toBe("用户目标");
    expect(context.get<{ intent: string }>(key)?.intent).toBe("技术解释");
  });

  it("validates known context key schemas while allowing unknown keys", () => {
    const context = createSharedTaskContext({
      diffPreview: { diff: "diff --git", changedFiles: ["src/app.ts"] },
      dynamicKey: {},
    });

    expect(validateContextValue("diffPreview", context.get("diffPreview")).valid).toBe(true);
    expect(validateContextValue("dynamicKey", context.get("dynamicKey")).valid).toBe(true);

    context.set("diffPreview", { diff: "missing changedFiles" });
    const result = validateStepInputContext({ id: "review", inputContextKeys: ["diffPreview", "missing"] }, context);

    expect(result.valid).toBe(false);
    expect(result.missingInputContextKeys).toEqual(["missing"]);
    expect(result.invalidInputContextKeys).toMatchObject([
      { key: "diffPreview", expectedType: "object { diff: string, changedFiles: string[] }" },
    ]);
    expect(formatStepInputValidationError(result)).toContain("Input context validation failed for step review");
  });
});

describe("buildHandoffReport", () => {
  it("serializes producer and consumer handoffs with compact value summaries", () => {
    const context = createSharedTaskContext({
      repoEvidence: { keyFiles: ["src/app.ts"], edges: 2 },
      reviewFindings: ["missing test"],
    });

    const report = buildHandoffReport([
      {
        id: "inspect-repo",
        title: "Inspect repository",
        assignedAgentKind: "code",
        outputContextKey: "repoEvidence",
        successCriteria: "Repo evidence exists.",
      },
      {
        id: "review-evidence",
        title: "Review evidence",
        assignedAgentKind: "verifier",
        dependsOn: ["inspect-repo"],
        inputContextKeys: ["repoEvidence"],
        outputContextKey: "reviewFindings",
        successCriteria: "Review findings are recorded.",
      },
      {
        id: "summarize",
        title: "Summarize",
        assignedAgentKind: "commander",
        dependsOn: ["review-evidence"],
        inputContextKeys: ["reviewFindings"],
        successCriteria: "Final summary uses review findings.",
      },
    ], context, { generatedAt: "2026-06-11T00:00:00.000Z" });

    expect(report.status).toBe("complete");
    expect(report.generatedAt).toBe("2026-06-11T00:00:00.000Z");
    expect(report.handoffs).toEqual([
      {
        contextKey: "repoEvidence",
        producedByStepId: "inspect-repo",
        consumedByStepIds: ["review-evidence"],
        status: "available",
        valueSummary: { type: "object", present: true, keyCount: 2 },
      },
      {
        contextKey: "reviewFindings",
        producedByStepId: "review-evidence",
        consumedByStepIds: ["summarize"],
        status: "available",
        valueSummary: { type: "array", present: true, itemCount: 1 },
      },
    ]);
    expect(report.missingInputContextKeys).toEqual([]);
    expect(report.unconsumedOutputContextKeys).toEqual([]);
  });

  it("flags missing inputs and unconsumed outputs without storing full values", () => {
    const report = buildHandoffReport([
      {
        id: "draft",
        title: "Draft answer",
        assignedAgentKind: "commander",
        outputContextKey: "draftText",
      },
      {
        id: "verify",
        title: "Verify missing evidence",
        assignedAgentKind: "verifier",
        inputContextKeys: ["sourceEvidence"],
      },
    ], {
      draftText: "abcdefghijklmnopqrstuvwxyz",
    }, {
      generatedAt: "2026-06-11T00:00:00.000Z",
      previewLength: 8,
    });

    expect(report.status).toBe("needs_attention");
    expect(report.missingInputContextKeys).toEqual(["sourceEvidence"]);
    expect(report.unconsumedOutputContextKeys).toEqual(["draftText"]);
    expect(report.handoffs).toEqual([
      {
        contextKey: "draftText",
        producedByStepId: "draft",
        consumedByStepIds: [],
        status: "unconsumed",
        valueSummary: { type: "string", present: true, preview: "abcdefgh" },
      },
      {
        contextKey: "sourceEvidence",
        producedByStepId: undefined,
        consumedByStepIds: ["verify"],
        status: "missing",
        valueSummary: { type: "undefined", present: false },
      },
    ]);
    expect(report.steps.find((step) => step.stepId === "verify")?.missingInputContextKeys)
      .toEqual(["sourceEvidence"]);
  });

  it("formats stable JSON and Markdown artifacts for saving handoff evidence", () => {
    const report = buildHandoffReport([
      {
        id: "collect",
        title: "Collect evidence",
        assignedAgentKind: "code",
        outputContextKey: "repoEvidence",
      },
      {
        id: "review",
        title: "Review evidence",
        assignedAgentKind: "verifier",
        inputContextKeys: ["repoEvidence", "missingSource"],
        outputContextKey: "reviewFindings",
      },
    ], {
      repoEvidence: { keyFiles: ["src/index.ts"] },
      reviewFindings: "ok|needs follow-up",
    }, {
      generatedAt: "2026-06-11T00:00:00.000Z",
      previewLength: 24,
    });

    const artifacts = createHandoffReportArtifacts(report, {
      baseName: "../handoff evidence.md",
    });
    const markdown = formatHandoffReportMarkdown(report);

    expect(artifacts.map((artifact) => artifact.fileName)).toEqual([
      "handoff-evidence.json",
      "handoff-evidence.md",
    ]);
    expect(JSON.parse(artifacts[0]!.content)).toMatchObject({
      status: "needs_attention",
      missingInputContextKeys: ["missingSource"],
      unconsumedOutputContextKeys: ["reviewFindings"],
    });
    expect(artifacts[1]!.content).toBe(markdown);
    expect(markdown).toContain("# Agent Handoff Report");
    expect(markdown).toContain("- Missing inputs: missingSource");
    expect(markdown).toContain("- Unconsumed outputs: reviewFindings");
    expect(markdown).toContain("| repoEvidence | collect | review | available | object: 1 key(s) |");
    expect(markdown).toContain("| reviewFindings | review | none | unconsumed | string: ok\\|needs follow-up |");
  });

  it("marks handoffs with invalid known schemas as needing attention", () => {
    const report = buildHandoffReport([
      {
        id: "inspect",
        title: "Inspect diff",
        assignedAgentKind: "code",
        outputContextKey: "diffPreview",
      },
      {
        id: "verify",
        title: "Verify diff",
        assignedAgentKind: "verifier",
        inputContextKeys: ["diffPreview"],
      },
    ], {
      diffPreview: { diff: "diff --git" },
    }, {
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    expect(report.status).toBe("needs_attention");
    expect(report.invalidInputContextKeys).toEqual(["diffPreview"]);
    expect(report.handoffs[0]).toMatchObject({
      contextKey: "diffPreview",
      status: "invalid_schema",
      schemaError: "expected object { diff: string, changedFiles: string[] }",
    });
  });
});
