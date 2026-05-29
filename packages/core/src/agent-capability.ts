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

// ── Capability Tags ──────────────────────────────────────────────────────────

/** Concrete skills each agent can fulfill. Commander outputs these per step. */
export type AgentCapabilityTag =
  | "planning"           // Decompose user goals into workflow steps
  | "synthesis"          // Merge evidence into user-facing conclusions
  | "file_scan"          // Scan markdown/user documents (read-only)
  | "document_classify"  // Classify documents by type/purpose
  | "shell_readonly"     // Run allowlisted read-only shell commands
  | "git_inspect"        // Inspect git status, diff, changed files
  | "code_propose"       // Propose code edits/patch from diff analysis
  | "code_apply"         // Apply confirmed patches to workspace
  | "web_search"         // Search public web sources
  | "web_fetch"          // Fetch and extract public web page content
  | "local_search"       // Search indexed local files by metadata
  | "directory_list"     // List local directories
  | "schedule_create"    // Create durable local scheduled tasks
  | "schedule_update"    // Update existing scheduled tasks
  | "schedule_delete"    // Delete scheduled tasks
  | "evidence_check"     // Check collected evidence against success criteria
  | "language_review";   // Review output for language naturalness

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

// ── Capability Tag Inference ─────────────────────────────────────────────────

/** Default model requirements used when an agent has none declared. */
const DEFAULT_MODEL_REQUIREMENTS: ModelRequirements = {
  prefersVision: false,
  prefersCode: false,
  minContextTokens: 0,
};

/**
 * Derive capability tags from an agent's allowedToolNames.
 * This is a pure function — same input always produces the same output.
 *
 * Tags are intentionally derived from tool names rather than agent kind
 * because tool names are the contract ("what can this agent actually do").
 */
function inferCapabilityTags(agent: Agent): AgentCapabilityTag[] {
  const tags = new Set<AgentCapabilityTag>();
  const tools = agent.allowedToolNames;

  // Commander always gets planning + synthesis
  if (agent.kind === "commander") {
    tags.add("planning");
    tags.add("synthesis");
  }

  for (const tool of tools) {
    switch (tool) {
      case "commander.plan":
        tags.add("planning");
        break;
      case "file.scanMarkdownDocuments":
      case "file.scanUserDocuments":
        tags.add("file_scan");
        break;
      case "file.classifyDocuments":
        tags.add("document_classify");
        break;
      case "shell.runReadOnlyCommand":
        tags.add("shell_readonly");
        break;
      case "code.inspectRepository":
        tags.add("git_inspect");
        break;
      case "code.proposeEdit":
        tags.add("code_propose");
        break;
      case "code.applyProposedEdit":
        tags.add("code_apply");
        break;
      case "web.search":
        tags.add("web_search");
        break;
      case "web.fetchSource":
        tags.add("web_fetch");
        break;
      case "file.listDirectory":
        tags.add("directory_list");
        break;
      case "computer.openPath":
      case "file.scanUserImages":
        tags.add("local_search");
        break;
      case "scheduler.createTask":
        tags.add("schedule_create");
        break;
      case "scheduler.updateTask":
        tags.add("schedule_update");
        break;
      case "scheduler.deleteTask":
        tags.add("schedule_delete");
        break;
      case "verifier.check":
        tags.add("evidence_check");
        break;
    }
  }

  // Chinese reviewer has no tools but gets language_review by kind
  if (agent.kind === "chinese-reviewer") {
    tags.add("language_review");
  }

  // Research agent additionally gets synthesis capability
  if (agent.kind === "research") {
    tags.add("synthesis");
  }

  // Verifier additionally gets planning capability (verifies plans)
  if (agent.kind === "verifier") {
    tags.add("planning");
  }

  return [...tags];
}
