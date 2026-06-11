import {
  deriveAgentCapabilityVerificationInput,
  isValidCapabilityTag,
  type AgentCapabilityEvidenceRecord,
  type AgentCapabilityTag,
  type AgentCapabilityToolSignal,
  type AgentCapabilityVerificationInput,
} from "@javis/core";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export function buildRuntimeCapabilityVerification(input: {
  toolAuditRecords?: ReadonlyArray<ToolCallAuditRecord>;
  productWorkflowScenarios?: ReadonlyArray<ProductWorkflowEvidenceScenario>;
  productWorkflowEvidenceRef?: string;
  maxToolSignals?: number;
}): AgentCapabilityVerificationInput {
  const maxToolSignals = clampMaxToolSignals(input.maxToolSignals);
  const toolSignals = (input.toolAuditRecords ?? [])
    .slice(-maxToolSignals)
    .map(toolAuditRecordToCapabilitySignal)
    .filter((signal): signal is AgentCapabilityToolSignal => Boolean(signal));
  return deriveAgentCapabilityVerificationInput(
    productWorkflowScenariosToCapabilityEvidence(
      input.productWorkflowScenarios ?? [],
      input.productWorkflowEvidenceRef,
    ),
    toolSignals,
  );
}

export interface ProductWorkflowEvidenceScenario {
  Scenario?: string;
  scenario?: string;
  Status?: string;
  status?: string;
}

export interface ProductWorkflowEvidenceInventory {
  qaRoot?: string;
  scenarios: ProductWorkflowEvidenceScenario[];
}

const PRODUCT_WORKFLOW_CAPABILITY_TAGS: Record<string, AgentCapabilityTag[]> = {
  "search-backed-research": ["web_search", "web_fetch", "synthesis"],
  "code-agent-fixture": ["code_propose", "code_apply"],
  "code-agent-live-provider": ["code_propose", "code_apply"],
  "repo-intelligence-package-live": ["code_search", "code_trace"],
  "trend-hot-list-live": ["trend_fetch", "synthesis"],
  "git-remote-pr-writes": ["git_inspect", "git_stage", "git_commit", "git_pr_create", "git_pr_comment"],
  "browser-terminal-approvals": ["browser_interact", "browser_test", "desktop_input"],
  "task-history-persistence": ["memory_search"],
  "agent-memory-embedding-provider-live": ["memory_search"],
  "capability-scoring-evidence-ingestion": ["planning", "evidence_check"],
};

const PRODUCT_WORKFLOW_LIVE_SCENARIOS = new Set([
  "code-agent-live-provider",
  "repo-intelligence-package-live",
  "trend-hot-list-live",
  "git-remote-pr-writes",
  "browser-terminal-approvals",
  "agent-memory-embedding-provider-live",
  "capability-scoring-evidence-ingestion",
]);

export function productWorkflowScenariosToCapabilityEvidence(
  scenarios: ReadonlyArray<ProductWorkflowEvidenceScenario>,
  evidenceRef?: string,
): AgentCapabilityEvidenceRecord[] {
  const records: AgentCapabilityEvidenceRecord[] = [];
  for (const scenario of scenarios) {
    const id = normalizeScenarioId(scenario.Scenario ?? scenario.scenario);
    const status = normalizeScenarioStatus(scenario.Status ?? scenario.status);
    const capabilityTags = (PRODUCT_WORKFLOW_CAPABILITY_TAGS[id] ?? [])
      .filter(isValidCapabilityTag);
    if (!id || !status || capabilityTags.length === 0) continue;
    const ref = evidenceRef ? `${evidenceRef}#${id}` : id;
    records.push({
      kind: "qa",
      status,
      capabilityTags,
      evidenceRef: ref,
    });
    if (PRODUCT_WORKFLOW_LIVE_SCENARIOS.has(id)) {
      records.push({
        kind: "live",
        status,
        capabilityTags,
        evidenceRef: ref,
      });
    }
  }
  return records;
}

export function parseProductWorkflowEvidenceInventoryJson(
  value: string,
): ProductWorkflowEvidenceInventory {
  const parsed = JSON.parse(value) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Product workflow evidence JSON must be an object.");
  }
  const scenarios = parsed.scenarios;
  if (!Array.isArray(scenarios)) {
    throw new Error("Product workflow evidence JSON must include a scenarios array.");
  }
  return {
    qaRoot: typeof parsed.qaRoot === "string" ? parsed.qaRoot : undefined,
    scenarios: scenarios
      .filter(isPlainObject)
      .map((scenario) => ({
        Scenario: typeof scenario.Scenario === "string" ? scenario.Scenario : undefined,
        scenario: typeof scenario.scenario === "string" ? scenario.scenario : undefined,
        Status: typeof scenario.Status === "string" ? scenario.Status : undefined,
        status: typeof scenario.status === "string" ? scenario.status : undefined,
      })),
  };
}

export function productWorkflowInventoryJsonToCapabilityEvidence(
  value: string,
  evidenceRef?: string,
): AgentCapabilityEvidenceRecord[] {
  const inventory = parseProductWorkflowEvidenceInventoryJson(value);
  return productWorkflowScenariosToCapabilityEvidence(
    inventory.scenarios,
    evidenceRef ?? inventory.qaRoot,
  );
}

export function toolAuditRecordToCapabilitySignal(
  record: ToolCallAuditRecord,
): AgentCapabilityToolSignal | null {
  switch (record.status) {
    case "succeeded":
      return { toolName: record.toolName, status: "succeeded" };
    case "failed":
      return { toolName: record.toolName, status: "failed" };
    case "denied":
    case "cancelled":
      return { toolName: record.toolName, status: "cancelled" };
    default:
      return null;
  }
}

function clampMaxToolSignals(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 200;
  return Math.max(1, Math.min(1_000, Math.trunc(value)));
}

function normalizeScenarioId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScenarioStatus(value: unknown): AgentCapabilityEvidenceRecord["status"] | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toUpperCase()) {
    case "PASS":
      return "passed";
    case "FAIL":
      return "failed";
    case "BLOCKED":
      return "blocked";
    default:
      return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
