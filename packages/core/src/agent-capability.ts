/**
 * Agent Capability Model
 *
 * Bridges the gap between ModelProfile.capabilities, ProviderAdapter.capabilities,
 * and Agent model requirements. Provides capability-based agent dispatch instead
 * of hardcoded step.id switches or agentKind routing.
 *
 * This module is pure data — no I/O, no Tauri, no ModelProvider.
 */

import type { Agent } from "./index";
import type { PermissionLevel } from "@javis/tools";
import { initialToolDescriptors } from "@javis/tools";

// ── Capability Tags ──────────────────────────────────────────────────────────

/** Concrete skills each agent can fulfill. Commander outputs these per step. */
export type AgentCapabilityTag =
  | "planning"
  | "synthesis"
  | "file_scan"
  | "file_execute"
  | "document_classify"
  | "shell_readonly"
  | "git_inspect"
  | "git_stage"
  | "git_commit"
  | "git_pr_create"
  | "git_pr_comment"
  | "code_search"
  | "code_trace"
  | "code_propose"
  | "code_apply"
  | "language_review"
  | "security_review"
  | "build_fix"
  | "test_run"
  | "doc_update"
  | "code_explore"
  | "performance_analysis"
  | "refactor"
  | "web_search"
  | "web_fetch"
  | "trend_fetch"
  | "memory_search"
  | "local_search"
  | "image_scan"
  | "directory_list"
  | "schedule_create"
  | "evidence_check"
  | "browser_navigate"
  | "browser_interact"
  | "browser_test"
  | "workspace_list"
  | "workspace_scaffold"
  | "workspace_create"
  | "workspace_delete"
  | "image_analyze"
  | "image_describe"
  | "image_ocr"
  | "clarification"
  | "desktop_screenshot"
  | "desktop_list_windows"
  | "desktop_ui_tree"
  | "desktop_focus"
  | "desktop_ui_input"
  | "desktop_input";

/** All valid capability tags — single source of truth for validation. */
export const ALL_CAPABILITY_TAGS: ReadonlyArray<AgentCapabilityTag> = [
  "planning", "synthesis", "file_scan", "file_execute", "document_classify",
  "shell_readonly", "git_inspect", "git_stage", "git_commit", "git_pr_create", "git_pr_comment", "code_search", "code_trace", "code_propose", "code_apply",
  "language_review", "security_review", "build_fix", "test_run", "doc_update", "code_explore", "performance_analysis", "refactor",
  "web_search", "web_fetch", "trend_fetch", "memory_search", "local_search", "image_scan", "directory_list",
  "schedule_create", "evidence_check",
  "browser_navigate", "browser_interact", "browser_test",
  "workspace_list", "workspace_scaffold", "workspace_create", "workspace_delete",
  "image_analyze", "image_describe", "image_ocr",
  "clarification",
  "desktop_screenshot", "desktop_list_windows", "desktop_ui_tree",
  "desktop_focus", "desktop_ui_input", "desktop_input",
];

/** Check whether a string is a valid capability tag. */
export function isValidCapabilityTag(value: string): value is AgentCapabilityTag {
  return (ALL_CAPABILITY_TAGS as ReadonlyArray<string>).includes(value);
}

// ── Model Requirements ──────────────────────────────────────────────────────

/** What kind of model capability an agent needs from its assigned model. */
export interface ModelRequirements {
  /** Agent needs a model that supports image/vision inputs */
  prefersVision: boolean;
  /** Agent needs a code-capable model (e.g. for diff analysis, patch generation) */
  prefersCode: boolean;
  /** Minimum context window tokens (0 = any size is acceptable) */
  minContextTokens: number;
}

// ── Agent Registration ──────────────────────────────────────────────────────

