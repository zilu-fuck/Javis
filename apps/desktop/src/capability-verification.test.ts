import { describe, expect, it } from "vitest";
import {
  buildRuntimeCapabilityVerification,
  parseProductWorkflowEvidenceInventoryJson,
  productWorkflowInventoryJsonToCapabilityEvidence,
  productWorkflowScenariosToCapabilityEvidence,
  toolAuditRecordToCapabilitySignal,
} from "./capability-verification";
import type { ToolCallAuditRecord } from "./tool-call-audit";

describe("runtime capability verification", () => {
  it("converts terminal tool audit records to capability tool signals", () => {
    expect(toolAuditRecordToCapabilitySignal(record("web.search", "succeeded"))).toEqual({
      toolName: "web.search",
      status: "succeeded",
    });
    expect(toolAuditRecordToCapabilitySignal(record("web.search", "failed"))).toEqual({
      toolName: "web.search",
      status: "failed",
    });
    expect(toolAuditRecordToCapabilitySignal(record("web.search", "denied"))).toEqual({
      toolName: "web.search",
      status: "cancelled",
    });
    expect(toolAuditRecordToCapabilitySignal(record("web.search", "running"))).toBeNull();
  });

  it("derives recent failure rates from bounded recent audit records", () => {
    const verification = buildRuntimeCapabilityVerification({
      maxToolSignals: 2,
      toolAuditRecords: [
        record("web.search", "failed"),
        record("web.search", "succeeded"),
        record("web.search", "failed"),
      ],
    });

    expect(verification.recentFailureRateByAgentKind?.research).toBe(0.5);
    expect(verification.recentFailureRateByCapabilityTag?.web_search).toBe(0.5);
  });

  it("converts passed product workflow scenarios into capability QA/live evidence", () => {
    const records = productWorkflowScenariosToCapabilityEvidence([
      { Scenario: "repo-intelligence-package-live", Status: "PASS" },
      { Scenario: "trend-hot-list-live", Status: "BLOCKED" },
    ], "docs/qa/2026-06-10/product-workflows.json");

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "qa",
        status: "passed",
        capabilityTags: expect.arrayContaining(["code_search", "code_trace"]),
        evidenceRef: "docs/qa/2026-06-10/product-workflows.json#repo-intelligence-package-live",
      }),
      expect.objectContaining({
        kind: "live",
        status: "passed",
        capabilityTags: expect.arrayContaining(["code_search", "code_trace"]),
      }),
      expect.objectContaining({
        kind: "qa",
        status: "blocked",
        capabilityTags: expect.arrayContaining(["trend_fetch"]),
      }),
    ]));
  });

  it("combines product workflow evidence with recent tool failure signals", () => {
    const verification = buildRuntimeCapabilityVerification({
      productWorkflowEvidenceRef: "docs/qa/2026-06-10/product-workflows.json",
      productWorkflowScenarios: [
        { Scenario: "agent-memory-embedding-provider-live", Status: "PASS" },
      ],
      toolAuditRecords: [
        record("memory.search", "failed"),
        record("memory.search", "succeeded"),
      ],
    });

    expect(verification.qaPassedCapabilityTags).toContain("memory_search");
    expect(verification.liveVerifiedCapabilityTags).toContain("memory_search");
    expect(verification.evidenceRefsByCapabilityTag?.memory_search).toContain(
      "docs/qa/2026-06-10/product-workflows.json#agent-memory-embedding-provider-live",
    );
    expect(verification.recentFailureRateByCapabilityTag?.memory_search).toBe(0.5);
  });

  it("parses product workflow JSON inventory into capability evidence records", () => {
    const json = JSON.stringify({
      qaRoot: "docs/qa/2026-06-10",
      scenarios: [
        { Scenario: "capability-scoring-evidence-ingestion", Status: "PASS" },
        { Scenario: "release-and-rollback", Status: "BLOCKED" },
      ],
    });

    const inventory = parseProductWorkflowEvidenceInventoryJson(json);
    expect(inventory.qaRoot).toBe("docs/qa/2026-06-10");
    expect(inventory.scenarios).toHaveLength(2);

    const records = productWorkflowInventoryJsonToCapabilityEvidence(json);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "qa",
        status: "passed",
        evidenceRef: "docs/qa/2026-06-10#capability-scoring-evidence-ingestion",
      }),
    ]));
  });

  it("rejects malformed product workflow JSON inventory", () => {
    expect(() => parseProductWorkflowEvidenceInventoryJson("[]")).toThrow("must be an object");
    expect(() => parseProductWorkflowEvidenceInventoryJson("{}")).toThrow("must include a scenarios array");
  });
});

function record(
  toolName: string,
  status: ToolCallAuditRecord["status"],
): ToolCallAuditRecord {
  return {
    id: `${toolName}-${status}`,
    taskId: "task-1",
    toolName,
    permissionLevel: "read",
    status,
    inputSummary: "fixture",
  };
}
