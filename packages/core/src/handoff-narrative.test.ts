import { describe, expect, it } from "vitest";
import { formatHandoffNarrative } from "./handoff-narrative";
import type { HandoffReport, HandoffReportStepRecord } from "./shared-context";

function stepRecord(stepId: string, assignedAgentKind: string, inputContextKeys: string[] = []): HandoffReportStepRecord {
  return {
    stepId,
    assignedAgentKind,
    dependsOn: [],
    inputContextKeys,
    missingInputContextKeys: [],
    invalidInputContextKeys: [],
  };
}

function report(overrides: Partial<HandoffReport> = {}): HandoffReport {
  return {
    generatedAt: "2026-09-13T00:00:00.000Z",
    steps: [
      stepRecord("collect", "code"),
      stepRecord("verify", "verifier", ["repoSearch"]),
    ],
    handoffs: [
      {
        contextKey: "repoSearch",
        producedByStepId: "collect",
        consumedByStepIds: ["verify"],
        status: "available",
        valueSummary: { type: "object", present: true, keyCount: 3 },
      },
    ],
    missingInputContextKeys: [],
    invalidInputContextKeys: [],
    unconsumedOutputContextKeys: [],
    status: "complete",
    ...overrides,
  } as HandoffReport;
}

describe("formatHandoffNarrative", () => {
  it("names the producer and the consumers of a real handoff", () => {
    const narrative = formatHandoffNarrative(report());
    expect(narrative.status).toBe("complete");
    expect(narrative.lines).toHaveLength(1);
    expect(narrative.lines[0]).toMatchObject({
      kind: "handoff",
      from: "code",
      to: ["verifier"],
      contextKey: "repoSearch",
    });
    expect(narrative.lines[0].text).toContain("code → verifier");
    expect(narrative.summary).toBe("1 handoff, 0 gaps");
  });

  it("reports a consumed key with no producer as a gap", () => {
    const narrative = formatHandoffNarrative(report({
      handoffs: [{
        contextKey: "orphanValue",
        consumedByStepIds: ["verify"],
        status: "missing",
        valueSummary: { type: "undefined", present: false },
      }],
    }));
    expect(narrative.lines[0].kind).toBe("gap");
    expect(narrative.lines[0].text).toContain("no declared producer");
    expect(narrative.summary).toBe("0 handoffs, 1 gap");
  });

  it("surfaces missing, unconsumed and invalid keys as gaps", () => {
    const narrative = formatHandoffNarrative(report({
      handoffs: [],
      missingInputContextKeys: ["diffPreview"],
      unconsumedOutputContextKeys: ["scratchNotes"],
      invalidInputContextKeys: ["uiEvidence"],
      status: "needs_attention",
    }));
    expect(narrative.lines.map((line) => line.kind)).toEqual(["gap", "gap", "gap"]);
    const text = narrative.lines.map((line) => line.text).join(" | ");
    expect(text).toContain("missing upstream artifact");
    expect(text).toContain("no step read it");
    expect(text).toContain("declared schema");
    expect(narrative.summary).toBe("0 handoffs, 3 gaps");
  });

  it("renders the same story in Chinese", () => {
    const narrative = formatHandoffNarrative(report(), { locale: "zhCN" });
    expect(narrative.title).toBe("Agent 协作交接");
    expect(narrative.lines[0].text).toContain("code → verifier");
    expect(narrative.lines[0].text).toContain("交出");
    expect(narrative.summary).toContain("1 次交接");
  });

  it("de-duplicates repeated consumers", () => {
    const narrative = formatHandoffNarrative(report({
      steps: [stepRecord("collect", "code"), stepRecord("v1", "verifier"), stepRecord("v2", "verifier")],
      handoffs: [{
        contextKey: "repoSearch",
        producedByStepId: "collect",
        consumedByStepIds: ["v1", "v2"],
        status: "available",
        valueSummary: { type: "object", present: true },
      }],
    }));
    expect(narrative.lines[0].to).toEqual(["verifier"]);
    expect(narrative.lines[0].text).toContain("code → verifier:");
  });

  it("bounds the list and says it truncated", () => {
    const many = Array.from({ length: 40 }, (_, index) => `key-${index}`);
    const narrative = formatHandoffNarrative(report({
      handoffs: [],
      unconsumedOutputContextKeys: many,
    }), { maxLines: 5 });
    expect(narrative.lines).toHaveLength(5);
    expect(narrative.summary).toContain("showing first 5");
  });

  it("degrades to an empty narrative rather than throwing on an empty report", () => {
    const narrative = formatHandoffNarrative(report({ handoffs: [] }));
    expect(narrative.lines).toEqual([]);
    expect(narrative.summary).toBe("0 handoffs, 0 gaps");
  });
});