/** Wraps a core Agent with capability metadata for dispatch and model selection. */
export interface AgentRegistration {
  /** The underlying Agent definition */
  readonly agent: Readonly<Agent>;
  /** Concrete capability tags this agent fulfills */
  readonly capabilityTags: ReadonlyArray<AgentCapabilityTag>;
  /** What kind of model/context this agent needs */
  readonly modelRequirements: Readonly<ModelRequirements>;
}

export interface AgentCapabilityVerificationInput {
  readonly qaPassedAgentKinds?: ReadonlyArray<string>;
  readonly qaPassedCapabilityTags?: ReadonlyArray<AgentCapabilityTag>;
  readonly liveVerifiedAgentKinds?: ReadonlyArray<string>;
  readonly liveVerifiedCapabilityTags?: ReadonlyArray<AgentCapabilityTag>;
  readonly recentFailureRateByAgentKind?: Readonly<Record<string, number>>;
  readonly recentFailureRateByCapabilityTag?: Readonly<Partial<Record<AgentCapabilityTag, number>>>;
  readonly evidenceRefsByAgentKind?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly evidenceRefsByCapabilityTag?: Readonly<Partial<Record<AgentCapabilityTag, ReadonlyArray<string>>>>;
}

export interface AgentCapabilityScore {
  readonly agentKind: string;
  readonly score: number;
  readonly status: "ready" | "usable" | "partial" | "limited";
  readonly implemented: boolean;
  readonly permissionReady: boolean;
  readonly qaPassed: boolean;
  readonly liveVerified: boolean;
  readonly recentFailureRate: number;
  readonly highestPermissionLevel: PermissionLevel;
  readonly capabilityTags: ReadonlyArray<AgentCapabilityTag>;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
}

export interface AgentCapabilityEvidenceRecord {
  readonly kind: "qa" | "live";
  readonly status: "passed" | "failed" | "blocked" | "skipped";
  readonly agentKind?: string;
  readonly capabilityTags?: ReadonlyArray<AgentCapabilityTag>;
  readonly evidenceRef?: string;
}

export interface AgentCapabilityToolSignal {
  readonly toolName: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "blocked";
}

export interface AgentRepairPriority {
  readonly agentKind: string;
  readonly priority: "critical" | "high" | "medium" | "low";
  readonly score: number;
  readonly reasons: ReadonlyArray<string>;
  readonly nextEvidence: ReadonlyArray<string>;
  readonly capabilityTags: ReadonlyArray<AgentCapabilityTag>;
  readonly evidenceRefs: ReadonlyArray<string>;
}

// ── Agent Registry ──────────────────────────────────────────────────────────

export interface AgentRegistry {
  /** List all registered agents with capability metadata */
  list(): ReadonlyArray<AgentRegistration>;
  /** Find the first agent whose capabilityTags include ALL requested tags */
  findByCapabilities(tags: ReadonlyArray<AgentCapabilityTag>): AgentRegistration | undefined;
  /** Find by agent kind string (backward compat) */
  findByKind(kind: string): AgentRegistration | undefined;
  /** Get model requirements for an agent kind */
  getModelRequirements(kind: string): ModelRequirements | undefined;
  /** Register a new agent or replace an existing one with the same id. */
  register(agent: Agent): void;
  /** Remove an agent by id. No-op if not found. */
  unregister(agentId: string): void;
}

// ── Registry Implementation ─────────────────────────────────────────────────

