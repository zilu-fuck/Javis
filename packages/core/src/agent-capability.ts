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
import { initialToolDescriptors } from "@javis/tools";

// ── Capability Tags ──────────────────────────────────────────────────────────

/** Concrete skills each agent can fulfill. Commander outputs these per step. */
export type AgentCapabilityTag =
  | "planning"           // Decompose user goals into workflow steps
  | "synthesis"          // Merge evidence into user-facing conclusions
  | "file_scan"          // Scan markdown/user documents (read-only)
  | "file_execute"       // Execute confirmed file organization (write)
  | "document_classify"  // Classify documents by type/purpose
  | "shell_readonly"     // Run allowlisted read-only shell commands
  | "git_inspect"        // Inspect git status, diff, changed files
  | "code_propose"       // Propose code edits/patch from diff analysis
  | "code_apply"         // Apply confirmed patches to workspace
  | "web_search"         // Search public web sources
  | "web_fetch"          // Fetch and extract public web page content
  | "local_search"       // Search indexed local files by metadata
  | "image_scan"         // Scan user image files
  | "directory_list"     // List local directories
  | "schedule_create"    // Create durable local scheduled tasks
  | "schedule_update"    // Update existing scheduled tasks
  | "schedule_delete"    // Delete scheduled tasks
  | "evidence_check"     // Check collected evidence against success criteria
  | "language_review"    // Review output for language naturalness
  | "browser_navigate"   // Navigate to URLs, extract content, take screenshots
  | "browser_interact"   // Click, type, evaluate in page context
  | "browser_test"       // Run Playwright test scripts
  | "workspace_list"     // List installed workspace definitions
  | "workspace_scaffold" // Generate workspace definition from description
  | "workspace_create"   // Save a new workspace definition
  | "workspace_delete"  // Remove a workspace definition
  | "image_analyze"     // Analyze image content and answer visual questions
  | "image_describe"    // Generate textual description of an image
  | "image_ocr"         // Extract text from images via OCR
  | "clarification"     // Ask user for clarification when goals are ambiguous
  | "desktop_screenshot"    // Capture desktop/window screenshots
  | "desktop_list_windows"  // Enumerate OS windows
  | "desktop_focus"         // Focus/foreground a window
  | "desktop_input";        // Inject mouse/keyboard input events

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
 *
 * Tags are resolved from ToolDescriptor.capabilityTags — the single source
 * of truth is `initialToolDescriptors` in @javis/tools.
 *
 * Agent-kind-based tags are only used for agents without tools
 * (Chinese Reviewer) or for cross-cutting capabilities (Research's synthesis).
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

function inferCapabilityTags(agent: Agent): AgentCapabilityTag[] {
  const tags = new Set<AgentCapabilityTag>();

  for (const toolName of agent.allowedToolNames) {
    for (const tag of getToolCapabilityTags(toolName)) {
      tags.add(tag as AgentCapabilityTag);
    }
  }

  // Agents with no tools that still need capability tags
  if (agent.kind === "chinese-reviewer") {
    tags.add("language_review");
  }
  if (agent.kind === "research") {
    tags.add("synthesis");
  }

  return [...tags];
}