export function createAgentRegistry(agents: ReadonlyArray<Agent>): AgentRegistry {
  // Each agent's capability tags are derived from its allowedToolNames.
  // This mapping is pure — no I/O, no external data.
  const registrations: AgentRegistration[] = agents.map((agent) => ({
    agent,
    capabilityTags: inferCapabilityTags(agent),
    modelRequirements: agent.modelRequirements ?? DEFAULT_MODEL_REQUIREMENTS,
  }));

  const byKind = new Map<string, AgentRegistration>();
  const byId = new Map<string, AgentRegistration>();
  for (const reg of registrations) {
    byKind.set(reg.agent.kind, reg);
    byId.set(reg.agent.id, reg);
  }

  return {
    list() {
      return registrations;
    },

    findByCapabilities(tags) {
      if (tags.length === 0) return undefined;
      return registrations.find((reg) =>
        tags.every((tag) => reg.capabilityTags.includes(tag)),
      );
    },

    findByKind(kind) {
      return byKind.get(kind);
    },

    getModelRequirements(kind) {
      return byKind.get(kind)?.modelRequirements;
    },

    register(agent) {
      // Remove existing registration with same id if present
      const existingIdx = registrations.findIndex((r) => r.agent.id === agent.id);
      if (existingIdx >= 0) {
        const removed = registrations[existingIdx];
        byKind.delete(removed.agent.kind);
        byId.delete(removed.agent.id);
        registrations.splice(existingIdx, 1);
      }
      const reg: AgentRegistration = {
        agent,
        capabilityTags: inferCapabilityTags(agent),
        modelRequirements: agent.modelRequirements ?? DEFAULT_MODEL_REQUIREMENTS,
      };
      registrations.push(reg);
      byKind.set(agent.kind, reg);
      byId.set(agent.id, reg);
    },

    unregister(agentId) {
      const idx = registrations.findIndex((r) => r.agent.id === agentId);
      if (idx < 0) return;
      const removed = registrations[idx];
      byKind.delete(removed.agent.kind);
      byId.delete(removed.agent.id);
      registrations.splice(idx, 1);
    },
  };
}

export function scoreAgentCapability(
  registration: AgentRegistration,
  verification: AgentCapabilityVerificationInput = {},
): AgentCapabilityScore {
  const toolDescriptors = registration.agent.allowedToolNames.map((toolName) => ({
    toolName,
    descriptor: getToolDescriptor(toolName),
  }));
  const missingTools = toolDescriptors
    .filter(({ descriptor }) => !descriptor)
    .map(({ toolName }) => toolName);
  const highestPermissionLevel = getHighestPermissionLevel(
    toolDescriptors.map(({ descriptor }) => descriptor?.permissionLevel ?? "dangerous"),
  );
  const implemented = registration.capabilityTags.length > 0 && missingTools.length === 0;
  const permissionReady = missingTools.length === 0 && highestPermissionLevel !== "dangerous";
  const qaPassed = hasVerificationSignal(
    registration,
    verification.qaPassedAgentKinds,
    verification.qaPassedCapabilityTags,
  );
  const liveVerified = hasVerificationSignal(
    registration,
    verification.liveVerifiedAgentKinds,
    verification.liveVerifiedCapabilityTags,
  );
  const recentFailureRate = getRecentFailureRate(registration, verification);
  const evidenceRefs = getCapabilityEvidenceRefs(registration, verification);

  let score = 0;
  if (implemented) score += 40;
  if (permissionReady) score += 25;
  if (qaPassed) score += 25;
  if (liveVerified) score += 10;
  score = Math.max(0, score - recentFailurePenalty(recentFailureRate));

  const gaps: string[] = [];
  if (!implemented) {
    gaps.push(
      missingTools.length > 0
        ? `missing descriptors: ${missingTools.join(", ")}`
        : "no capability tags inferred",
    );
  }
  if (!permissionReady) {
    gaps.push(
      highestPermissionLevel === "dangerous"
        ? "dangerous permission level still needs a product guard"
        : "permission metadata is incomplete",
    );
  }
  if (!qaPassed) gaps.push("product QA evidence is not marked as passed");
  if (!liveVerified) gaps.push("live workflow verification is not marked as passed");
  if (recentFailureRate >= 0.2) {
    gaps.push(`recent tool failure rate is ${(recentFailureRate * 100).toFixed(0)}%`);
  }

  return {
    agentKind: registration.agent.kind,
    score,
    status: getCapabilityScoreStatus(score, liveVerified),
    implemented,
    permissionReady,
    qaPassed,
    liveVerified,
    recentFailureRate,
    highestPermissionLevel,
    capabilityTags: registration.capabilityTags,
    evidenceRefs,
    gaps,
  };
}

export function scoreAgentCapabilities(
  registry: AgentRegistry,
  verification: AgentCapabilityVerificationInput = {},
): ReadonlyArray<AgentCapabilityScore> {
  return registry.list().map((registration) =>
    scoreAgentCapability(registration, verification),
  );
}

export function rankAgentRepairPriorities(
  scores: ReadonlyArray<AgentCapabilityScore>,
): ReadonlyArray<AgentRepairPriority> {
  return scores
    .map(agentScoreToRepairPriority)
    .filter((priority) => priority.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.agentKind.localeCompare(b.agentKind),
    );
}

export function deriveAgentCapabilityVerificationInput(
  evidenceRecords: ReadonlyArray<AgentCapabilityEvidenceRecord>,
  toolSignals: ReadonlyArray<AgentCapabilityToolSignal> = [],
): AgentCapabilityVerificationInput {
  const qaPassedAgentKinds = new Set<string>();
  const qaPassedCapabilityTags = new Set<AgentCapabilityTag>();
  const liveVerifiedAgentKinds = new Set<string>();
  const liveVerifiedCapabilityTags = new Set<AgentCapabilityTag>();
  const evidenceRefsByAgentKind: Record<string, string[]> = {};
  const evidenceRefsByCapabilityTag: Partial<Record<AgentCapabilityTag, string[]>> = {};

  for (const record of evidenceRecords) {
    if (record.status !== "passed") continue;
    const agentSet = record.kind === "qa" ? qaPassedAgentKinds : liveVerifiedAgentKinds;
    const capabilitySet = record.kind === "qa" ? qaPassedCapabilityTags : liveVerifiedCapabilityTags;
    if (record.agentKind) {
      agentSet.add(record.agentKind);
      appendEvidenceRef(evidenceRefsByAgentKind, record.agentKind, record.evidenceRef);
    }
    for (const tag of record.capabilityTags ?? []) {
      capabilitySet.add(tag);
      appendEvidenceRef(evidenceRefsByCapabilityTag, tag, record.evidenceRef);
    }
  }

  const recentFailureRateByAgentKind: Record<string, number> = {};
  const recentFailureRateByCapabilityTag: Partial<Record<AgentCapabilityTag, number>> = {};
  const agentStats: Record<string, { total: number; failed: number }> = {};
  const capabilityStats: Partial<Record<AgentCapabilityTag, { total: number; failed: number }>> = {};
  for (const signal of toolSignals) {
    const descriptor = getToolDescriptor(signal.toolName);
    if (!descriptor) continue;
    const failed = signal.status === "failed" || signal.status === "blocked";
    for (const agentKind of descriptor.ownerAgentKinds) {
      const stats = agentStats[agentKind] ?? { total: 0, failed: 0 };
      stats.total += 1;
      if (failed) stats.failed += 1;
      agentStats[agentKind] = stats;
    }
    for (const tag of descriptor.capabilityTags.filter(isValidCapabilityTag)) {
      const stats = capabilityStats[tag] ?? { total: 0, failed: 0 };
      stats.total += 1;
      if (failed) stats.failed += 1;
      capabilityStats[tag] = stats;
    }
  }
  for (const [agentKind, stats] of Object.entries(agentStats)) {
    recentFailureRateByAgentKind[agentKind] = stats.total > 0 ? stats.failed / stats.total : 0;
  }
  for (const [tag, stats] of Object.entries(capabilityStats) as Array<[AgentCapabilityTag, { total: number; failed: number }]>) {
    recentFailureRateByCapabilityTag[tag] = stats.total > 0 ? stats.failed / stats.total : 0;
  }

  return {
    qaPassedAgentKinds: [...qaPassedAgentKinds],
    qaPassedCapabilityTags: [...qaPassedCapabilityTags],
    liveVerifiedAgentKinds: [...liveVerifiedAgentKinds],
    liveVerifiedCapabilityTags: [...liveVerifiedCapabilityTags],
    recentFailureRateByAgentKind,
    recentFailureRateByCapabilityTag,
    evidenceRefsByAgentKind,
    evidenceRefsByCapabilityTag,
  };
}

// ── Capability Tag Inference ─────────────────────────────────────────────────

/** Default model requirements used when an agent has none declared. */
const DEFAULT_MODEL_REQUIREMENTS: ModelRequirements = {
  prefersVision: false,
  prefersCode: false,
  minContextTokens: 0,
};

/**
 * Derive capability tags from an agent's allowedToolNames.
 *
 * Tags are resolved from ToolDescriptor.capabilityTags — the single source
 * of truth is `initialToolDescriptors` in @javis/tools.
 *
 * Agent-kind-based tags are used for role-level capabilities whose execution
 * is a policy/prompt specialization over existing tools.
 */
let _toolCapabilityIndex: Map<string, string[]> | undefined;

function getToolCapabilityIndex(): Map<string, string[]> {
  if (!_toolCapabilityIndex) {
    _toolCapabilityIndex = new Map(
      initialToolDescriptors.map((d) => [d.name, d.capabilityTags]),
    );
  }
  return _toolCapabilityIndex;
}

function getToolCapabilityTags(toolName: string): string[] {
  return getToolCapabilityIndex().get(toolName) ?? [];
}

function getToolDescriptor(toolName: string) {
  return initialToolDescriptors.find((descriptor) => descriptor.name === toolName);
}

const PERMISSION_LEVEL_RANK: Record<PermissionLevel, number> = {
  read: 0,
  preview: 1,
  confirmed_write: 2,
  dangerous: 3,
};

function getHighestPermissionLevel(levels: ReadonlyArray<PermissionLevel>): PermissionLevel {
  return levels.reduce<PermissionLevel>((highest, level) =>
    PERMISSION_LEVEL_RANK[level] > PERMISSION_LEVEL_RANK[highest] ? level : highest,
  "read");
}

function hasVerificationSignal(
  registration: AgentRegistration,
  agentKinds: ReadonlyArray<string> | undefined,
  capabilityTags: ReadonlyArray<AgentCapabilityTag> | undefined,
): boolean {
  return Boolean(
    agentKinds?.includes(registration.agent.kind) ||
    capabilityTags?.some((tag) => registration.capabilityTags.includes(tag)),
  );
}

function getRecentFailureRate(
  registration: AgentRegistration,
  verification: AgentCapabilityVerificationInput,
): number {
  const rates = [
    verification.recentFailureRateByAgentKind?.[registration.agent.kind] ?? 0,
    ...registration.capabilityTags.map((tag) =>
      verification.recentFailureRateByCapabilityTag?.[tag] ?? 0,
    ),
  ];
  return clampRate(Math.max(...rates));
}

function getCapabilityEvidenceRefs(
  registration: AgentRegistration,
  verification: AgentCapabilityVerificationInput,
): string[] {
  return uniqueStrings([
    ...(verification.evidenceRefsByAgentKind?.[registration.agent.kind] ?? []),
    ...registration.capabilityTags.flatMap((tag) =>
      verification.evidenceRefsByCapabilityTag?.[tag] ?? [],
    ),
  ]);
}

function recentFailurePenalty(rate: number): number {
  if (rate >= 0.5) return 20;
  if (rate >= 0.2) return 10;
  if (rate > 0) return 5;
  return 0;
}

function agentScoreToRepairPriority(score: AgentCapabilityScore): AgentRepairPriority {
  const reasons: string[] = [];
  const nextEvidence: string[] = [];
  let priorityScore = 0;

  if (!score.implemented) {
    priorityScore += 100;
    reasons.push("implementation is missing or tool descriptors are incomplete");
    nextEvidence.push("source test proving the agent has descriptors for every allowed tool");
  }
  if (!score.permissionReady) {
    priorityScore += 90;
    reasons.push("permission readiness is incomplete for one or more tools");
    nextEvidence.push("approval or permission contract evidence for the highest-risk tool");
  }
  if (!score.liveVerified) {
    priorityScore += 50;
    reasons.push("live workflow verification is missing or blocked");
    nextEvidence.push("dated packaged/live workflow output with artifact references");
  }
  if (!score.qaPassed) {
    priorityScore += 40;
    reasons.push("product QA evidence is missing or blocked");
    nextEvidence.push("dated product QA output that marks the relevant capability as pass");
  }
  if (score.recentFailureRate >= 0.5) {
    priorityScore += 35;
    reasons.push(`recent tool failure rate is ${(score.recentFailureRate * 100).toFixed(0)}%`);
    nextEvidence.push("recent tool-call audit sample showing the failure rate is reduced");
  } else if (score.recentFailureRate >= 0.2) {
    priorityScore += 20;
    reasons.push(`recent tool failure rate is ${(score.recentFailureRate * 100).toFixed(0)}%`);
    nextEvidence.push("recent tool-call audit sample showing the failure rate is reduced");
  } else if (score.recentFailureRate > 0) {
    priorityScore += 10;
    reasons.push(`recent tool failure rate is ${(score.recentFailureRate * 100).toFixed(0)}%`);
  }
  if (score.highestPermissionLevel === "dangerous") {
    priorityScore += 15;
    reasons.push("highest permission level is dangerous");
    nextEvidence.push("explicit safety review for dangerous tool exposure");
  } else if (score.highestPermissionLevel === "confirmed_write") {
    priorityScore += 10;
    reasons.push("highest permission level requires confirmed writes");
  }

  return {
    agentKind: score.agentKind,
    priority: priorityLabel(priorityScore),
    score: priorityScore,
    reasons: uniqueStrings([...reasons, ...score.gaps]),
    nextEvidence: uniqueStrings(nextEvidence),
    capabilityTags: score.capabilityTags,
    evidenceRefs: score.evidenceRefs,
  };
}

function priorityLabel(score: number): AgentRepairPriority["priority"] {
  if (score >= 120) return "critical";
  if (score >= 80) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function priorityRank(priority: AgentRepairPriority["priority"]): number {
  switch (priority) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
  }
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function appendEvidenceRef<T extends string>(
  target: Partial<Record<T, string[]>>,
  key: T,
  ref: string | undefined,
): void {
  if (!ref) return;
  target[key] = uniqueStrings([...(target[key] ?? []), ref]);
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function getCapabilityScoreStatus(score: number, liveVerified: boolean): AgentCapabilityScore["status"] {
  if (score >= 85 && liveVerified) return "ready";
  if (score >= 65) return "usable";
  if (score >= 40) return "partial";
  return "limited";
}

function inferCapabilityTags(agent: Agent): AgentCapabilityTag[] {
  const tags = new Set<AgentCapabilityTag>();

  for (const toolName of agent.allowedToolNames) {
    for (const tag of getToolCapabilityTags(toolName)) {
      tags.add(tag as AgentCapabilityTag);
    }
  }

  // Research additionally gets synthesis capability
  if (agent.kind === "research") {
    tags.add("synthesis");
  }
  if (agent.kind === "language-reviewer") {
    tags.add("language_review");
  }
  if (agent.kind === "security-reviewer") {
    tags.add("security_review");
  }
  if (agent.kind === "build-fix") {
    tags.add("build_fix");
  }
  if (agent.kind === "test-runner") {
    tags.add("test_run");
  }
  if (agent.kind === "doc-updater") {
    tags.add("doc_update");
  }
  if (agent.kind === "explorer") {
    tags.add("code_explore");
  }
  if (agent.kind === "perf-analyzer") {
    tags.add("performance_analysis");
  }
  if (agent.kind === "refactor") {
    tags.add("refactor");
  }

  return [...tags];
}
